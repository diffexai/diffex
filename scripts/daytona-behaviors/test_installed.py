"""Fast report/normalization/budget regression tests; installed integration is a separate command."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET

SPEC = importlib.util.spec_from_file_location("installed", Path(__file__).with_name("installed.py"))
installed = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installed)


class InstalledTests(unittest.TestCase):
    def runner(self, output, artifacts=None):
        return installed.Runner(argparse.Namespace(output=Path(output), commit="a" * 40,
            mode="deterministic", executable=None, artifacts=artifacts, model="openai/gpt-4.1-mini", update_baselines=False))

    def test_failed_assertion_is_recorded_once_and_not_retried(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.runner(temporary)
            calls = []
            def fail(evidence):
                calls.append(evidence)
                raise AssertionError("intentional assertion failure")
            self.assertFalse(runner.scenario("fixture-failure", fail))
            self.assertEqual(len(calls), 1)
            report = json.loads((Path(temporary) / "results.json").read_text())
            self.assertEqual(report["outcome"], "failed")
            self.assertEqual(report["scenarios"][0]["category"], "product")
            self.assertEqual(ET.parse(Path(temporary) / "results.xml").getroot().attrib["failures"], "1")

    def test_corrupt_artifact_fails_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "cli.tgz"
            archive.write_bytes(b"tampered")
            installed.write_json(root / "manifest.json", {"source": {"commit": "a" * 40}, "packages": [
                {"filename": "cli.tgz", "sha256": "0" * 64}]})
            runner = self.runner(root / "output", root)
            self.assertFalse(runner.run())
            self.assertEqual([s["id"] for s in runner.results], ["artifact-integrity"])
            self.assertIn("checksum", runner.results[0]["error"])

    def test_global_validator_timeout_terminates_group_gracefully_then_forces_and_reaps(self):
        for expirations in (0, 1, 2):
            with self.subTest(expirations=expirations):
                process = Mock(pid=12345, returncode=0)
                process.communicate.side_effect = [installed.subprocess.TimeoutExpired("fixture", 630)] * expirations + [("output", "diagnostics")]
                with patch.object(installed.subprocess, "Popen", return_value=process) as spawn, \
                     patch.object(installed.os, "killpg") as kill:
                    result = installed.run_global_installation(["node", "fixture.mjs"])
                self.assertEqual(result.returncode, 124 if expirations else 0)
                self.assertEqual((result.stdout, result.stderr), ("output", "diagnostics"))
                self.assertTrue(spawn.call_args.kwargs["start_new_session"])
                self.assertEqual([call.args[1] for call in kill.call_args_list],
                    [installed.signal.SIGTERM, installed.signal.SIGKILL][:expirations])
                self.assertEqual([call.kwargs["timeout"] for call in process.communicate.call_args_list],
                    [630] + [10] * expirations)

    def test_normal_npm_global_validation_and_local_script_policy_fail_closed(self):
        for fault in (None, "global-exit", "global-report", "global-cleanup", "global-identity", "global-script-policy", "global-entry-missing", "global-hook-execution", "global-hook-missing", "global-hook-version", "global-hook-failed", "npm-policy", "bun-policy"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                installed.write_json(root / "manifest.json", {
                    "source": {"commit": "a" * 40}, "packages": []})
                runner = self.runner(root / "output", root)
                calls = []

                def check_output(command, **kwargs):
                    return {"node": "v22.23.2", "npm": "11.16.0", "bun": "1.3.11"}.get(command[0], "fixture")

                def run(command, **kwargs):
                    calls.append(command)
                    if command[1].endswith("npm-global-install.mjs"):
                        self.assertEqual(command[2:4], [str(root), "a" * 40])
                        hooks = [
                            {"packageId": "@google/genai@2.31.0", "hook": "preinstall", "exitCode": 0, "signal": None},
                            {"packageId": "protobufjs@7.6.6" if fault == "global-hook-version" else "protobufjs@7.6.5",
                             "hook": "postinstall", "exitCode": 23 if fault == "global-hook-failed" else 0, "signal": None},
                        ]
                        entries = [{"kind": kind, "status": "passed", "scripts": "enabled",
                            "ignoreScripts": "true" if fault == "global-script-policy" else "false",
                            "coldCache": True, "installedInventory": "passed",
                            "lifecycleExecution": "unchecked" if fault == "global-hook-execution" else "passed",
                            "lifecycleHooks": hooks[:1] if fault == "global-hook-missing" else hooks}
                            for kind in ("candidate", "public")]
                        installed.write_json(Path(command[4]) / "npm-global-installation.json", {
                            "schemaVersion": 1, "sourceCommit": ("b" if fault == "global-identity" else "a") * 40,
                            "publicCommand": "npm i -g @diffexai/diffex",
                            "entries": entries[:1] if fault == "global-entry-missing" else entries,
                            "status": "failed" if fault == "global-report" else "passed",
                            "cleanup": fault != "global-cleanup"})
                        return installed.subprocess.CompletedProcess(command,
                            1 if fault == "global-exit" else 0, "global install output", "")
                    self.assertTrue(command[1].endswith("install.mjs"))
                    self.assertEqual(kwargs["timeout"], 615, "Outer deadline must allow inner npm timeout and group teardown")
                    manager = command[4]
                    policy = "enabled" if manager == "npm" else "disabled"
                    if fault == manager + "-policy":
                        policy = "disabled" if manager == "npm" else "enabled"
                    installed.write_json(Path(command[3]) / "installation.json", {
                        "manager": manager, "lifecycleScripts": policy})
                    return installed.subprocess.CompletedProcess(command, 0, "local install output", "")

                with patch.object(installed.subprocess, "check_output", check_output), \
                     patch.object(installed.subprocess, "run", run), \
                     patch.object(installed, "run_global_installation", run), \
                     patch.object(installed.Runner, "deterministic"):
                    self.assertEqual(runner.run(), fault is None)
                self.assertEqual(len([c for c in calls if c[1].endswith("npm-global-install.mjs")]), 1)
                global_result = next(r for r in runner.results if r["id"] == "npm-global-installation")
                self.assertEqual(global_result["outcome"], "failed" if fault and fault.startswith("global-") else "passed")
                for manager in ("npm", "bun"):
                    result = next(r for r in runner.results if r["id"] == manager + "-package-integrity")
                    self.assertEqual(result["outcome"], "failed" if fault == manager + "-policy" else "passed")
                self.assertEqual((root / "output/npm-global-installation/install.txt").read_text(), "global install output")

    def test_provider_and_configuration_failures_are_distinct(self):
        for status, category in ((400, "configuration"), (401, "configuration"), (404, "configuration"), (429, "provider"), (503, "provider")):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                runner = self.runner(temporary)
                def fail(evidence):
                    (evidence / "events.jsonl").write_text(json.dumps({"type": "response", "status": status}) + "\n")
                    raise AssertionError("No response")
                self.assertFalse(runner.scenario("live", fail))
                self.assertEqual(runner.results[0]["category"], category)

    def test_transport_unavailability_is_provider_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.runner(temporary)
            def fail(evidence):
                (evidence / "events.jsonl").write_text(json.dumps({"type": "provider-error", "error": "TypeError"}) + "\n")
                raise AssertionError("No response")
            self.assertFalse(runner.scenario("live", fail))
            self.assertEqual(runner.results[0]["category"], "provider")

    def test_normalization_preserves_layout_and_behavior_text(self):
        env = {"HOME": "/tmp/home", "DIFFEX_PROJECT": "/tmp/project"}
        actual = installed.normalize_screen("Diffex v0.4.0\n  /tmp/project\nbehavior-tools-ok\n", env)
        self.assertEqual(actual, "Diffex v<VERSION>\n  <PROJECT>\nbehavior-tools-ok\n")

    def test_live_evidence_is_redacted_before_publication_and_excludes_auth(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"OPENAI_API_KEY": "test-secret-never-persist"}):
            root = Path(temporary)
            executable = root / "consumer/node_modules/.bin/diffex"
            executable.parent.mkdir(parents=True)
            evidence = root / "output"
            runner = self.runner(evidence)
            runner.args.mode = "live"
            runner.secrets = [os.environ["OPENAI_API_KEY"]]
            def action(env, work, fixture):
                (work / "events.jsonl").write_text(json.dumps({"type": "test", "content": os.environ["OPENAI_API_KEY"]}) + "\n")
                (work / "project/result.txt").write_text(os.environ["OPENAI_API_KEY"])
                (work / "project/auth.json").write_text("must not be copied")
            runner.behavior(str(executable), evidence, action)
            self.assertEqual((evidence / "project/result.txt").read_text(), "[REDACTED]")
            self.assertFalse((evidence / "project/auth.json").exists())
            self.assertNotIn(os.environ["OPENAI_API_KEY"], (evidence / "events.jsonl").read_text())

    def test_terminal_key_is_never_in_command_arguments_or_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Path(temporary)
            commands = []
            def command(terminal, *args):
                commands.append(args)
                return "test-secret-never-persist" if args[0] == "capture-pane" else ""
            env = {"HOME": temporary, "OPENAI_API_KEY": "test-secret-never-persist"}
            with patch.object(installed.Terminal, "command", command):
                terminal = installed.Terminal("/installed/diffex", [], env, evidence, evidence, 100)
                terminal.capture()
            self.assertNotIn(env["OPENAI_API_KEY"], str(commands))
            self.assertEqual((evidence / "terminal.txt").read_text(), "[REDACTED]")

    def test_terminal_waits_for_independent_status_after_dead_pane(self):
        with tempfile.TemporaryDirectory() as temporary:
            terminal = object.__new__(installed.Terminal)
            terminal.evidence = Path(temporary)
            terminal.deadline = float("inf")
            captures = []
            def capture():
                captures.append(True)
                if len(captures) == 2:
                    installed.write_json(terminal.evidence / "terminal-exit.json", {"exitCode": 0})
                return ""
            terminal.send = lambda text: None
            terminal.capture = capture
            terminal.command = lambda *args: "1"
            with patch.object(installed.time, "sleep"):
                terminal.exit()
            self.assertEqual(len(captures), 2)

    def test_terminal_rejects_nonzero_and_signaled_exit(self):
        for status in (7, -15):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as temporary:
                terminal = object.__new__(installed.Terminal)
                terminal.evidence = Path(temporary)
                installed.write_json(terminal.evidence / "terminal-exit.json", {"exitCode": status})
                terminal.deadline = float("inf")
                terminal.send = lambda text: None
                terminal.capture = lambda: ""
                terminal.command = lambda *args: "1"
                with self.assertRaisesRegex(AssertionError, "Unclean terminal exit"):
                    terminal.exit()

    def test_empty_results_cannot_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.runner(temporary)
            runner.save()
            self.assertEqual(json.loads((Path(temporary) / "results.json").read_text())["outcome"], "failed")


if __name__ == "__main__":
    unittest.main()
