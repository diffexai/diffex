"""Fast report/normalization/budget regression tests; installed integration is a separate command."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
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
