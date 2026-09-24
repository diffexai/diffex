"""Exercise startup retries through Harbor's actual direct startup path."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from daytona import CreateSandboxFromSnapshotParams
from daytona.common.errors import DaytonaAuthenticationError, DaytonaNotFoundError, DaytonaTimeoutError
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths
from harbor.trial.errors import EnvironmentStartTimeoutError

from diffex_terminal_bench.daytona_backend import RecordedDaytonaEnvironment


class StartupRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "Dockerfile").write_text("FROM ubuntu:24.04\n")
        self.environment = RecordedDaytonaEnvironment(
            environment_dir=self.root, environment_name="fixture", session_id="fixture",
            trial_paths=TrialPaths(self.root / "trial"), task_env_config=EnvironmentConfig(),
        )
        self.sandbox = SimpleNamespace(id="sandbox-id", snapshot="fixture", cpu=1,
                                       memory=1, disk=10, labels={})
        self.client = SimpleNamespace(
            create=AsyncMock(return_value=self.sandbox),
            get=AsyncMock(side_effect=DaytonaNotFoundError("absent")),
            delete=AsyncMock(),
            volume=SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(id="volume-id", state="ready"))),
        )
        self.params = CreateSandboxFromSnapshotParams(snapshot="fixture")
        manager = SimpleNamespace(get_client=AsyncMock(return_value=self.client))
        mock = patch("harbor.environments.daytona.environment.DaytonaClientManager.get_instance",
                     new_callable=AsyncMock, return_value=manager)
        mock.start()
        self.addCleanup(mock.stop)
        for name, value in (("_configure_daytona_client", None), ("_resolve_start_sandbox_params", self.params),
                            ("ensure_dirs", None), ("_upload_environment_dir_after_start", None),
                            ("_write_sandbox_id_file", None)):
            mock = patch.object(self.environment, name, new_callable=AsyncMock, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    async def test_three_timeouts_then_fourth_attempt_succeeds(self):
        self.client.create.side_effect = [DaytonaTimeoutError("startup timed out") for _ in range(3)] + [self.sandbox]
        await self.environment.start(force_build=False)
        self.assertEqual([call.kwargs["timeout"] for call in self.client.create.call_args_list], [60, 60, 60, 300])
        self.assertIs(self.environment._sandbox, self.sandbox)
        record = json.loads((self.root / "trial/sandbox-created.json").read_text())
        self.assertEqual(record["sandboxes"][0]["id"], "sandbox-id")

    async def test_first_success_does_not_retry_or_mutate_caller_name(self):
        await self.environment.start(force_build=False)
        self.client.create.assert_awaited_once()
        request = self.client.create.call_args.kwargs
        self.assertEqual(request["timeout"], 60)
        self.assertTrue(request["params"].name.startswith("diffex-start-"))
        self.assertIsNone(self.params.name)
        self.assertEqual(request["params"].snapshot, "fixture")
        self.assertEqual(request["params"].labels["harbor.session_id"], "fixture")
        self.client.get.assert_not_awaited()

    async def test_four_timeouts_raise_startup_timeout_and_keep_attempt_evidence(self):
        self.client.create.side_effect = DaytonaTimeoutError("startup timed out")
        with self.assertRaisesRegex(EnvironmentStartTimeoutError, "60, 60, 60, 300"):
            await self.environment.start(force_build=False)
        self.assertEqual(self.client.create.await_count, 4)
        self.assertEqual(self.client.get.await_count, 4)
        record = json.loads((self.root / "trial/sandbox-startup.json").read_text())
        self.assertEqual([row["timeout_sec"] for row in record["attempts"]], [60, 60, 60, 300])
        self.assertEqual({row["status"] for row in record["attempts"]}, {"timed_out"})
        self.assertEqual({row["cleanup"] for row in record["attempts"]}, {"absent"})
        self.assertEqual(len({row["name"] for row in record["attempts"]}), 1)
        self.assertIsNone(self.environment._sandbox)

    async def test_actual_deadlines_cancel_stalled_create_and_allow_longer_last_attempt(self):
        calls = []
        cancelled = []

        async def create(*, params, timeout):
            calls.append(timeout)
            try:
                # The real local deadline, rather than a synthetic SDK error,
                # must stop each stalled attempt and grant the last more time.
                await asyncio.sleep(0.15)
                return self.sandbox
            except asyncio.CancelledError:
                cancelled.append(timeout)
                raise

        self.client.create.side_effect = create
        real_timeout = asyncio.timeout
        with patch("diffex_terminal_bench.daytona_backend.asyncio.timeout",
                   side_effect=lambda seconds: real_timeout(seconds / 1000)):
            await self.environment.start(force_build=False)
        self.assertEqual(calls, [60, 60, 60, 300])
        self.assertEqual(cancelled, [60, 60, 60])

    async def test_accepted_sandbox_is_deleted_before_replacement(self):
        events = []

        async def create(*, params, timeout):
            events.append("create")
            if events.count("create") == 1:
                raise DaytonaTimeoutError("started remotely but response timed out")
            return self.sandbox

        async def delete(sandbox, *, wait, timeout):
            self.assertIs(sandbox, self.sandbox)
            self.assertTrue(wait)
            events.append("delete")

        self.client.create.side_effect = create
        self.client.get.side_effect = None
        self.client.get.return_value = self.sandbox
        self.client.delete.side_effect = delete
        await self.environment.start(force_build=False)
        self.assertEqual(events, ["create", "delete", "create"])
        self.assertEqual(len({call.kwargs["params"].name for call in self.client.create.call_args_list}), 1)

    async def test_failed_cleanup_prevents_replacement_and_retains_sandbox(self):
        self.client.create.side_effect = DaytonaTimeoutError("startup timed out")
        self.client.get.side_effect = None
        self.client.get.return_value = self.sandbox
        self.client.delete.side_effect = RuntimeError("delete failed")
        with self.assertRaisesRegex(RuntimeError, "delete failed"):
            await self.environment.start(force_build=False)
        self.assertEqual(self.client.create.await_count, 1)
        self.assertIs(self.environment._sandbox, self.sandbox)
        attempts = json.loads((self.root / "trial/sandbox-startup.json").read_text())["attempts"]
        self.assertEqual(attempts[0]["cleanup"], "failed")
        self.assertTrue((self.root / "trial/sandbox-created.json").is_file())

    async def test_permanent_error_is_not_retried_or_replaced_by_cleanup_error(self):
        self.client.create.side_effect = DaytonaAuthenticationError("unauthorized")
        self.client.get.side_effect = DaytonaAuthenticationError("cleanup unauthorized")
        with self.assertLogs(self.environment.logger, level="ERROR"):
            with self.assertRaisesRegex(DaytonaAuthenticationError, "^unauthorized$"):
                await self.environment.start(force_build=False)
        self.assertEqual(self.client.create.await_count, 1)

    async def test_cancellation_cleans_up_without_starting_another_attempt(self):
        started = asyncio.Event()
        deleting = asyncio.Event()
        release = asyncio.Event()

        async def create(**kwargs):
            started.set()
            await asyncio.Event().wait()

        async def delete(*args, **kwargs):
            deleting.set()
            await release.wait()

        self.client.create.side_effect = create
        self.client.get.side_effect = None
        self.client.get.return_value = self.sandbox
        self.client.delete.side_effect = delete
        task = asyncio.create_task(self.environment.start(force_build=False))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        await asyncio.wait_for(deleting.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        self.assertEqual(self.client.create.await_count, 1)
        self.assertIsNone(self.environment._sandbox)


if __name__ == "__main__":
    unittest.main()
