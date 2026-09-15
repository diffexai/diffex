"""Execution contract tests without provider calls."""

import json
from importlib.resources import files
import os
from pathlib import Path, PurePosixPath
import tempfile
import unittest
from unittest.mock import create_autospec, patch

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.models.agent.context import AgentContext
from harbor.models.job.config import JobConfig
import yaml

from diffex_terminal_bench.adapter import DiffexAgent


class ExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # These tests isolate the launch contract; recovery has separate tests
        # and a Linux smoke using the real launcher and provider.
        async def finish_run(agent, environment, run_dir, context, execution):
            (agent.logs_dir / run_dir.name).mkdir(parents=True, exist_ok=True)
            return {"status": "completed"}

        finish = patch.object(DiffexAgent, "_finish_run", autospec=True, side_effect=finish_run)
        finish.start()
        self.addCleanup(finish.stop)
        export = patch("diffex_terminal_bench.adapter.export_trajectory", return_value={"complete": True})
        export.start()
        self.addCleanup(export.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.logs_dir = Path(temporary.name)

    def test_release_context_and_example_config(self):
        root = Path(__file__).resolve().parents[3]
        self.assertEqual(files("diffex_terminal_bench").joinpath("release-agents.md").read_bytes(),
                         (root / "AGENTS_release.md").read_bytes())
        config = JobConfig.model_validate(yaml.safe_load((Path(__file__).resolve().parents[1] / "execution.yaml").read_text()))
        self.assertEqual(config.agents[0].import_path, DiffexAgent.import_path())
        self.assertEqual(config.agents[0].model_name, "openai/gpt-5")
        DiffexAgent.preflight(config.agents[0].kwargs)

    def make_environment(self):
        environment = create_autospec(BaseEnvironment, instance=True)
        environment.default_user = None
        environment.exec.return_value = ExecResult(return_code=0, stdout="", stderr="")
        return environment

    async def test_prompt_environment_and_fresh_trial_paths(self):
        environment = self.make_environment()
        uploads = {}

        async def upload(source, target):
            uploads[target] = Path(source).read_bytes()

        environment.upload_file.side_effect = upload
        instruction = "\n  --literal @file 'quote' \"double\" $HOME $(touch /tmp/injected) `pwd`\nUnicode: 雪\n\n"
        with patch.dict(os.environ, {"OPENAI_API_KEY": "host-secret", "ANTHROPIC_API_KEY": "unrelated-secret"}, clear=True):
            agent = DiffexAgent(
                logs_dir=self.logs_dir, model_name="openai/gpt-5", thinking="high",
                extra_env={"OPENAI_API_KEY": "selected-secret", "DIFFEX_CODING_AGENT_DIR": "/stale"},
                environment_logs_dir=PurePosixPath("/logs/agent custom"),
            )
            for _ in range(2):
                await agent.run(instruction, environment, AgentContext())
        prompts = [value.decode() for key, value in uploads.items() if key.endswith("instruction.txt")]
        self.assertEqual(prompts, [instruction, instruction])
        configs = [json.loads(value) for key, value in uploads.items() if key.endswith("requested.json")]
        self.assertEqual(len(configs), 2)
        self.assertEqual(configs[0]["credential_env_names"], ["OPENAI_API_KEY"])
        self.assertNotIn("spawn_agent", configs[0]["tools"])
        self.assertEqual(configs[0]["evolution"], {"enabled": False})
        calls = [call.kwargs for call in environment.exec.call_args_list if call.kwargs.get("env")]
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call["env"], {"OPENAI_API_KEY": "selected-secret", "DIFFEX_TB_PROVIDER": "openai",
                                           "DIFFEX_TB_MODEL": "gpt-5", "DIFFEX_TB_THINKING": "high"})
            self.assertIsNone(call["cwd"])
            self.assertIsNone(call["user"])
            self.assertIn("</dev/null", call["command"])
            self.assertNotIn(instruction, call["command"])
        serialized = b"".join(uploads.values()).decode()
        for secret in ("selected-secret", "host-secret", "unrelated-secret", "/stale"):
            self.assertNotIn(secret, serialized)

    async def test_subagents_are_explicit_and_nonroot_uploads_are_owned(self):
        environment = self.make_environment()
        environment.default_user = "1000"
        configs = []

        async def upload(source, target):
            if target.endswith("requested.json"):
                configs.append(json.loads(Path(source).read_text()))

        environment.upload_file.side_effect = upload
        agent = DiffexAgent(logs_dir=self.logs_dir, model_name="openai/gpt-5", subagents="enabled",
                            extra_env={"OPENAI_API_KEY": "test-only"})
        await agent.run("Task", environment, AgentContext())
        self.assertTrue({"spawn_agent", "agent_action", "agents"}.issubset(configs[0]["tools"]))
        self.assertTrue(any("chown -R 1000" in call.kwargs["command"] for call in environment.exec.call_args_list))

    async def test_missing_credentials_and_ambiguous_models_fail_before_exec(self):
        with patch.dict(os.environ, {}, clear=True):
            for model in (None, "gpt-5", "openai/*", "openai/gpt-5:high", "unsupported/model", "openai/gpt-5"):
                environment = self.make_environment()
                agent = DiffexAgent(logs_dir=Path("unused"), model_name=model)
                with self.assertRaises(ValueError):
                    await agent.run("Task", environment, AgentContext())
                environment.exec.assert_not_called()

    def test_preflight_rejects_implicit_or_unsafe_policy(self):
        for kwargs in ({"thinking": "automatic"}, {"tools": "bash,bash"}, {"tools": "spawn_agent"},
                       {"project_resources": "all"}, {"subagents": True}, {"unknown": "option"},
                       {"config": {"evolution": {"enabled": True}}}, {"prompt_template_path": "template.txt"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                DiffexAgent.preflight(kwargs)


if __name__ == "__main__":
    unittest.main()
