"""Deterministic stage planning, dataset integrity, and cleanup checks."""

import asyncio
from pathlib import Path
import os
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from daytona import AsyncDaytona
from daytona.common.errors import DaytonaNotFoundError
from harbor.models.task.task import Task
from harbor.models.trial.config import TrialConfig

from diffex_terminal_bench.benchmark import PACKAGE, preflight, run_stage, trial_config
from diffex_terminal_bench.dataset import load_config, prepare_dataset
from diffex_terminal_bench.daytona_backend import confirm_cleanup
from diffex_terminal_bench.gate import read_json, sha256, write_json
from diffex_terminal_bench.recover import recover


class BenchmarkTests(unittest.TestCase):
    def setUp(self):
        self.config = load_config(PACKAGE / "benchmark.toml")

    def test_configuration_preserves_task_resources_timeouts_and_isolation(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "secret"}, clear=True):
            config = trial_config(self.config, Path("/task"), Path("/runs/one"), "unique", oracle=False)
        restored = TrialConfig.model_validate_json(config.model_dump_json())
        self.assertEqual(restored.timeout_multiplier, 1)
        self.assertIsNone(restored.agent.override_timeout_sec)
        self.assertIsNone(restored.agent.max_timeout_sec)
        self.assertIsNone(restored.environment.override_cpus)
        self.assertIsNone(restored.environment.override_memory_mb)
        self.assertIsNone(restored.environment.override_storage_mb)
        self.assertTrue(restored.environment.delete)
        self.assertFalse(restored.verifier.disable)
        self.assertEqual(restored.agent.env, {"OPENAI_API_KEY": "${OPENAI_API_KEY}"})
        self.assertNotIn("secret", config.model_dump_json())
        self.assertEqual(config.environment.kwargs["labels"], {"diffex.gate_trial": "unique"})
        oracle = trial_config(self.config, Path("/task"), Path("/runs/one"), "unique", oracle=True)
        self.assertEqual(oracle.agent.name, "oracle")
        self.assertEqual(oracle.agent.env, {})

    def test_missing_credentials_fail_before_remote_work(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, "DAYTONA_API_KEY"):
            preflight(self.config, oracle=True)
        with patch.dict(os.environ, {"DAYTONA_API_KEY": "fixture"}, clear=True):
            preflight(self.config, oracle=True)
            with self.assertRaisesRegex(ValueError, "provider credential"):
                preflight(self.config, oracle=False)

    def test_dataset_corruption_and_changed_extraction_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            tree = root / "tree"
            for name in self.config.pilot_tasks:
                path = tree / "tasks" / name
                (path / "environment").mkdir(parents=True)
                (path / "environment/Dockerfile").write_text("FROM ubuntu:24.04\n")
                (path / "task.toml").write_text('version = "1.0"\n')
                (path / "instruction.md").write_text("fixture")
                (path / "tests").mkdir()
                (path / "tests/test.sh").write_text("exit 0\n")
                self.assertTrue(Task.is_valid_dir(path))
            # The upstream repository also contains a valid analysis task
            # template outside tasks/. It must never enter the benchmark.
            shutil.copytree(tree / "tasks" / self.config.pilot_tasks[0], tree / "analysis-task-template")
            archive = root / "fixture.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(tree, arcname="dataset")
            config = self.config.model_copy(deep=True)
            config.dataset.archive_sha256 = sha256(archive)
            config.dataset.task_count = 10
            cache = root / "cache"
            cache.mkdir()
            saved = cache / f"{config.dataset.archive_sha256}.tar.gz"
            shutil.copyfile(archive, saved)
            with prepare_dataset(config, cache) as (tasks, digests):
                self.assertEqual(len(tasks), 10)
                self.assertEqual(set(tasks), set(self.config.pilot_tasks))
                self.assertNotIn("analysis-task-template", tasks)
                (tasks[config.pilot_tasks[0]] / "instruction.md").write_text("changed")
            with prepare_dataset(config, cache) as (tasks, repeated):
                self.assertEqual(digests, repeated)
                self.assertEqual((tasks[config.pilot_tasks[0]] / "instruction.md").read_text(), "fixture")
            saved.write_bytes(b"corrupt")
            with self.assertRaisesRegex(ValueError, "SHA-256"), prepare_dataset(config, cache):
                self.fail("corrupt archive accepted")


class CleanupTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)
        write_json(self.directory / "sandbox-created.json", {"sandboxes": [{"id": "known"}]})
        self.client = Mock(spec=AsyncDaytona)
        self.client.get = AsyncMock(side_effect=DaytonaNotFoundError("gone"))
        self.client.delete = AsyncMock()
        self.queries = []

        async def listing(query, request_timeout):
            self.queries.append(query)
            for value in []:
                yield value

        self.client.list = listing

    async def test_confirmed_absence_requires_api_evidence(self):
        report = await confirm_cleanup(self.client, self.directory, "trial-only")
        self.assertTrue(report["confirmed"])
        self.assertEqual(report["absent_ids"], ["known"])
        self.assertEqual(report["unexpected_sandboxes"], [])
        self.assertTrue(all(query.labels == {"diffex.gate_trial": "trial-only"} for query in self.queries))
        self.client.delete.assert_not_called()

    async def test_api_errors_never_count_as_absence(self):
        self.client.get.side_effect = RuntimeError("transport unavailable")
        report = await confirm_cleanup(self.client, self.directory, "trial-only")
        self.assertFalse(report["confirmed"])
        self.assertEqual(report["error"], "RuntimeError")
        self.assertEqual(read_json(self.directory / "sandbox-cleanup.json"), report)

    async def test_recovery_preserves_original_evidence(self):
        trial_dir = self.directory / "oracle/one"
        write_json(trial_dir / "cleanup-request.json", {"label": "unique"})
        write_json(trial_dir / "sandbox-cleanup.json", {"confirmed": False})
        original = (trial_dir / "sandbox-cleanup.json").read_bytes()
        with patch("diffex_terminal_bench.recover.AsyncDaytona") as client:
            client.return_value.__aenter__ = AsyncMock(return_value=self.client)
            client.return_value.__aexit__ = AsyncMock(return_value=False)
            await recover(self.directory)
        self.assertEqual((trial_dir / "sandbox-cleanup.json").read_bytes(), original)
        self.assertTrue(read_json(trial_dir / "sandbox-recovery.json")["confirmed"])

    async def test_orphan_recovery_is_retained_as_gate_failure(self):
        orphan = Mock(id="orphan")
        calls = 0

        async def listing(query, request_timeout):
            nonlocal calls
            calls += 1
            if calls == 1:
                yield orphan

        self.client.list = listing
        report = await confirm_cleanup(self.client, self.directory, "trial-only")
        self.assertTrue(report["confirmed"])
        self.assertEqual(report["unexpected_sandboxes"], ["orphan"])
        self.client.delete.assert_awaited_once_with(orphan, wait=True, timeout=60)

    async def test_asynchronous_deletion_gets_a_bounded_grace_period(self):
        self.client.get.side_effect = [Mock(), DaytonaNotFoundError("gone")]
        with patch("diffex_terminal_bench.daytona_backend.asyncio.sleep", new_callable=AsyncMock) as sleep:
            report = await confirm_cleanup(self.client, self.directory, "trial-only")
        self.assertTrue(report["confirmed"])
        self.assertEqual(report["unexpected_sandboxes"], [])
        sleep.assert_awaited_once_with(2)

    async def test_no_remote_trial_starts_without_prerequisites(self):
        config = load_config(PACKAGE / "benchmark.toml")
        with patch("diffex_terminal_bench.benchmark.Trial.create", new_callable=AsyncMock) as create:
            with self.assertRaises(OSError):
                await run_stage(config, {name: Path(name) for name in config.pilot_tasks}, {}, self.directory, "full")
        create.assert_not_called()

    async def test_cancellation_during_cleanup_cannot_pass_a_stage(self):
        config = load_config(PACKAGE / "benchmark.toml")
        started, finish = asyncio.Event(), asyncio.Event()

        async def cleanup(*args):
            started.set()
            await finish.wait()
            return {"confirmed": True}

        manager = Mock(_cleanup=AsyncMock())
        trial = Mock(run=AsyncMock())
        with patch("diffex_terminal_bench.benchmark.AsyncDaytona") as client, \
             patch("diffex_terminal_bench.benchmark.Trial.create", new_callable=AsyncMock, return_value=trial), \
             patch("diffex_terminal_bench.benchmark.Packager.compute_content_hash", return_value=("fixture", [])), \
             patch("diffex_terminal_bench.benchmark.confirm_cleanup", side_effect=cleanup), \
             patch("diffex_terminal_bench.benchmark.DaytonaClientManager.get_instance", new_callable=AsyncMock, return_value=manager):
            client.return_value.__aenter__ = AsyncMock(return_value=self.client)
            client.return_value.__aexit__ = AsyncMock(return_value=False)
            identity = {"task_digests": {name: "sha256:fixture" for name in config.pilot_tasks}}
            task = asyncio.create_task(run_stage(config, {name: Path(name) for name in config.pilot_tasks},
                                                 identity, self.directory, "oracle"))
            await started.wait()
            task.cancel()
            await asyncio.sleep(0)
            finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        report = read_json(self.directory / "oracle/gate.json")
        self.assertFalse(report["passed"])
        self.assertEqual(report["failure"]["error"], "CancelledError")


if __name__ == "__main__":
    unittest.main()
