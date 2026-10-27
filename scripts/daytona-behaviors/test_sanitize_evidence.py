"""Offline publication-guard regressions; all credentials below are synthetic."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from sanitize_evidence import REPORT, local_path, sanitize


DAYTONA = "synthetic-daytona-secret-123456789"
OPENAI = "synthetic-openai-secret-987654321"
SCRIPT = Path(__file__).with_name("sanitize_evidence.py")


class SanitizeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "raw"
        self.root.mkdir()
        self.output = self.base / "safe"
        self.environment = patch.dict(os.environ, {"DAYTONA_API_KEY": DAYTONA, "OPENAI_API_KEY": OPENAI})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def report(self):
        return json.loads((self.output / REPORT).read_text())

    def assert_no_secret(self):
        for path in self.output.rglob("*"):
            self.assertNotIn(DAYTONA, str(path))
            self.assertNotIn(OPENAI, str(path))
            if path.is_file():
                self.assertNotIn(DAYTONA.encode(), path.read_bytes())
                self.assertNotIn(OPENAI.encode(), path.read_bytes())

    def invoke(self, mode="live"):
        github_output = self.base / "github-output"
        environment = {**os.environ, "GITHUB_OUTPUT": str(github_output)}
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
                                 "--output", str(self.output), "--mode", mode],
                                env=environment, capture_output=True, check=False)
        # Neither status nor exception diagnostics may echo exact secret values.
        for key in [DAYTONA, OPENAI]:
            self.assertNotIn(key.encode(), result.stdout + result.stderr + github_output.read_bytes())
        return result, github_output.read_text().splitlines()

    def test_clean_preserves_hidden_digest_members_and_safe_hashes(self):
        (self.root / ".orchestration-exit").write_bytes(b"0\n")
        (self.root / "state.json").write_text('{"run_id": "safe-run"}')
        result, outputs = self.invoke()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(outputs, ["safe_to_upload=false", "safe_to_upload=true"])
        self.assertEqual((self.output / ".orchestration-exit").read_bytes(), b"0\n")
        report = self.report()
        self.assertTrue(report["safe_to_upload"])
        self.assertEqual(report["outcome"], "clean")
        self.assertEqual(report["credential_matches"], 0)
        self.assertEqual(report["files_scanned"], 2)
        for record in report["files"]:
            data = (self.output / record["path"]).read_bytes()
            self.assertEqual(record["sha256"], hashlib.sha256(data).hexdigest())
            self.assertEqual(record["size"], len(data))
        self.assert_no_secret()

    def test_exact_credentials_in_every_raw_log_and_binary_are_redacted_and_fail(self):
        nested = self.root / "evidence" / "nested"
        nested.mkdir(parents=True)
        for directory in [self.root, nested]:
            for name in ["installed.log", "launcher.log", "install.txt", "capture.bin"]:
                (directory / name).write_bytes(b"\x00before " + DAYTONA.encode() + b" " + OPENAI.encode() + b" after\xff")
        result, outputs = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outputs[-1], "safe_to_upload=true")
        self.assertEqual(self.report()["credential_matches"], 16)
        self.assertEqual(self.report()["outcome"], "credential-found")
        self.assertEqual(self.report()["files_scanned"], 8)
        self.assertIn(b"[REDACTED]", (self.output / "installed.log").read_bytes())
        # Recovery input stays local and is never the upload path.
        self.assertIn(DAYTONA.encode(), (self.root / "installed.log").read_bytes())
        self.assert_no_secret()

    def test_nested_auth_files_directories_and_symlinks_are_excluded_without_reading(self):
        nested = self.root / "evidence" / "nested"
        nested.mkdir(parents=True)
        auth_names = ["auth.json", "Auth.Other.json", ".npmrc", ".netrc", ".env", ".env.local", "credentials.json"]
        for name in auth_names:
            (nested / name).write_text(DAYTONA + OPENAI)
        (nested / ".ssh").mkdir()
        (nested / ".ssh" / "id_rsa").write_text(DAYTONA)
        (nested / "normal.txt").write_text("retained")
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text(DAYTONA)
        (nested / "linked-directory").symlink_to(outside, target_is_directory=True)
        (nested / "linked-file").symlink_to(outside / "private.txt")
        (nested / "dangling").symlink_to(self.base / "missing")
        original_open = os.open

        def checked_open(path, *args, **kwargs):
            self.assertIn(Path(path).name, {"raw", "evidence", "nested", "normal.txt"}, "Excluded file was opened")
            return original_open(path, *args, **kwargs)

        # tempfile also opens a file during mkdtemp only on first use, already initialized.
        with patch("sanitize_evidence.os.open", side_effect=checked_open):
            self.assertTrue(sanitize(self.root, self.output, "live"))
        self.assertEqual(self.report()["excluded_count"], len(auth_names) + 4)
        self.assertEqual(self.report()["files_scanned"], 1)
        self.assertFalse(any(path.is_symlink() for path in self.output.rglob("*")))
        self.assertEqual((self.output / "evidence/nested/normal.txt").read_text(), "retained")
        self.assert_no_secret()

    def test_secret_path_names_are_redacted_in_files_and_metadata(self):
        directory = self.root / DAYTONA
        directory.mkdir()
        (directory / (OPENAI + ".txt")).write_text("safe")
        result, outputs = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outputs[-1], "safe_to_upload=true")
        self.assertEqual(self.report()["credential_matches"], 2)
        self.assert_no_secret()

    def test_unexpected_scan_failure_blocks_upload_and_prints_no_raw_exception(self):
        (self.root / REPORT).write_text(DAYTONA)
        result, outputs = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outputs, ["safe_to_upload=false"])
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob(".publication-*")))
        self.assertNotIn(b"Traceback", result.stderr)

    def test_missing_credential_blocks_upload(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": ""}):
            result, outputs = self.invoke()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(outputs, ["safe_to_upload=false"])
        self.assertFalse(self.output.exists())

    def test_deterministic_reads_only_daytona_while_live_reads_both_whitelisted_keys(self):
        class WhitelistedEnvironment(dict):
            def get(self, key, default=None):
                self.assert_key(key)
                return super().get(key, default)

            def __getitem__(self, key):
                self.assert_key(key)
                return super().__getitem__(key)

            @staticmethod
            def assert_key(key):
                if key != "DAYTONA_API_KEY":
                    raise AssertionError("non-whitelisted credential access")

        (self.root / "capture.txt").write_text(OPENAI)
        with patch("sanitize_evidence.os.environ", WhitelistedEnvironment(DAYTONA_API_KEY=DAYTONA)):
            self.assertTrue(sanitize(self.root, self.output, "deterministic"))
        self.assertEqual(self.report()["credential_names"], ["DAYTONA_API_KEY"])
        self.assertEqual((self.output / "capture.txt").read_text(), OPENAI)

    def test_local_scope_accepts_canonical_workspace_home_and_temp_descendants(self):
        with patch("sanitize_evidence.os.getcwd", return_value=str(self.base / "workspace")), \
                patch("sanitize_evidence.pwd.getpwuid") as owner, \
                patch("sanitize_evidence.tempfile.gettempdir", return_value=str(self.base / "temp")):
            owner.return_value.pw_dir = str(self.base / "home")
            for root in ["workspace", "home", "temp"]:
                path = self.base / root / "evidence" / "nested"
                self.assertEqual(local_path(path), path)
            with self.assertRaises(ValueError):
                local_path(Path("/etc/diffex-publication"))

    @unittest.skipUnless(sys.platform == "darwin", "Darwin OS user temp boundary")
    def test_native_user_temp_evidence_survives_isolated_tmpdir_and_cwd(self):
        consumer = self.base / "npm/process acceptance"
        isolated_temp = consumer / "temp"
        isolated_temp.mkdir(parents=True)
        with patch.dict(os.environ, {"TMPDIR": str(isolated_temp)}), \
                patch("sanitize_evidence.tempfile.tempdir", None), \
                patch("sanitize_evidence.os.getcwd", return_value=str(consumer)), \
                patch("sanitize_evidence.pwd.getpwuid") as owner:
            owner.return_value.pw_dir = "/unrelated-owner-home"
            self.assertEqual(tempfile.gettempdir(), str(isolated_temp))
            self.assertTrue(sanitize(self.root, self.output, "live"))
        self.assertTrue(self.report()["safe_to_upload"])

    def test_traversal_rejected_before_filesystem_access_even_when_it_lands_inside_scope(self):
        for path in [self.base / "nested/../safe", Path("../safe"), self.root / "../raw"]:
            with self.subTest(path=path), patch("sanitize_evidence.os.path.realpath") as resolve:
                with self.assertRaises(ValueError):
                    local_path(path)
                resolve.assert_not_called()

    def test_ancestor_symlinks_and_dangling_publication_links_fail_closed(self):
        outside = self.base / "outside"
        outside.mkdir()
        linked = self.base / "linked"
        linked.symlink_to(outside, target_is_directory=True)
        for destination in [linked / "safe", self.base / "dangling"]:
            if destination.name == "dangling":
                destination.symlink_to(self.base / "missing")
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                sanitize(self.root, destination, "live")
        (outside / "raw").mkdir()
        with self.assertRaises(ValueError):
            sanitize(linked / "raw", self.output, "live")
        self.assertFalse((outside / "safe").exists())
        self.assertFalse(self.output.exists())

    def test_overlapping_output_scopes_fail_closed(self):
        for destination in [self.root, self.root / "published", self.base]:
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                sanitize(self.root, destination, "live")
        self.assertFalse((self.root / "published").exists())

    def test_scope_prefix_sibling_is_not_an_ancestor(self):
        with patch("sanitize_evidence.os.getcwd", return_value="/scoped"), \
                patch("sanitize_evidence.pwd.getpwuid") as owner, \
                patch("sanitize_evidence.tempfile.gettempdir", return_value="/system-temp"):
            owner.return_value.pw_dir = "/owner-home"
            for path in ["/scoped-foreign/log", "/owner-home-foreign/log", "/system-temp-foreign/log"]:
                with self.subTest(path=path), self.assertRaises(ValueError):
                    local_path(Path(path))

    def test_os_temp_alias_is_allowed_but_user_directory_links_are_not(self):
        actual = self.base / "actual-temp"
        actual.mkdir()
        alias = self.base / "system-temp"
        alias.symlink_to(actual, target_is_directory=True)
        with patch("sanitize_evidence.tempfile.gettempdir", return_value=str(alias)):
            self.assertEqual(local_path(alias / "output"), actual / "output")
            (actual / "redirect").symlink_to(self.root, target_is_directory=True)
            with self.assertRaises(ValueError):
                local_path(alias / "redirect" / "output")

    def test_child_directory_swap_cannot_redirect_evidence_reads(self):
        nested = self.root / "nested"
        nested.mkdir()
        (nested / "visible.txt").write_text("original")
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "private.txt").write_text("must not be published")
        original_open = os.open

        def swapped_open(path, *args, **kwargs):
            if path == "nested":
                nested.rename(self.root / "original")
                nested.symlink_to(outside, target_is_directory=True)
            return original_open(path, *args, **kwargs)

        with patch("sanitize_evidence.os.open", side_effect=swapped_open):
            with self.assertRaises(OSError):
                sanitize(self.root, self.output, "live")
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob(".publication-*")))

    def test_invalid_workflow_output_symlink_blocks_upload_without_touching_target(self):
        target = self.base / "private"
        target.write_text("unchanged")
        github_output = self.base / "github-output"
        github_output.symlink_to(target)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(github_output)}):
            result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
                                     "--output", str(self.output), "--mode", "live"],
                                    capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertFalse(self.output.exists())
        self.assertNotIn(b"Traceback", result.stderr)

    def test_workflow_output_hardlink_cannot_append_outside_selected_path(self):
        target = self.base / "private"
        target.write_text("unchanged")
        github_output = self.base / "github-output"
        os.link(target, github_output)
        with patch.dict(os.environ, {"GITHUB_OUTPUT": str(github_output)}):
            result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
                                     "--output", str(self.output), "--mode", "live"],
                                    capture_output=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertFalse(self.output.exists())

    def test_unknown_api_mode_cannot_skip_live_credential_scan(self):
        with self.assertRaises(ValueError):
            sanitize(self.root, self.output, "LIVE")
        self.assertFalse(self.output.exists())

    def test_existing_destination_and_symlink_root_fail_closed(self):
        self.output.mkdir()
        with self.assertRaises(ValueError):
            sanitize(self.root, self.output, "live")
        self.output.rmdir()
        linked = self.base / "linked"
        linked.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            sanitize(linked, self.output, "live")
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
