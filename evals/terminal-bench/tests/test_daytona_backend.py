"""Volume isolation at the pinned Harbor sandbox creation boundary."""

import asyncio
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from daytona import CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Image
from daytona.common.errors import DaytonaConflictError, DaytonaError
from harbor.environments.daytona import DaytonaEnvironment
from harbor.models.job.config import JobConfig
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths
import yaml

from diffex_terminal_bench.daytona_backend import RecordedDaytonaEnvironment


class VolumeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / "Dockerfile").write_text("FROM ubuntu:24.04\n")
        self.environment = RecordedDaytonaEnvironment(
            environment_dir=self.root, environment_name="fixture", session_id="fixture",
            trial_paths=TrialPaths(self.root / "trial"), task_env_config=EnvironmentConfig(),
        )
        self.volume = SimpleNamespace(id="volume-id", state="ready")
        self.client = SimpleNamespace(volume=SimpleNamespace(get=AsyncMock(return_value=self.volume)))
        parent = patch.object(DaytonaEnvironment, "_create_sandbox", new_callable=AsyncMock)
        self.create = parent.start()
        self.addCleanup(parent.stop)

    async def test_full_445_trials_share_one_volume_with_isolated_prefixes(self):
        params = [CreateSandboxFromSnapshotParams(snapshot="fixture") for _ in range(445)]
        # Exercise the same creation hook for every trial, with no live API.
        for request in params:
            await self.environment._create_sandbox(request, self.client)
            await asyncio.sleep(0)
        mounts = [request.volumes[0] for request in params]
        self.assertEqual({mount.volume_id for mount in mounts}, {"volume-id"})
        self.assertEqual({mount.mount_path for mount in mounts}, {"/logs"})
        self.assertEqual(len({mount.subpath for mount in mounts}), 445)
        self.assertTrue(all(mount.subpath.startswith("trials/") and ".." not in mount.subpath for mount in mounts))
        self.assertEqual({call.args[0] for call in self.client.volume.get.call_args_list}, {"diffex-terminal-bench-logs"})
        record = json.loads((self.root / "trial/artifact-volume.json").read_text())
        self.assertEqual([entry["subpath"] for entry in record["mounts"]], [mount.subpath for mount in mounts])

    async def test_separate_verifier_preserves_agent_recovery_location(self):
        verifier = RecordedDaytonaEnvironment(
            environment_dir=self.root, environment_name="verifier", session_id="verifier-session",
            trial_paths=self.environment.trial_paths, task_env_config=EnvironmentConfig(),
        )
        for environment in (self.environment, verifier):
            await environment._create_sandbox(CreateSandboxFromSnapshotParams(snapshot="fixture"), self.client)
        entries = json.loads((self.root / "trial/artifact-volume.json").read_text())["mounts"]
        self.assertEqual([entry["session_id"] for entry in entries], ["fixture", "verifier-session"])
        self.assertNotEqual(entries[0]["subpath"], entries[1]["subpath"])

    async def test_waits_for_readiness_after_concurrent_volume_creation(self):
        self.client.volume.get.side_effect = [DaytonaConflictError("already created"),
                                              SimpleNamespace(id="volume-id", state="pending_create"),
                                              SimpleNamespace(id="volume-id", state="creating"), self.volume]
        with patch("diffex_terminal_bench.daytona_backend.asyncio.sleep"):
            await self.environment._create_sandbox(CreateSandboxFromImageParams(image=Image.base("ubuntu:24.04")), self.client)
        self.create.assert_awaited_once()
        self.assertEqual(self.client.volume.get.await_count, 4)

    async def test_unusable_volume_prevents_sandbox_creation(self):
        self.volume.state = "error"
        with self.assertRaisesRegex(RuntimeError, "not usable"):
            await self.environment._create_sandbox(CreateSandboxFromSnapshotParams(snapshot="fixture"), self.client)
        self.create.assert_not_awaited()

    async def test_volume_quota_error_is_not_retried_or_bypassed(self):
        self.client.volume.get.side_effect = DaytonaError("volume quota", status_code=400)
        with self.assertRaises(DaytonaError):
            await self.environment._create_sandbox(CreateSandboxFromSnapshotParams(snapshot="fixture"), self.client)
        self.assertEqual(self.client.volume.get.await_count, 1)
        self.create.assert_not_awaited()

    async def test_provisioning_wait_is_bounded(self):
        self.volume.state = "creating"
        timeout = asyncio.timeout
        with patch("diffex_terminal_bench.daytona_backend.asyncio.timeout", side_effect=lambda seconds: timeout(0.01)):
            with self.assertRaises(TimeoutError):
                await self.environment._create_sandbox(CreateSandboxFromSnapshotParams(snapshot="fixture"), self.client)
        self.create.assert_not_awaited()

    async def test_dind_client_manager_and_custom_volume(self):
        self.environment._client_manager = SimpleNamespace(get_client=AsyncMock(return_value=self.client))
        self.environment._kwargs["artifact_volume"] = "dedicated-project-logs"
        params = CreateSandboxFromImageParams(image=Image.base("docker:28.3.3-dind"))
        await self.environment._create_sandbox(params)
        self.client.volume.get.assert_awaited_once_with("dedicated-project-logs", create=True)
        self.create.assert_awaited_once_with(params=params, daytona=self.client)

    def test_native_full_job_selects_volume_backend(self):
        config = JobConfig.model_validate(yaml.safe_load((Path(__file__).resolve().parents[1] / "full.yaml").read_text()))
        self.assertEqual(config.environment.import_path, "diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment")
        self.assertEqual(config.environment.kwargs["artifact_volume"], "diffex-terminal-bench-logs")


if __name__ == "__main__":
    unittest.main()
