"""Harbor cancellation, transport failure, and unmounted log retention."""

import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, create_autospec
from unittest.mock import patch

from daytona.common.errors import DaytonaAuthenticationError, DaytonaConnectionError, DaytonaError
from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import TaskConfig
from harbor.trial.single_step import SingleStepTrial

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.outcome import DiffexControlStopError, DiffexExecutionError
from diffex_terminal_bench.transport import retry_transport
from test_outcome import attempt, write_evidence
from test_trajectory import assistant, entry


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.logs = Path(self.temp.name)
        self.environment = create_autospec(BaseEnvironment, instance=True)
        self.environment.default_user = None
        self.environment.capabilities.mounted = False
        remote = self.logs / "remote"
        write_evidence(remote)
        self.evidence = {path.name: path.read_text() for path in remote.iterdir()
                         if path.name in ("cleanup.json", "stop-requested", "launcher.json", "cli.json", "process.json")}
        self.environment.exec.side_effect = lambda **kwargs: self.exec_result(kwargs)
        self.environment.download_dir.side_effect = lambda source, target: write_evidence(Path(target))
        self.agent = DiffexAgent(logs_dir=self.logs, model_name="openai/gpt-5",
                                 extra_env={"OPENAI_API_KEY": "fixture-only"})
        self.context = AgentContext()

    def exec_result(self, kwargs, return_code=0):
        return ExecResult(return_code=return_code,
                          stdout=json.dumps(self.evidence) if "evidence.cjs" in kwargs["command"] else "", stderr="")

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
            return self.exec_result(kwargs)

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
            return self.exec_result(kwargs)

        self.environment.exec.side_effect = execute
        with self.assertRaises(ConnectionError):
            await self.agent.run("Task", self.environment, self.context)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "transport_failure")

    async def test_cleanup_rpc_failure_with_valid_evidence_permits_run(self):
        async def execute(**kwargs):
            if "cleanup.cjs" in kwargs["command"]:
                raise ConnectionError("lost cleanup response")
            return self.exec_result(kwargs)

        self.environment.exec.side_effect = execute
        await self.agent.run("Task", self.environment, self.context)
        self.environment.download_dir.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "completed")
        self.assertEqual(self.context.metadata["diffex_outcome"]["recovery_errors"][0]["phase"], "cleanup")

    async def test_log_collection_failure_is_recorded_locally(self):
        self.environment.download_dir.side_effect = ConnectionError("fixture")
        with self.assertRaises(DiffexExecutionError):
            await self.agent.run("Task", self.environment, self.context)
        record = json.loads(next(self.logs.glob("run-*/outcome.json")).read_text())
        self.assertTrue(record["agent_execution_stopped"])
        self.assertEqual(record["artifact_errors"][0]["phase"], "log_collection")

    async def test_bulk_timeout_with_valid_shutdown_reaches_harbor_verifier(self):
        remote = self.logs / "remote"
        write_evidence(remote)
        evidence = {str(path.relative_to(remote)): path.read_text() for path in remote.rglob("*")
                    if path.is_file() and path.name in
                    ("cleanup.json", "stop-requested", "launcher.json", "cli.json", "process.json")}

        async def execute(**kwargs):
            return ExecResult(return_code=0, stdout=json.dumps(evidence) if "evidence.cjs" in kwargs["command"] else "", stderr="")

        self.environment.exec.side_effect = execute
        self.environment.download_dir.side_effect = TimeoutError("bulk archive timed out")
        trial = create_autospec(SingleStepTrial, instance=True)
        trial.task = Mock(config=TaskConfig())
        trial._agent_timeout_sec = 1
        trial._load_trajectory = None
        trial.result = self.context

        async def agent_phase(**kwargs):
            await self.agent.run("Task", self.environment, self.context)

        async def run_agent():
            await SingleStepTrial._run_agent(trial)

        trial._run_agent_phase.side_effect = agent_phase
        trial._run_agent.side_effect = run_agent
        await SingleStepTrial._run(trial)
        trial._run_verifier.assert_awaited_once()
        outcome = self.context.metadata["diffex_outcome"]
        self.assertTrue(outcome["agent_execution_stopped"])
        self.assertEqual(outcome["status"], "artifact_collection_failure")
        self.assertEqual(outcome["artifact_errors"][0]["phase"], "log_collection")

    async def test_deadline_with_failed_cleanup_blocks_real_harbor_verifier_path(self):
        self.evidence["cleanup.json"] = json.dumps({"agent_execution_stopped": False})

        async def execute(**kwargs):
            if "run.cjs" in kwargs["command"]:
                await asyncio.Event().wait()
            return self.exec_result(kwargs, return_code=1 if "cleanup.cjs" in kwargs["command"] else 0)

        self.environment.exec.side_effect = execute
        trial = create_autospec(SingleStepTrial, instance=True)
        trial._agent_timeout_sec = 1
        trial._load_trajectory = None
        trial.result = self.context
        trial.task = Mock()

        async def agent_phase(**kwargs):
            await asyncio.wait_for(self.agent.run("Task", self.environment, self.context), 0.05)

        trial._run_agent_phase.side_effect = agent_phase
        with self.assertRaises(DiffexControlStopError):
            await SingleStepTrial._run_agent(trial)
        trial._record_exception.assert_not_called()
        trial._sync_agent_output.assert_awaited_once()
        self.assertEqual(self.context.metadata["diffex_outcome"]["status"], "cancelled")

    async def test_evidence_is_validated_before_bulk_download(self):
        def download(source, target):
            self.assertTrue(any("evidence.cjs" in call.kwargs["command"]
                                for call in self.environment.exec.call_args_list))
            # A partial extraction must not invalidate the independent evidence.
            Path(target, "cleanup.json").write_text("broken")
            raise TimeoutError("bulk failed")

        self.environment.download_dir.side_effect = download
        with self.assertRaises(DiffexExecutionError):
            await self.agent.run("Task", self.environment, self.context)
        self.assertTrue(self.context.metadata["diffex_outcome"]["agent_execution_stopped"])
        self.assertEqual(json.loads(next(self.logs.glob("run-*/cleanup.json")).read_text())["phase"], "pre-verifier")

    async def test_invalid_evidence_blocks_even_if_bulk_later_contains_valid_cleanup(self):
        valid = dict(self.evidence)
        for name, content in (("cleanup.json", "{}"), ("launcher.json", "{}"),
                              ("ownership/unexpected.json", "{}"), ("../escape", "bad")):
            with self.subTest(name=name):
                self.evidence = {**valid, name: content}
                with self.assertRaises(DiffexControlStopError):
                    await self.agent.run("Task", self.environment, self.context)
                self.assertFalse(self.context.metadata["diffex_outcome"]["agent_execution_stopped"])

    async def test_evidence_transient_failure_retries_before_collection(self):
        attempts = 0

        async def execute(**kwargs):
            nonlocal attempts
            if "evidence.cjs" in kwargs["command"]:
                attempts += 1
                self.environment.download_dir.assert_not_awaited()
                if attempts < 3:
                    raise DaytonaConnectionError("temporary")
            return self.exec_result(kwargs)

        self.environment.exec.side_effect = execute
        with patch("diffex_terminal_bench.transport.asyncio.sleep") as sleep:
            await self.agent.run("Task", self.environment, self.context)
        self.assertEqual(attempts, 3)
        self.assertEqual(sleep.await_count, 2)

    async def test_evidence_retry_exhaustion_still_blocks_verification(self):
        async def execute(**kwargs):
            if "evidence.cjs" in kwargs["command"]:
                raise TimeoutError("temporary")
            return self.exec_result(kwargs)

        self.environment.exec.side_effect = execute
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            with self.assertRaises(DiffexControlStopError):
                await self.agent.run("Task", self.environment, self.context)
        self.assertEqual(sum("evidence.cjs" in call.kwargs["command"]
                             for call in self.environment.exec.call_args_list), 3)

    async def test_pending_cleanup_publication_is_retried(self):
        attempts = 0

        async def execute(**kwargs):
            nonlocal attempts
            if "cleanup.cjs" in kwargs["command"]:
                raise ConnectionError("response lost while cleanup continues")
            if "evidence.cjs" in kwargs["command"]:
                attempts += 1
                if attempts == 1:
                    return ExecResult(return_code=0, stdout="null", stderr="")
            return self.exec_result(kwargs)

        self.environment.exec.side_effect = execute
        with patch("diffex_terminal_bench.transport.asyncio.sleep"):
            await self.agent.run("Task", self.environment, self.context)
        self.assertEqual(attempts, 2)
        self.assertTrue(self.context.metadata["diffex_outcome"]["agent_execution_stopped"])

    async def test_local_artifact_write_failure_preserves_shutdown(self):
        for phase in ("evidence_persistence", "outcome_persistence"):
            with self.subTest(phase=phase):
                original = Path.write_text

                def write(path, *args, **kwargs):
                    if path.name == "outcome.json":
                        raise OSError("disk full")
                    return original(path, *args, **kwargs)

                target = "diffex_terminal_bench.adapter.shutil.copytree" if phase == "evidence_persistence" else "pathlib.Path.write_text"
                with patch(target, side_effect=OSError("disk full")) if phase == "evidence_persistence" else patch(target, write):
                    with self.assertRaises(DiffexExecutionError):
                        await self.agent.run("Task", self.environment, self.context)
                outcome = self.context.metadata["diffex_outcome"]
                self.assertTrue(outcome["agent_execution_stopped"])
                self.assertIn(phase, [error["phase"] for error in outcome["artifact_errors"]])

    async def test_partial_download_preserves_conclusive_provider_failure(self):
        def download(source, target):
            write_evidence(Path(target), attempt("error", "503 provider failed"))
            raise TimeoutError("later artifact transfer failed")

        self.environment.download_dir.side_effect = download
        with self.assertRaises(DiffexExecutionError):
            await self.agent.run("Task", self.environment, self.context)
        outcome = self.context.metadata["diffex_outcome"]
        self.assertEqual(outcome["status"], "provider_failure")
        self.assertTrue(outcome["agent_execution_stopped"])
        self.assertEqual(outcome["artifact_errors"][0]["phase"], "log_collection")

    async def test_transport_retry_respects_rate_limit_and_permanent_errors(self):
        for error, count in ((DaytonaAuthenticationError("denied", status_code=401), 1),
                             (DaytonaError("limited", status_code=429, headers={"Retry-After-authenticated": "5"}), 3)):
            operation = create_autospec(self.agent._finish_run, side_effect=error)
            with patch("diffex_terminal_bench.transport.asyncio.sleep") as sleep:
                with self.assertRaises(type(error)):
                    await retry_transport(lambda: operation(None, None, None, None))
            self.assertEqual(operation.await_count, count)
            if count == 3:
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 5])


if __name__ == "__main__":
    unittest.main()
