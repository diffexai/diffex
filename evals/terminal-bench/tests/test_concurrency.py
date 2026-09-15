"""Bounded parallel stages through the runner's Harbor/Daytona boundary."""

import asyncio
from contextlib import redirect_stderr
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

from diffex_terminal_bench.benchmark import PACKAGE, main, run_identity, run_stage
from diffex_terminal_bench.dataset import BenchmarkConfig, load_config
from diffex_terminal_bench.gate import read_json


class ConcurrencyConfigTests(unittest.TestCase):
    def test_config_requires_positive_integer(self):
        values = load_config(PACKAGE / "benchmark.toml").model_dump()
        values.pop("concurrency")
        self.assertEqual(BenchmarkConfig.model_validate(values).concurrency, 1)
        for value in (0, -1, True, 1.5, "3"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                BenchmarkConfig.model_validate({**values, "concurrency": value})

    def test_cli_rejects_invalid_limits_before_remote_work(self):
        for value in ("0", "-1", "1.5"):
            with self.subTest(value=value), patch("sys.argv", ["benchmark", "--stage", "pilot", "-n", value]), \
                 patch("diffex_terminal_bench.benchmark.preflight") as preflight, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as error:
                    main()
                self.assertEqual(error.exception.code, 2)
                preflight.assert_not_called()

    def test_cli_override_is_prepared_and_part_of_identity(self):
        for flag in ("-n", "--concurrency"):
            with self.subTest(flag=flag), tempfile.TemporaryDirectory() as temp, \
                 patch("sys.argv", ["benchmark", "--prepare", flag, "3", "--output", temp]), \
                 patch("diffex_terminal_bench.benchmark.refresh_index"), \
                 patch("diffex_terminal_bench.benchmark.prepare_dataset") as prepare:
                config = load_config(PACKAGE / "benchmark.toml")
                tasks = {name: Path(name) for name in config.pilot_tasks}
                prepare.return_value.__enter__.return_value = (tasks, {})
                main()
                selected = prepare.call_args.args[0]
                self.assertEqual(selected.concurrency, 3)
                self.assertEqual(read_json(Path(temp) / "dataset.json")["concurrency"], 3)
                with patch("diffex_terminal_bench.benchmark.subprocess.check_output", side_effect=["", "commit"]):
                    self.assertEqual(run_identity(selected, {})["concurrency"], 3)


class ParallelStageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = load_config(PACKAGE / "benchmark.toml")
        self.config.concurrency = 3
        self.tasks = {name: Path(name) for name in self.config.pilot_tasks}
        self.identity = {"task_digests": {name: "sha256:fixture" for name in self.tasks}, "concurrency": 3}
        self.started = {index: asyncio.Event() for index in range(1, 11)}
        self.finish_run = {index: asyncio.Event() for index in range(1, 11)}
        self.cleaning = {index: asyncio.Event() for index in range(1, 11)}
        self.finish_cleanup = {index: asyncio.Event() for index in range(1, 11)}
        self.active = set()
        self.cleaned = set()
        self.configs = []
        self.peak = 0
        self.failure_phase = None

        async def create(config):
            index = int(config.trial_name.split("-", 1)[0])
            self.configs.append(config)
            self.active.add(index)
            self.peak = max(self.peak, len(self.active))
            self.started[index].set()
            if index == 2 and self.failure_phase == "create":
                await self.finish_run[index].wait()
                raise ValueError("creation failed")

            async def run():
                await self.finish_run[index].wait()
                if index == 2 and self.failure_phase == "run":
                    raise ValueError("execution failed")
                if index == 2 and self.failure_phase == "cancel":
                    raise asyncio.CancelledError

            return Mock(run=run)

        async def cleanup(client, directory, label):
            index = int(directory.name.split("-", 1)[0])
            self.cleaning[index].set()
            await self.finish_cleanup[index].wait()
            self.active.remove(index)
            self.cleaned.add(index)
            return {"confirmed": True}

        def validate(directory, *args, **kwargs):
            index = int(directory.name.split("-", 1)[0])
            self.assertIn(index, self.cleaned)
            if index == 2 and self.failure_phase == "validate":
                raise ValueError("invalid evidence")
            return {"rewards": {"reward": 1}}

        async def close(*args):
            self.assertEqual(self.active, set())

        self.manager = Mock(_cleanup=AsyncMock(side_effect=close))
        patches = {
            "require_previous": Mock(),
            "refresh_index": Mock(),
            "Trial.create": AsyncMock(side_effect=create),
            "Packager.compute_content_hash": Mock(return_value=("fixture", [])),
            "confirm_cleanup": AsyncMock(side_effect=cleanup),
            "validate_trial": Mock(side_effect=validate),
            "DaytonaClientManager.get_instance": AsyncMock(return_value=self.manager),
        }
        for name, replacement in patches.items():
            current = patch(f"diffex_terminal_bench.benchmark.{name}", replacement)
            current.start()
            self.addCleanup(current.stop)
        client = patch("diffex_terminal_bench.benchmark.AsyncDaytona")
        mocked = client.start()
        self.addCleanup(client.stop)
        mocked.return_value.__aexit__ = AsyncMock(side_effect=close)

    async def wait_events(self, events, indices):
        async with asyncio.timeout(5):
            await asyncio.gather(*(events[index].wait() for index in indices))

    def start_stage(self):
        task = asyncio.create_task(run_stage(self.config, self.tasks, self.identity, self.root, "pilot"))
        self.addAsyncCleanup(self.stop_stage, task)
        return task

    async def stop_stage(self, task):
        for event in self.finish_cleanup.values():
            event.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_three_slots_include_cleanup_and_keep_declared_order(self):
        task = self.start_stage()
        await self.wait_events(self.started, (1, 2, 3))
        self.finish_run[3].set()
        await self.wait_events(self.cleaning, (3,))
        self.assertFalse(self.started[4].is_set())
        self.finish_cleanup[3].set()
        await self.wait_events(self.started, (4,))
        report = read_json(self.root / "pilot/gate.json")
        self.assertEqual([row["task"] for row in report["trials"]], [self.config.pilot_tasks[2]])
        for event in (*self.finish_run.values(), *self.finish_cleanup.values()):
            event.set()
        await asyncio.wait_for(task, 5)
        report = read_json(self.root / "pilot/gate.json")
        self.assertTrue(report["passed"])
        self.assertEqual([row["task"] for row in report["trials"]], self.config.pilot_tasks)
        self.assertEqual(self.peak, 3)
        self.assertEqual(self.cleaned, set(range(1, 11)))
        self.assertEqual(len({config.environment.kwargs["labels"]["diffex.gate_trial"] for config in self.configs}), 10)
        self.manager._cleanup.assert_awaited_once()

    async def test_one_slot_retains_serial_execution(self):
        self.config.concurrency = 1
        for event in (*self.finish_run.values(), *self.finish_cleanup.values()):
            event.set()
        await asyncio.wait_for(self.start_stage(), 5)
        self.assertEqual(self.peak, 1)
        self.assertEqual(self.cleaned, set(range(1, 11)))

    async def test_failure_stops_queue_and_cleans_peers(self):
        self.failure_phase = "validate"
        await self.check_failure()

    async def test_creation_failure_cleans_started_trials(self):
        self.failure_phase = "create"
        await self.check_failure()

    async def test_execution_failure_cleans_started_trials(self):
        self.failure_phase = "run"
        await self.check_failure()

    async def check_failure(self):
        task = self.start_stage()
        await self.wait_events(self.started, (1, 2, 3))
        self.finish_run[2].set()
        self.finish_cleanup[2].set()
        await self.wait_events(self.cleaning, (1, 2, 3))
        self.assertFalse(task.done())
        self.assertFalse(self.started[4].is_set())
        self.manager._cleanup.assert_not_awaited()
        self.finish_cleanup[1].set()
        self.finish_cleanup[3].set()
        with self.assertRaises(ExceptionGroup):
            await asyncio.wait_for(task, 5)
        report = read_json(self.root / "pilot/gate.json")
        self.assertFalse(report["passed"])
        self.assertEqual(report["failure"], {"error": "ValueError", "trial_index": 2,
            "task": self.config.pilot_tasks[1], "directory": f"002-{self.config.pilot_tasks[1]}"})
        self.assertEqual(self.cleaned, {1, 2, 3})

    async def test_repeated_cancellation_waits_for_all_cleanup(self):
        task = self.start_stage()
        await self.wait_events(self.started, (1, 2, 3))
        task.cancel()
        await self.wait_events(self.cleaning, (1, 2, 3))
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.manager._cleanup.assert_not_awaited()
        for event in self.finish_cleanup.values():
            event.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        report = read_json(self.root / "pilot/gate.json")
        self.assertFalse(report["passed"])
        self.assertEqual(report["failure"]["error"], "CancelledError")
        self.assertEqual(self.cleaned, {1, 2, 3})
        self.assertFalse(self.started[4].is_set())

    async def test_worker_cancellation_cannot_pass_incomplete_coverage(self):
        self.failure_phase = "cancel"
        task = self.start_stage()
        await self.wait_events(self.started, (1, 2, 3))
        self.finish_run[2].set()
        await self.wait_events(self.cleaning, (2,))
        for event in (*self.finish_run.values(), *self.finish_cleanup.values()):
            event.set()
        with self.assertRaisesRegex(RuntimeError, "every selected trial"):
            await asyncio.wait_for(task, 5)
        self.assertFalse(read_json(self.root / "pilot/gate.json")["passed"])
        self.assertEqual(self.cleaned, {1, 2, 3})
        self.assertFalse(self.started[4].is_set())


if __name__ == "__main__":
    unittest.main()
