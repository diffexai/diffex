"""Offline trust-boundary and PTY-flow regressions; no installed/live provider calls."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("artifact_terminal", Path(__file__).with_name("verify-candidate-artifacts.py"))
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


class VerifyCandidateArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.consumer = self.base / "consumer with spaces"
        self.package = self.consumer / "node_modules/@diffexai/diffex"
        self.package.mkdir(parents=True)
        self.metadata = self.package / "package.json"
        self.metadata.write_text(json.dumps({"name": "@diffexai/diffex", "bin": {"diffex": "dist/cli.js"}}))
        self.cli = self.package / "dist/cli.js"
        self.cli.parent.mkdir()
        self.cli.write_text("#!/usr/bin/env node\n// Synthetic installed package; never executed.\n")
        self.cli.chmod(0o755)
        self.executable = self.consumer / "node_modules/.bin/diffex"
        self.executable.parent.mkdir()
        self.executable.symlink_to("../@diffexai/diffex/dist/cli.js")
        self.output = self.base / "evidence"

    def test_installed_package_bin_is_validated_without_limiting_consumer_to_output_roots(self):
        # Installed executables are explicitly selected, not restricted to cwd,
        # HOME or temp. The output-root helper must not govern consumer lookup.
        with patch.object(verifier, "local_path", side_effect=AssertionError("output-only guard")):
            self.assertEqual(verifier.installed_executable(self.executable), (str(self.cli), self.consumer))

    def test_consumer_symlink_and_parent_traversal_are_rejected(self):
        linked = self.base / "linked-consumer"
        linked.symlink_to(self.consumer, target_is_directory=True)
        for executable in [linked / "node_modules/.bin/diffex", self.consumer / "nested/../node_modules/.bin/diffex"]:
            with self.subTest(executable=executable), self.assertRaises(ValueError):
                verifier.installed_executable(executable)

    def test_os_temp_alias_consumer_remains_supported(self):
        alias = self.base / "system-temp"
        alias.symlink_to(self.base, target_is_directory=True)
        with patch.object(verifier.tempfile, "gettempdir", return_value=str(alias)):
            selected = alias / self.consumer.name / "node_modules/.bin/diffex"
            self.assertEqual(verifier.installed_executable(selected), (str(self.cli), self.consumer))

    def test_foreign_package_and_bin_mapping_mismatch_are_rejected(self):
        for metadata in [
            {"name": "foreign", "bin": {"diffex": "dist/cli.js"}},
            {"name": "@diffexai/diffex", "bin": {"diffex": "../foreign.js"}},
            {"name": "@diffexai/diffex", "bin": "dist/cli.js"},
        ]:
            with self.subTest(metadata=metadata):
                self.metadata.write_text(json.dumps(metadata))
                with self.assertRaises(ValueError):
                    verifier.installed_executable(self.executable)

    def test_bin_link_cannot_escape_to_foreign_consumer_or_prefix_sibling(self):
        for outside in [self.base / "foreign", Path(str(self.consumer) + "-foreign")]:
            outside.mkdir()
            foreign = outside / "cli.js"
            foreign.write_text("not the selected package")
            self.executable.unlink()
            self.executable.symlink_to(foreign)
            with self.subTest(outside=outside), self.assertRaises(ValueError):
                verifier.installed_executable(self.executable)

    def test_linked_package_metadata_or_package_directory_is_rejected(self):
        foreign = self.base / "foreign.json"
        foreign.write_bytes(self.metadata.read_bytes())
        self.metadata.unlink()
        self.metadata.symlink_to(foreign)
        with self.assertRaises(OSError):
            verifier.installed_executable(self.executable)
        self.metadata.unlink()
        self.metadata.write_bytes(foreign.read_bytes())
        moved = self.base / "moved-package"
        self.package.rename(moved)
        self.package.symlink_to(moved, target_is_directory=True)
        with self.assertRaises(ValueError):
            verifier.installed_executable(self.executable)

    def test_cli_target_must_be_expected_regular_executable(self):
        self.cli.chmod(0o644)
        with self.assertRaises(ValueError):
            verifier.installed_executable(self.executable)
        self.cli.unlink()
        self.cli.mkdir()
        with self.assertRaises(ValueError):
            verifier.installed_executable(self.executable)

    def test_output_root_scope_checks_precede_creating_directories_or_running_commands(self):
        redirect = self.base / "redirect"
        redirect.symlink_to(self.consumer, target_is_directory=True)
        for out in ["/etc/diffex-evidence", self.base / "nested/../evidence", redirect / "evidence"]:
            with self.subTest(out=out), patch.object(verifier.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    verifier.verify(out, {"local": str(self.executable)})
                run.assert_not_called()
        self.assertFalse((self.consumer / "evidence").exists())

    def test_output_root_prefix_siblings_and_noncanonical_links_are_rejected(self):
        with patch.object(verifier.os, "getcwd", return_value="/scoped"), \
                patch.object(verifier.pwd, "getpwuid") as owner, \
                patch.object(verifier.tempfile, "gettempdir", return_value="/system-temp"):
            owner.return_value.pw_dir = "/owner-home"
            for value in ["/scoped-foreign/out", "/owner-home-foreign/out", "/system-temp-foreign/out"]:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    verifier.local_path(value)

    @unittest.skipUnless(sys.platform == "darwin", "Darwin OS user temp boundary")
    def test_native_user_temp_sibling_output_survives_isolated_tmpdir_and_cwd(self):
        consumer = self.base / "npm/process acceptance"
        isolated_temp = consumer / "temp"
        isolated_temp.mkdir(parents=True)
        output = self.base / "npm/terminal"
        with patch.dict(os.environ, {"TMPDIR": str(isolated_temp)}), \
                patch.object(verifier.tempfile, "tempdir", None), \
                patch.object(verifier.os, "getcwd", return_value=str(consumer)), \
                patch.object(verifier.pwd, "getpwuid") as owner:
            owner.return_value.pw_dir = "/unrelated-owner-home"
            self.assertEqual(verifier.tempfile.gettempdir(), str(isolated_temp))
            self.assertEqual(verifier.local_path(output), output)
            native_alias = Path(os.confstr(65537)) / output.relative_to(Path(os.confstr(65537)).resolve())
            self.assertEqual(verifier.local_path(native_alias), output)
            self.assertEqual(verifier.installed_executable(self.executable), (str(self.cli), self.consumer))

    def test_native_temp_discovery_rejects_other_owner_and_nonprivate_directories(self):
        native = self.base / "native-user-temp"
        native.mkdir(mode=0o700)
        actual = native.stat()
        for uid, mode in [(os.getuid() + 1, 0o40700), (os.getuid(), 0o40777), (os.getuid(), 0o100600)]:
            metadata = os.stat_result((mode, actual.st_ino, actual.st_dev, actual.st_nlink,
                                       uid, actual.st_gid, actual.st_size,
                                       actual.st_atime, actual.st_mtime, actual.st_ctime))
            with self.subTest(uid=uid, mode=oct(mode)), \
                    patch.object(verifier.sys, "platform", "darwin"), \
                    patch.object(verifier.os, "confstr", return_value=str(native)), \
                    patch.object(verifier.os, "stat", return_value=metadata):
                with self.assertRaisesRegex(ValueError, "owner-private"):
                    verifier.system_temp_roots()

    def test_runtime_names_cannot_escape_output_directory(self):
        for runtime in ["../other", "/absolute", "local/subdir", ""]:
            with self.subTest(runtime=runtime), self.assertRaises(ValueError):
                verifier.verify(self.output, {runtime: str(self.executable)})
        self.assertFalse(self.output.exists())

    def test_atomic_evidence_write_rejects_symlinks_and_does_not_truncate_hardlinks(self):
        self.output.mkdir()
        private = self.base / "private"
        private.write_text("unchanged")
        target = self.output / "smoke.json"
        target.symlink_to(private)
        with self.assertRaises(ValueError):
            verifier.write_evidence(self.output, "smoke.json", "new")
        self.assertEqual(private.read_text(), "unchanged")
        target.unlink()
        os.link(private, target)
        verifier.write_evidence(self.output, "smoke.json", "new")
        self.assertEqual(private.read_text(), "unchanged")
        self.assertEqual(target.read_text(), "new")
        self.assertFalse(list(self.output.glob(".artifact-evidence-*")))

    def test_verified_package_uses_literal_node_lookup_and_actual_cli_in_child(self):
        class ChildExec(Exception):
            pass

        def run(args, **kwargs):
            stdout = "fixture handoff-fixture-ok"
            return subprocess.CompletedProcess(args, 0, stdout, "")

        with patch.object(verifier.shutil, "which", return_value="/trusted/node") as which, \
                patch.object(verifier.subprocess, "run", side_effect=run) as processes, \
                patch.object(verifier.pty, "fork", return_value=(0, 98765)), \
                patch.object(verifier.os, "chdir"), patch.object(verifier.fcntl, "ioctl"), \
                patch.object(verifier.os, "execve", side_effect=ChildExec) as execute:
            with self.assertRaises(ChildExec):
                verifier.verify(self.output, {"local": str(self.executable)})
        which.assert_called_once_with("node")
        program, args, env = execute.call_args.args
        self.assertEqual(program, "/trusted/node")
        self.assertEqual(args[:2], ["/trusted/node", str(self.cli)])
        self.assertEqual(args[-2:], ["--model", "handoff/fixture"])
        for process in processes.call_args_list:
            self.assertEqual(process.args[0][:2], ["/trusted/node", str(self.cli)])
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("DAYTONA_API_KEY", env)
        self.assertFalse(list(self.consumer.glob("artifact-fixture-*.mjs")))
        self.assertFalse(Path(env["HOME"]).parent.exists())

    def test_missing_node_fails_before_process_execution(self):
        with patch.object(verifier.shutil, "which", return_value=None), \
                patch.object(verifier.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "Node interpreter"):
                verifier.verify(self.output, {"local": str(self.executable)})
            run.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_terminal_flow_keeps_prompt_both_login_menus_search_back_and_exit(self):
        roots = []

        def run(args, **kwargs):
            root = Path(kwargs["env"]["HOME"]).parent
            roots.append(root)
            events = [{"type": "inference"}, {"type": "inference"},
                      {"type": "request", "url": "https://api.diffex.ai/api/latest-version"}]
            (root / "events.jsonl").write_text("\n".join(json.dumps(event) for event in events))
            return subprocess.CompletedProcess(args, 0, "fixture handoff-fixture-ok", "")

        chunks = iter([b"Diffex v0.0.0", b"handoff-fixture-ok", b"Select authentication method:",
                       b"ChatGPT OpenRouter xAI", b"No matching providers", b"Select authentication method:",
                       b"Select provider to configure:", b"No matching providers", b"Select authentication method:",
                       b"Select authentication method:", b"Ask Diffex", b""])
        original_close = os.close
        with patch.object(verifier.subprocess, "run", side_effect=run), \
                patch.object(verifier.shutil, "which", return_value="/trusted/node"), \
                patch.object(verifier.pty, "fork", return_value=(12345, 98765)), \
                patch.object(verifier.select, "select", return_value=([98765], [], [])), \
                patch.object(verifier.os, "read", side_effect=lambda *args: next(chunks)), \
                patch.object(verifier.os, "write") as send, \
                patch.object(verifier.os, "waitpid", return_value=(12345, 0)), \
                patch.object(verifier.os, "close", side_effect=lambda fd: None if fd == 98765 else original_close(fd)), \
                patch("builtins.print"):
            results = verifier.verify(self.output, {"local": str(self.executable)})
        self.assertEqual([call.args[1] for call in send.call_args_list],
                         [b"Reply with the fixture confirmation.\r", b"/login\r", b"\r", b"radius", b"\x03",
                          b"\x1b[B\r", b"radius", b"\x03", b"\x03", b"/exit\r"])
        self.assertEqual(len(results), 6)
        self.assertEqual(results[-1]["accounts"], ["ChatGPT", "OpenRouter", "xAI"])
        self.assertEqual(json.loads((self.output / "smoke.json").read_text()), results)
        self.assertTrue((self.output / "local-terminal.txt").is_file())
        self.assertTrue(all(not root.exists() for root in roots))
        self.assertFalse(list(self.consumer.glob("artifact-fixture-*.mjs")))


if __name__ == "__main__":
    unittest.main()
