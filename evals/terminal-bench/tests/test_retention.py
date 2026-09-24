"""Completed Harbor trials reclaim only fully retained volume artifacts."""

import asyncio
import json
from pathlib import Path
import shutil
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, create_autospec, patch

from daytona.common.errors import DaytonaNotFoundError
from harbor.cli.job_plugins import attach_job_plugin
from harbor.trial.hooks import TrialEvent
from harbor.trial.single_step import SingleStepTrial
from harbor.trial.trial import Trial

from diffex_terminal_bench.gate import read_json, write_json
from diffex_terminal_bench.retention import cleanup_trial_volume, validate_retention
import test_gate


class RetentionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        fixture = test_gate.GateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.directory = fixture.directory
        self.run = fixture.run
        self.remote = fixture.root / "volume"
        self.remote.mkdir()
        self.mounts = [{"volume_id": "shared", "mount_path": "/logs", "subpath": "trials/" + "a" * 32}]
        write_json(self.directory / "artifact-volume.json", {"mounts": self.mounts})
        for name in ("agent", "verifier"):
            shutil.copytree(self.directory / name, self.remote / name)
        self.uploads = {}

        async def upload(data, path):
            self.uploads[path] = data

        async def execute(command, timeout):
            # Execute the actual uploaded cleanup program against isolated
            # temporary prefix directories, replacing only the mount boundary.
            request = json.loads(self.uploads["/tmp/prune-request.json"])
            request["roots"] = [str(self.remote)] + ([str(self.verifier_remote)] if len(self.mounts) == 2 else [])
            script = fixture.root / "prune.py"
            script.write_bytes(self.uploads["/tmp/prune-volume.py"])
            path = fixture.root / "request.json"
            write_json(path, request)
            result = subprocess.run([sys.executable, str(script), str(path)], capture_output=True, text=True, timeout=timeout)
            return SimpleNamespace(exit_code=result.returncode, result=result.stdout)

        self.sandbox = SimpleNamespace(id="cleanup", fs=SimpleNamespace(upload_file=AsyncMock(side_effect=upload)),
                                       process=SimpleNamespace(exec=AsyncMock(side_effect=execute)))
        self.client = SimpleNamespace(get=AsyncMock(side_effect=DaytonaNotFoundError("gone")),
                                      create=AsyncMock(return_value=self.sandbox), delete=AsyncMock())

    async def test_completed_zero_reward_reclaims_remote_only(self):
        sibling = self.remote.parent / "other-trial"
        sibling.mkdir()
        (sibling / "live.log").write_text("still running")
        report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "cleaned")
        self.assertTrue(report["confirmed"])
        self.assertGreater(report["deleted_files"], 0)
        self.assertEqual(list(self.remote.iterdir()), [])
        self.assertTrue((self.run / "sessions/root.jsonl").exists())
        self.assertEqual((sibling / "live.log").read_text(), "still running")
        request = self.client.create.call_args.args[0]
        self.assertEqual(request.volumes[0].subpath, self.mounts[0]["subpath"])
        self.assertEqual(request.auto_delete_interval, 0)
        self.assertEqual(request.ttl_minutes, 10)
        self.client.delete.assert_awaited_once_with(self.sandbox, wait=True, timeout=15)

    async def test_retains_failed_unverified_and_incomplete_trials(self):
        changes = [(self.directory / "result.json", "finished_at", None),
                   (self.directory / "result.json", "exception_info", {"exception_type": "VerifierTimeoutError"}),
                   (self.directory / "result.json", "verifier_result", None),
                   (self.run / "outcome.json", "artifact_errors", [{"phase": "download"}]),
                   (self.run / "cleanup.json", "agent_execution_stopped", False),
                   (self.run / "accounting.json", "gaps", ["missing_session"])]
        for path, key, value in changes:
            with self.subTest(key=key):
                original = path.read_bytes()
                data = read_json(path)
                data[key] = value
                write_json(path, data)
                report = await cleanup_trial_volume(self.client, self.directory)
                self.assertEqual(report["status"], "retained")
                self.client.create.assert_not_awaited()
                path.write_bytes(original)

    async def test_hash_mismatch_and_missing_local_files_prevent_any_deletion(self):
        path = self.remote / "verifier/test-stdout.txt"
        for value in ("not collected", ""):
            path.write_text(value)
            report = await cleanup_trial_volume(self.client, self.directory)
            self.assertEqual(report["status"], "cleanup_failed")
            self.assertTrue((self.remote / "agent/run-fixture/stdout.jsonl").exists())
            self.assertTrue(report["cleanup_sandbox_deleted"])
        path.write_bytes((self.directory / "verifier/test-stdout.txt").read_bytes())
        (self.remote / "uncollected.log").write_text("remote only")
        report = await cleanup_trial_volume(self.client, self.directory)
        self.assertFalse(report["confirmed"])
        self.assertTrue((self.remote / "uncollected.log").exists())

    async def test_links_never_followed_or_deleted(self):
        (self.remote / "linked-home").symlink_to(self.directory, target_is_directory=True)
        report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "cleanup_failed")
        self.assertTrue((self.directory / "result.json").exists())
        self.assertTrue((self.remote / "linked-home").is_symlink())

    async def test_separate_verifier_prefixes_validated_together(self):
        self.verifier_remote = self.remote.parent / "verifier-volume"
        self.verifier_remote.mkdir()
        shutil.move(self.remote / "verifier", self.verifier_remote / "verifier")
        self.mounts.append({**self.mounts[0], "subpath": "trials/" + "b" * 32})
        write_json(self.directory / "artifact-volume.json", {"mounts": self.mounts})
        write_json(self.directory / "sandbox-created.json", {"sandboxes": [{"id": "agent"}, {"id": "verifier"}]})
        report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "cleaned")
        self.assertEqual(list(self.remote.iterdir()), [])
        self.assertEqual(list(self.verifier_remote.iterdir()), [])
        self.assertEqual(self.client.get.await_count, 2)
        self.assertEqual(len(self.client.create.call_args.args[0].volumes), 2)

    async def test_existing_sandbox_or_invalid_prefix_prevents_cleanup(self):
        self.client.get.side_effect = None
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "retained")
        self.client.create.assert_not_awaited()
        self.client.get.side_effect = DaytonaNotFoundError("gone")
        for prefix in ("trials/../other", "trials/", "", "/"):
            self.mounts[0]["subpath"] = prefix
            write_json(self.directory / "artifact-volume.json", {"mounts": self.mounts})
            report = await cleanup_trial_volume(self.client, self.directory)
            self.assertEqual(report["status"], "retained")
            self.client.create.assert_not_awaited()

    async def test_delayed_sandbox_deletion_is_polled_before_mounting(self):
        self.client.get.side_effect = [SimpleNamespace(state="deleting"), DaytonaNotFoundError("gone")]
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "cleaned")
        self.assertEqual(self.client.get.await_count, 2)

    async def test_transient_upload_and_deletion_failures_retry(self):
        upload = self.sandbox.fs.upload_file.side_effect
        attempts = 0

        async def flaky(data, path):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ConnectionError("lost transport")
            await upload(data, path)

        self.sandbox.fs.upload_file.side_effect = flaky
        self.client.delete.side_effect = [ConnectionError("lost response"), None]
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            report = await cleanup_trial_volume(self.client, self.directory)
        self.assertEqual(report["status"], "cleaned")
        self.assertEqual(self.client.delete.await_count, 2)
        self.assertEqual(attempts, 3)

    async def test_lost_cleanup_response_retries_idempotently(self):
        execute = self.sandbox.process.exec.side_effect
        attempts = 0

        async def lose_response(command, timeout):
            nonlocal attempts
            attempts += 1
            response = await execute(command, timeout)
            if attempts == 1:
                raise ConnectionError("response lost after deletion")
            return response

        self.sandbox.process.exec.side_effect = lose_response
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            report = await cleanup_trial_volume(self.client, self.directory)
        self.assertTrue(report["confirmed"])
        self.assertEqual(attempts, 2)
        self.assertEqual(list(self.remote.iterdir()), [])

    async def test_cancellation_waits_for_cleanup_sandbox_deletion(self):
        deleting = asyncio.Event()
        release = asyncio.Event()

        async def delete(*args, **kwargs):
            deleting.set()
            await release.wait()

        self.client.delete.side_effect = delete
        self.sandbox.fs.upload_file.side_effect = asyncio.CancelledError
        task = asyncio.create_task(cleanup_trial_volume(self.client, self.directory))
        await asyncio.wait_for(deleting.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(read_json(self.directory / "volume-cleanup.json")["cleanup_sandbox_deleted"])
        self.assertTrue((self.remote / "agent/run-fixture/stdout.jsonl").exists())

    async def test_plugin_attaches_to_real_harbor_finalize_after_result_is_saved(self):
        job = Mock()
        plugin = await attach_job_plugin(job, "diffex_terminal_bench.retention:VolumeCleanupPlugin")
        job.add_hook.assert_called_once_with(TrialEvent.END, plugin.on_trial_end)
        result = read_json(self.directory / "result.json")
        (self.directory / "result.json").unlink()
        trial = create_autospec(SingleStepTrial, instance=True)
        trial.paths = SimpleNamespace(result_path=self.directory / "result.json")
        trial.result = Mock(model_dump_json=Mock(return_value=json.dumps(result)))
        stopped = False

        async def stop():
            nonlocal stopped
            stopped = True

        async def emit(event):
            self.assertTrue(stopped)
            self.assertEqual(event, TrialEvent.END)
            self.assertTrue(trial.paths.result_path.exists())
            await plugin.on_trial_end(SimpleNamespace(config=SimpleNamespace(
                environment=SimpleNamespace(delete=True, import_path="diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment"),
                trials_dir=self.directory.parent, trial_name=self.directory.name)))

        trial._stop_agent_environment.side_effect = stop
        trial._emit.side_effect = emit
        with patch("diffex_terminal_bench.retention.AsyncDaytona") as factory:
            factory.return_value.__aenter__.return_value = self.client
            await Trial._finalize(trial)
        self.assertEqual(list(self.remote.iterdir()), [])

    def test_artifact_convention_paths_map_to_harbor_local_storage(self):
        path = self.directory / "artifacts/logs/artifacts/file.txt"
        path.parent.mkdir(parents=True)
        path.write_text("task artifact")
        self.assertIn("artifacts/file.txt", validate_retention(self.directory))


if __name__ == "__main__":
    unittest.main()
