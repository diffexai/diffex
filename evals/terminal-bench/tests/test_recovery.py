"""Harbor cancellation, transport failure, and unmounted log retention."""

import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import create_autospec
from unittest.mock import patch

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.outcome import DiffexControlStopError, DiffexExecutionError
from test_outcome import write_evidence
from test_trajectory import assistant, entry


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = Path(self.temp.name)
        self.environment = create_autospec(BaseEnvironment, instance=True)
        self.environment.default_user = None
        self.environment.capabilities.mounted = False
        self.environment.exec.return_value = ExecResult(return_code=0, stdout="", stderr="")
        self.environment.download_dir.side_effect = lambda source, target: write_evidence(Path(target))
        self.agent = DiffexAgent(logs_dir=self.logs, model_name="openai/gpt-5",
                                 extra_env={"OPENAI_API_KEY": "fixture-only"})
        self.context = AgentContext()

    async def test_downloads_unmounted_logs_and_records_outcome(self):
        await self.agent.run("Task", self.environment, self.context)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "completed")
        self.assertTrue(next(self.logs.glob("run-*/outcome.json")).is_file())
        self.assertTrue((self.logs / "trajectory.json").is_file())
        self.assertTrue(self.context.metadata["diffex_trajectory"]["validated"])

    async def test_export_failure_blocks_completed_run(self):
        with patch("diffex_terminal_bench.adapter.export_trajectory", side_effect=ValueError("fixture")):
            with self.assertRaises(DiffexExecutionError):
                await self.agent.run("Task", self.environment, self.context)
        self.assertEqual(self.context.metadata["diffex_outcome"]["reason"], "trajectory_export_failed")
        self.assertIsNone(self.context.n_input_tokens)

    async def test_complete_usage_populates_harbor_context(self):
        def download(source, target):
            write_evidence(Path(target))
            sessions = Path(target) / "sessions"
            sessions.mkdir()
            (sessions / "root.jsonl").write_text(json.dumps({"type": "session", "id": "root"}) + "\n"
                                               + json.dumps(entry("one", assistant("one"))) + "\n")
            # Match the complete assistant emitted in native persistence.
            events = [json.loads(line) for line in (Path(target) / "stdout.jsonl").read_text().splitlines()]
            for event in events:
                if "message" in event:
                    event["message"] = assistant("one")
                if "messages" in event:
                    event["messages"] = [assistant("one")]
            (Path(target) / "stdout.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))

        self.environment.download_dir.side_effect = download
        await self.agent.run("Task", self.environment, self.context)
        self.assertEqual(self.context.n_input_tokens, 19)
        self.assertEqual(self.context.n_output_tokens, 7)
        self.assertEqual(self.context.n_cache_tokens, 5)
        self.assertEqual(self.context.cost_usd, 0.125)

    async def test_timeout_waits_for_recovery_even_when_cancelled_twice(self):
        started = asyncio.Event()
        cleaning = asyncio.Event()
        finish_cleanup = asyncio.Event()

        async def execute(**kwargs):
            if "run.cjs" in kwargs["command"]:
                started.set()
                await asyncio.Event().wait()
            elif "cleanup.cjs" in kwargs["command"]:
                cleaning.set()
                await finish_cleanup.wait()
            return ExecResult(return_code=0, stdout="", stderr="")

        self.environment.exec.side_effect = execute
        task = asyncio.create_task(self.agent.run("Task", self.environment, self.context))
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        await asyncio.wait_for(cleaning.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        finish_cleanup.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "cancelled")
        self.assertTrue((self.logs / "trajectory.json").is_file())
        self.assertFalse(self.context.metadata["diffex_accounting"]["complete"])

    async def test_cancellation_during_collection_is_not_swallowed(self):
        collecting = asyncio.Event()
        release = asyncio.Event()

        async def download(source, target):
            collecting.set()
            await release.wait()
            write_evidence(Path(target))

        self.environment.download_dir.side_effect = download
        task = asyncio.create_task(self.agent.run("Task", self.environment, self.context))
        await asyncio.wait_for(collecting.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "cancelled")

    async def test_transport_failure_retains_logs_and_original_exception(self):
        async def execute(**kwargs):
            if "run.cjs" in kwargs["command"]:
                raise ConnectionError("controlled transport loss")
            return ExecResult(return_code=0, stdout="", stderr="")

        self.environment.exec.side_effect = execute
        with self.assertRaises(ConnectionError):
            await self.agent.run("Task", self.environment, self.context)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "transport_failure")

    async def test_cleanup_failure_still_collects_logs_and_fails_run(self):
        async def execute(**kwargs):
            return ExecResult(return_code=1 if "cleanup.cjs" in kwargs["command"] else 0, stdout="", stderr="")

        self.environment.exec.side_effect = execute
        with self.assertRaises(DiffexControlStopError):
            await self.agent.run("Task", self.environment, self.context)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "infrastructure_failure")

    async def test_log_collection_failure_is_recorded_locally(self):
        self.environment.download_dir.side_effect = ConnectionError("fixture")
        with self.assertRaises(DiffexControlStopError):
            await self.agent.run("Task", self.environment, self.context)
        record = json.loads(next(self.logs.glob("run-*/outcome.json")).read_text())
        self.assertEqual(record["recovery_errors"][0]["phase"], "log_collection")


if __name__ == "__main__":
    unittest.main()
