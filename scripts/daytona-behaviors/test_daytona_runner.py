"""Credential-free tests: python -m unittest discover -s scripts/daytona-behaviors -p 'test_daytona_runner.py'."""
from __future__ import annotations

from dataclasses import asdict
import hashlib
import io
import json
import os
from pathlib import Path
import signal
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

from daytona import DaytonaError, DaytonaNotFoundError, ExecuteResponse
from daytona_api_client import SnapshotState

from daytona_runner import (
    EXTRACT_SCRIPT, INSTALLED, MANIFEST_SCRIPT, REMOTE_EVIDENCE, RESOURCES,
    Runner, State, OrchestrationError, archive_directory, main, prepare_snapshot,
    sha256, termination_handlers, validate_archive,
)


class FakeFS:
    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.uploads: list[tuple[str, bytes]] = []
        self.downloads: list[str] = []
        self.corrupt = False
        self.corrupt_paths: set[str] = set()

    def upload_file(self, source: str | bytes, destination: str, timeout: int = 0):
        value = Path(source).read_bytes() if isinstance(source, str) else source
        self.files[destination] = value
        self.uploads.append((destination, value))

    def download_file_stream(self, source: str, timeout: int = 0):
        self.downloads.append(source)
        if not self.files[source]:
            raise DaytonaError("No file data received")
        content = self.files[source] + (b"changed" if self.corrupt or source in self.corrupt_paths else b"")
        yield content[:3]
        yield content[3:]


class FakeProcess:
    def __init__(self, fs: FakeFS, output: Path):
        self.fs = fs
        self.output = output
        self.calls: list[tuple[str, dict[str, str] | None]] = []
        self.product_outcome = "passed"
        self.exit_code = 0
        self.raise_on_launch: Exception | None = None
        self.signal_on_launch = False
        self.manifest_override: list[dict[str, object]] | None = None

    def exec(self, command: str, env: dict[str, str] | None = None, timeout: int = 0):
        self.calls.append((command, env))
        result = ""
        if command.startswith("python3 -c "):
            entries = []
            for path, value in sorted(self.fs.files.items()):
                if path.startswith(REMOTE_EVIDENCE + "/"):
                    entries.append({"path": path.removeprefix(REMOTE_EVIDENCE + "/"),
                                    "size": len(value), "sha256": hashlib.sha256(value).hexdigest()})
            result = json.dumps(self.manifest_override if self.manifest_override is not None else entries)
        if command.startswith("nohup "):
            if self.signal_on_launch:
                os.kill(os.getpid(), signal.SIGTERM)
            if self.raise_on_launch:
                raise self.raise_on_launch
            state = json.loads((self.output / "state.json").read_text())
            hashes = {"candidate.tgz": "a" * 64}
            scenario = {"id": "terminal", "commit": state["commit"], "artifactHashes": hashes,
                        "outcome": self.product_outcome, "category": "product", "evidence": ["terminal"]}
            suite = ET.Element("testsuite", name="installed", tests="1",
                               failures="0" if self.product_outcome == "passed" else "1")
            case = ET.SubElement(suite, "testcase", name="terminal", classname="product")
            if self.product_outcome != "passed":
                ET.SubElement(case, "failure", message="intentional failure")
            self.fs.files.update({
                REMOTE_EVIDENCE + "/results.json": json.dumps({"schemaVersion": 1,
                    "commit": state["commit"], "mode": state["mode"], "artifactHashes": hashes,
                    "outcome": self.product_outcome, "scenarios": [scenario]}).encode(),
                REMOTE_EVIDENCE + "/results.xml": ET.tostring(suite),
                REMOTE_EVIDENCE + "/.orchestration-exit.json": json.dumps({"exit_code": self.exit_code}).encode(),
                REMOTE_EVIDENCE + "/terminal/evidence.txt": b"terminal evidence\n",
            })
        return ExecuteResponse(exit_code=0, result=result)


class FakeSnapshot:
    def __init__(self):
        self.value = SimpleNamespace(name="toolchain", id="snapshot-id", state=SnapshotState.ACTIVE, cpu=2, mem=4, disk=8)
        self.params = None
        self.create_error: Exception | None = None

    def get(self, name: str):
        return self.value

    def create(self, params, timeout: int):
        self.params = params
        if self.create_error:
            raise self.create_error
        return self.value


class FakeClient:
    def __init__(self, output: Path):
        self.output = output
        self.snapshot = FakeSnapshot()
        self.fs = FakeFS()
        self.process = FakeProcess(self.fs, output)
        self.sandbox = SimpleNamespace(id="sandbox-id", name="", labels={},
                                       cpu=2, memory=4, disk=8, fs=self.fs, process=self.process)
        self.exists = False
        self.create_error: Exception | None = None
        self.create_accepted = True
        self.delete_error: Exception | None = None
        self.delete_removes = True
        self.read_error: Exception | None = None
        self.label_residue = False
        self.params = None
        self.creates = 0
        self.deletes = 0
        self.gets: list[str] = []
        self.lists = 0

    def create(self, params, timeout: int):
        self.creates += 1
        recorded = json.loads((self.output / "state.json").read_text())
        assert recorded["name"] == params.name
        assert recorded["labels"] == params.labels
        assert recorded["create_attempted"] is True
        assert recorded["sandbox_id"] is None
        self.params = params
        self.sandbox.name = params.name
        self.sandbox.labels = dict(params.labels)
        self.exists = self.create_accepted
        if self.create_error:
            raise self.create_error
        return self.sandbox

    def get(self, identifier: str, request_timeout: int):
        self.gets.append(identifier)
        if self.read_error:
            raise self.read_error
        if not self.exists:
            raise DaytonaNotFoundError("not found")
        return self.sandbox

    def delete(self, sandbox, timeout: int, wait: bool):
        assert wait is False
        self.deletes += 1
        if self.delete_removes:
            self.exists = False
        if self.delete_error:
            raise self.delete_error

    def list(self, query, request_timeout: int):
        self.lists += 1
        return iter([self.sandbox] if self.exists or self.label_residue else [])


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.output = root / "output"
        self.output.mkdir()
        self.artifacts = root / "artifacts"
        self.artifacts.mkdir()
        (self.artifacts / "release.json").write_text('{"commit":"abc"}')
        self.bundle = root / "bundle"
        (self.bundle / "scripts/daytona-behaviors").mkdir(parents=True)
        (self.bundle / "scripts/daytona-behaviors/installed.py").write_text("print('installed')")
        self.state = State("workflow-1", "unique-name", {"diffex-run": "unique-token"},
                           "a" * 40, "deterministic", "toolchain", time.time(), time.time() + 60)
        self.state.save(self.output)
        self.client = FakeClient(self.output)
        self.runner = Runner(self.client, self.output, self.state, poll_seconds=0)

    def test_end_to_end_fake_resources_ttl_record_before_create_and_reports(self):
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 0)
        params = self.client.params
        self.assertEqual(params.ttl_minutes, 45)
        self.assertEqual(params.auto_stop_interval, 0)
        self.assertEqual(params.auto_delete_interval, 0)
        self.assertFalse(params.public)
        self.assertIsNone(params.env_vars)
        self.assertIsNone(params.secrets)
        self.assertEqual(self.client.creates, 1)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertIn("sandbox-id", self.client.gets)
        self.assertIn("unique-name", self.client.gets)
        self.assertGreater(self.client.lists, 0)
        report = json.loads((self.output / "orchestration.json").read_text())
        self.assertEqual(report["outcome"], "passed")
        self.assertEqual(report["installed_outcome"], "passed")
        self.assertEqual(ET.parse(self.output / "orchestration.xml").getroot().attrib["failures"], "0")
        self.assertEqual((self.output / "evidence/terminal/evidence.txt").read_bytes(), b"terminal evidence\n")
        launch = self.client.fs.files["/tmp/diffex-launch.py"].decode()
        self.assertIn(INSTALLED, launch)
        self.assertIn("--artifacts", launch)
        self.assertNotIn("npm install", launch)
        self.assertEqual(len(self.state.inputs), 2)
        self.assertEqual(report["input_hashes"], self.state.inputs)
        self.assertEqual(report["category"], "daytona")
        verify_commands = [command for command, _ in self.client.process.calls
                           if command.startswith("python3 /tmp/diffex-extract.py ")]
        self.assertEqual(len(verify_commands), 1)
        for digest in self.state.inputs.values():
            self.assertIn(digest, verify_commands[0])

    def test_live_key_is_process_only_never_serialized_or_uploaded(self):
        self.state.mode = "live"
        secret = "live-secret-never-persist"
        with patch.dict(os.environ, {"DAYTONA_API_KEY": "daytona-secret", "OPENAI_API_KEY": secret}):
            self.assertEqual(self.runner.run(self.artifacts, self.bundle, secret), 0)
        envs = [env for command, env in self.client.process.calls if command.startswith("nohup ")]
        self.assertEqual(envs, [{"OPENAI_API_KEY": secret}])
        self.assertIsNone(self.client.params.env_vars)
        for path in self.output.rglob("*"):
            if path.is_file():
                self.assertNotIn(secret.encode(), path.read_bytes())
                self.assertNotIn(b"daytona-secret", path.read_bytes())
        for _, value in self.client.fs.uploads:
            self.assertNotIn(secret.encode(), value)
            self.assertNotIn(b"daytona-secret", value)

    def test_deterministic_ignores_even_supplied_key(self):
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, "must-not-forward"), 0)
        self.assertTrue(all(not env for _, env in self.client.process.calls))

    def test_ambiguous_create_found_deleted_without_replacement(self):
        self.client.create_error = TimeoutError("sensitive HTTP detail")
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.client.creates, 1)
        self.assertEqual(self.client.deletes, 1)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertEqual(self.state.sandbox_id, "sandbox-id")
        self.assertNotIn("sensitive HTTP detail", (self.output / "state.json").read_text())

    def test_ambiguous_create_not_visible_remains_unconfirmed(self):
        self.client.create_error = TimeoutError()
        self.client.create_accepted = False
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.state.cleanup, "unconfirmed")
        self.assertEqual(self.client.creates, 1)
        self.assertEqual(self.client.deletes, 0)
        self.assertEqual(self.runner.recover(0), 1)
        self.assertEqual(self.client.creates, 1)

    def test_delayed_ambiguous_create_recovered_by_saved_name(self):
        self.client.create_error = TimeoutError()
        self.client.create_accepted = False
        self.runner.run(self.artifacts, self.bundle, None)
        self.client.exists = True
        self.runner.recover(0)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertEqual(self.client.creates, 1)
        self.assertEqual(self.client.deletes, 1)

    def test_delete_success_is_not_confirmation(self):
        self.client.delete_removes = False
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.state.execution, "passed")
        self.assertEqual(self.state.cleanup, "unconfirmed")
        self.assertTrue(self.client.exists)

    def test_delete_timeout_still_independently_confirms(self):
        self.client.delete_error = TimeoutError()
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 0)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertTrue(any(error.startswith("delete-request") for error in self.state.errors))

    def test_lookup_outage_is_not_absence(self):
        self.runner.create()
        self.client.read_error = ConnectionError()
        self.runner.cleanup(attempts=1)
        self.assertEqual(self.state.cleanup, "unconfirmed")
        self.assertEqual(self.client.deletes, 0)

    def test_label_query_residue_blocks_confirmation(self):
        self.client.label_residue = True
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.state.cleanup, "unconfirmed")

    def test_ownership_mismatch_refuses_deletion(self):
        self.runner.create()
        self.client.sandbox.labels = {"diffex-run": "somebody-else"}
        self.runner.cleanup(attempts=1)
        self.assertEqual(self.client.deletes, 0)
        self.assertEqual(self.state.cleanup, "unconfirmed")

    def test_inactive_sdk_snapshot_state_never_creates(self):
        self.client.snapshot.value.state = SnapshotState.BUILDING
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.client.creates, 0)
        self.assertEqual(self.state.cleanup, "not-needed")

    def test_wrong_snapshot_resources_never_creates(self):
        self.client.snapshot.value.mem = 8
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.client.creates, 0)
        self.assertEqual(self.state.cleanup, "not-needed")

    def test_wrong_sandbox_resources_still_cleans_up(self):
        self.client.sandbox.disk = 16
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.client.deletes, 1)
        self.assertEqual(self.state.cleanup, "confirmed")

    def test_incremental_download_only_changed_files(self):
        self.client.fs.files[REMOTE_EVIDENCE + "/progress.json"] = b"one"
        self.runner.collect(self.client.sandbox)
        self.runner.collect(self.client.sandbox)
        self.assertEqual(len(self.client.fs.downloads), 1)
        self.client.fs.files[REMOTE_EVIDENCE + "/progress.json"] = b"two"
        self.runner.collect(self.client.sandbox)
        self.assertEqual(len(self.client.fs.downloads), 2)
        self.assertEqual((self.output / "evidence/progress.json").read_bytes(), b"two")

    def test_changed_during_download_keeps_last_good_copy(self):
        path = REMOTE_EVIDENCE + "/progress.json"
        self.client.fs.files[path] = b"one"
        self.runner.collect(self.client.sandbox)
        self.client.fs.files[path] = b"two"
        self.client.fs.corrupt = True
        self.runner.collect(self.client.sandbox)
        self.assertEqual((self.output / "evidence/progress.json").read_bytes(), b"one")
        self.assertFalse(list(self.output.rglob("*.download")))
        self.client.fs.corrupt = False
        self.runner.collect(self.client.sandbox)
        self.assertEqual((self.output / "evidence/progress.json").read_bytes(), b"two")

    def test_empty_evidence_is_materialized_without_sdk_download(self):
        remote = REMOTE_EVIDENCE + "/installed.log"
        self.client.fs.files[remote] = b""
        with self.assertRaisesRegex(DaytonaError, "No file data received"):
            list(self.client.fs.download_file_stream(remote))
        self.client.fs.downloads.clear()
        self.runner.collect(self.client.sandbox, final=True)
        self.assertEqual((self.output / "evidence/installed.log").read_bytes(), b"")
        self.assertEqual(self.state.evidence_manifest, {"installed.log": hashlib.sha256(b"").hexdigest()})
        self.assertEqual(self.client.fs.downloads, [])

    def test_empty_evidence_still_requires_correct_digest(self):
        self.client.process.manifest_override = [{"path": "empty.log", "size": 0, "sha256": "0" * 64}]
        with self.assertRaisesRegex(OrchestrationError, "checksum or size mismatch"):
            self.runner.collect(self.client.sandbox, final=True)
        self.assertIsNone(self.state.evidence_manifest)
        self.assertFalse((self.output / "evidence/empty.log").exists())
        self.assertFalse(self.client.fs.downloads)

    def test_corrupt_nonreport_download_prevents_success_and_still_cleans(self):
        self.client.fs.corrupt_paths.add(REMOTE_EVIDENCE + "/terminal/evidence.txt")
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(self.state.execution, "passed")
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertIsNone(self.state.evidence_manifest)
        report = json.loads((self.output / "orchestration.json").read_text())
        self.assertFalse(report["reports_complete"])
        self.assertTrue(any("final evidence checksum or size mismatch" in error for error in self.state.errors))

    def test_final_collection_rejects_stale_nonreport_copy(self):
        remote = REMOTE_EVIDENCE + "/progress.log"
        self.client.fs.files[remote] = b"old"
        self.runner.collect(self.client.sandbox)
        self.client.fs.files[remote] = b"new"
        self.client.fs.corrupt_paths.add(remote)
        with self.assertRaisesRegex(OrchestrationError, "checksum or size mismatch"):
            self.runner.collect(self.client.sandbox, final=True)
        self.assertEqual((self.output / "evidence/progress.log").read_bytes(), b"old")
        self.assertIsNone(self.state.evidence_manifest)

    def test_unsafe_manifest_path_is_rejected(self):
        self.client.process.manifest_override = [{"path": "../../escape", "size": 0, "sha256": "0" * 64}]
        with self.assertRaisesRegex(OrchestrationError, "unsafe"):
            self.runner.collect(self.client.sandbox)
        self.assertFalse(self.client.fs.downloads)

    def test_local_symlink_is_rejected(self):
        evidence = self.output / "evidence"
        evidence.mkdir()
        (evidence / "escape").symlink_to(self.artifacts, target_is_directory=True)
        self.client.fs.files[REMOTE_EVIDENCE + "/escape/file"] = b"secret"
        with self.assertRaisesRegex(OrchestrationError, "symlink"):
            self.runner.collect(self.client.sandbox)

    def test_launch_failure_still_cleans_and_reports(self):
        self.client.process.raise_on_launch = TimeoutError("might have launched")
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertTrue(self.state.launch_attempted)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertTrue((self.output / "orchestration.xml").exists())
        launches = sum(command.startswith("nohup ") for command, _ in self.client.process.calls)
        self.runner.recover(0)
        self.assertEqual(sum(command.startswith("nohup ") for command, _ in self.client.process.calls), launches)

    def test_sigterm_performs_cleanup_and_writes_failure(self):
        self.client.process.signal_on_launch = True
        previous = signal.getsignal(signal.SIGTERM)
        with termination_handlers():
            self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertEqual(self.client.deletes, 1)
        self.assertIn("signal 15", (self.output / "orchestration.json").read_text())

    def test_product_failure_is_not_hidden_by_successful_cleanup(self):
        self.client.process.product_outcome = "failed"
        self.client.process.exit_code = 1
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 1)
        report = json.loads((self.output / "orchestration.json").read_text())
        self.assertEqual(report["installed_outcome"], "failed")
        self.assertEqual(report["cleanup"], "confirmed")

    def test_missing_installed_reports_never_passes(self):
        self.runner.run(self.artifacts, self.bundle, None)
        (self.output / "evidence/results.xml").unlink()
        self.assertEqual(self.runner.report(), 1)

    def test_invalid_remote_junit_never_passes_recovery(self):
        sandbox = self.runner.create()
        self.runner.launch(sandbox, None)
        self.client.fs.files[REMOTE_EVIDENCE + "/results.xml"] = b"not XML"
        self.assertEqual(self.runner.recover(0), 1)
        self.assertEqual(self.state.cleanup, "confirmed")
        self.assertFalse(json.loads((self.output / "orchestration.json").read_text())["reports_complete"])
        self.assertTrue(any("ParseError" in error for error in self.state.errors))

    def test_junit_structure_must_match_json_inventory_and_outcomes(self):
        sandbox = self.runner.create()
        self.runner.launch(sandbox, None)
        self.runner.poll(sandbox, time.time() + 1)
        for xml in (
            b'<not-testsuite tests="1" failures="0"><testcase name="terminal"/></not-testsuite>',
            b'<testsuite tests="2" failures="0"><testcase name="terminal"/></testsuite>',
            b'<testsuite tests="1" failures="0"><testcase name="other"/></testsuite>',
            b'<testsuite tests="1" failures="0"><testcase name="terminal"><failure/></testcase></testsuite>',
            b'<testsuite tests="1" failures="0"><testcase name="terminal"><skipped/></testcase></testsuite>',
        ):
            with self.subTest(xml=xml):
                self.client.fs.files[REMOTE_EVIDENCE + "/results.xml"] = xml
                self.runner.collect(sandbox, final=True)
                self.assertEqual(self.runner.report(), 1)
                self.assertFalse(json.loads((self.output / "orchestration.json").read_text())["reports_complete"])

    def test_retained_nonreport_tampering_never_passes(self):
        self.assertEqual(self.runner.run(self.artifacts, self.bundle, None), 0)
        (self.output / "evidence/terminal/evidence.txt").write_text("tampered")
        self.assertEqual(self.runner.report(), 1)
        self.assertTrue(any("does not match final manifest" in error for error in self.state.errors))

    def test_scenario_evidence_reference_requires_current_manifest_file(self):
        sandbox = self.runner.create()
        self.runner.launch(sandbox, None)
        self.runner.collect(sandbox)
        del self.client.fs.files[REMOTE_EVIDENCE + "/terminal/evidence.txt"]
        self.assertEqual(self.runner.recover(0), 1)
        self.assertTrue((self.output / "evidence/terminal/evidence.txt").exists())
        self.assertTrue(any("missing installed scenario evidence" in error for error in self.state.errors))

    def test_unsafe_scenario_evidence_reference_never_passes(self):
        sandbox = self.runner.create()
        self.runner.launch(sandbox, None)
        path = REMOTE_EVIDENCE + "/results.json"
        result = json.loads(self.client.fs.files[path])
        result["scenarios"][0]["evidence"] = ["../outside"]
        self.client.fs.files[path] = json.dumps(result).encode()
        self.assertEqual(self.runner.recover(0), 1)
        self.assertTrue(any("unsafe artifact path" in error for error in self.state.errors))

    def test_poll_deadline_retains_partial_evidence(self):
        self.client.fs.files[REMOTE_EVIDENCE + "/partial.log"] = b"partial"
        with self.assertRaisesRegex(OrchestrationError, "deadline"):
            self.runner.poll(self.client.sandbox, time.time() - 1)
        self.assertEqual((self.output / "evidence/partial.log").read_bytes(), b"partial")

    def test_recover_running_run_collects_without_create_or_launch(self):
        sandbox = self.runner.create()
        self.runner.launch(sandbox, None)
        self.assertEqual(self.runner.recover(0), 0)
        self.assertEqual(self.client.creates, 1)
        self.assertEqual(sum(command.startswith("nohup ") for command, _ in self.client.process.calls), 1)
        self.assertEqual(self.runner.recover(0), 0)

    def test_snapshot_uses_checked_in_toolchain_only(self):
        destination = self.output / "snapshot"
        self.assertEqual(prepare_snapshot(self.client, "toolchain", destination), 0)
        params = self.client.snapshot.params
        self.assertEqual(asdict(params.resources), {**RESOURCES, "gpu": None, "gpu_type": None})
        dockerfile = params.image.dockerfile()
        self.assertIn("node:22.23.2", dockerfile)
        self.assertIn("BUN_VERSION=1.3.11", dockerfile)
        self.assertIn("NPM_VERSION=11.16.0", dockerfile)
        self.assertNotIn("COPY", "\n".join(line for line in dockerfile.splitlines() if not line.startswith("#")))
        self.assertEqual(params.image._context_list, [])
        self.assertEqual(json.loads((destination / "snapshot.json").read_text())["status"], "active")

    def test_ambiguous_snapshot_has_retained_record_not_replacement(self):
        self.client.snapshot.create_error = TimeoutError()
        destination = self.output / "snapshot"
        self.assertEqual(prepare_snapshot(self.client, "toolchain", destination), 1)
        self.assertEqual(json.loads((destination / "snapshot.json").read_text())["status"], "failed-or-ambiguous")

    def test_input_archive_rejects_symlink_and_credential_config(self):
        destination = self.output / "archive.tar.gz"
        (self.bundle / "outside").symlink_to(self.artifacts, target_is_directory=True)
        with self.assertRaisesRegex(OrchestrationError, "links"):
            archive_directory(self.bundle, destination)
        (self.bundle / "outside").unlink()
        (self.bundle / ".env").write_text("SECRET=value")
        with self.assertRaisesRegex(OrchestrationError, "credential"):
            archive_directory(self.bundle, destination)

    def test_bundle_tar_rejects_traversal_and_links(self):
        archive = self.output / "bad.tar"
        for name, kind in (("../escape", tarfile.REGTYPE), ("link", tarfile.SYMTYPE)):
            with self.subTest(name=name):
                with tarfile.open(archive, "w") as stream:
                    item = tarfile.TarInfo(name)
                    item.type = kind
                    item.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
                    stream.addfile(item)
                with self.assertRaises(OrchestrationError):
                    validate_archive(archive)

    def test_remote_archive_hashes_verified_before_any_extraction(self):
        root = self.output / "remote"
        root.mkdir()
        release = root / "diffex-release.tar.gz"
        bundle = root / "diffex-bundle.tar.gz"
        archive_directory(self.artifacts, release)
        archive_directory(self.bundle, bundle)
        script = EXTRACT_SCRIPT.replace("/tmp/", root.as_posix() + "/")
        # A mismatch in the SECOND input must prevent extracting the first too.
        with patch("sys.argv", ["extract.py", sha256(release), "0" * 64]):
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                exec(compile(script, "extract", "exec"), {})
        self.assertFalse((root / "diffex-release").exists())
        self.assertFalse((root / "diffex-behaviors").exists())
        with patch("sys.argv", ["extract.py", sha256(release), sha256(bundle)]):
            exec(compile(script, "extract", "exec"), {})
        self.assertTrue((root / "diffex-release/release.json").is_file())
        self.assertTrue((root / "diffex-behaviors/scripts/daytona-behaviors/installed.py").is_file())

    def test_remote_helpers_compile(self):
        compile(EXTRACT_SCRIPT, "extract", "exec")
        compile(MANIFEST_SCRIPT, "manifest", "exec")

    def test_cli_requires_unique_run_id_and_full_commit(self):
        args = ["run", "--artifacts", str(self.artifacts), "--bundle", str(self.bundle),
                "--snapshot", "toolchain", "--output", str(self.output / "cli"),
                "--mode", "deterministic", "--commit", "bad"]
        with patch("sys.stderr", new=io.StringIO()):
            with self.assertRaises(SystemExit):
                main(args)
            with self.assertRaises(SystemExit):
                main(args + ["--run-id", "workflow-1"])
        self.assertFalse((self.output / "cli").exists())

    def test_cli_deterministic_does_not_read_or_forward_openai_key(self):
        destination = self.output / "cli"
        with patch("daytona_runner.Daytona", return_value=FakeClient(destination)), patch.dict(
            os.environ, {"OPENAI_API_KEY": "ambient-secret"}
        ):
            self.assertEqual(main(["run", "--artifacts", str(self.artifacts), "--bundle", str(self.bundle),
                "--snapshot", "toolchain", "--output", str(destination), "--run-id", "workflow-2",
                "--mode", "deterministic", "--commit", "b" * 40]), 0)
        self.assertNotIn("ambient-secret", (destination / "state.json").read_text())


if __name__ == "__main__":
    unittest.main()
