"""Run the pinned CLI through Harbor against a loopback faux provider."""

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import tomllib
import uuid

from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.execution import USER_MESSAGE_SUFFIX


async def smoke(platform: str) -> None:
    config = tomllib.loads(Path("smoke.toml").read_text())
    session_id = f"diffex-execution-{uuid.uuid4().hex[:12]}"
    trial = TrialPaths(Path("results", session_id).resolve())
    trial.mkdir()
    report = {"platform": platform, "image": config["images"][platform], "pins": PINS,
              "passed": False, "cleanup_passed": False, "trajectories": []}
    print(f"Execution evidence: {trial.trial_dir}", flush=True)
    with tempfile.TemporaryDirectory(prefix="diffex-execution-") as temp:
        directory = Path(temp)
        overlay = directory / "platform.yaml"
        overlay.write_text(f"services:\n  main:\n    platform: {platform}\n")
        environment = DockerEnvironment(
            environment_dir=directory, environment_name="diffex-execution-smoke", session_id=session_id,
            trial_paths=trial, task_env_config=EnvironmentConfig(docker_image=config["images"][platform]),
            extra_docker_compose=[overlay],
            mounts=[{"type": "bind", "source": str(trial.agent_dir), "target": "/logs/agent"}],
        )
        try:
            async with asyncio.timeout(config["environment_timeout_sec"]):
                await environment.start(force_build=False)
            agent = DiffexAgent(logs_dir=trial.agent_dir, model_name="openai/gpt-5", thinking="high",
                                extra_env={"OPENAI_API_KEY": "fixture-secret-never-log"})
            async with asyncio.timeout(PINS["setup_timeout_sec"] + 15):
                await agent.setup(environment)
            await environment.upload_file(Path("tests/faux-provider.cjs"), "/tmp/faux-provider.cjs")
            wrapper = directory / "diffex"
            wrapper.write_text(
                "#!/bin/sh\n"
                "/opt/diffex-terminal-bench/node/bin/node /tmp/faux-provider.cjs prepare\n"
                "exec /usr/local/bin/diffex-release \"$@\"\n"
            )
            await agent.exec_as_root(environment, command="mv /usr/local/bin/diffex /usr/local/bin/diffex-release")
            await environment.upload_file(wrapper, "/usr/local/bin/diffex")
            await agent.exec_as_root(environment, command="chmod 755 /usr/local/bin/diffex && mkdir -p /task/work/.diffex/extensions")
            # Task context must remain visible while executable resources and
            # project settings cannot replace the chosen benchmark harness.
            for name, content in {
                "AGENTS.md": "Task context marker: PRESERVE_TASK_CONTEXT\n",
                ".diffex/settings.json": '{"evolution":{"enabled":true},"defaultThinkingLevel":"off"}',
                ".diffex/SYSTEM.md": "DO_NOT_LOAD_PROJECT_SYSTEM",
                ".diffex/extensions/trap.mjs": 'throw new Error("DO_NOT_LOAD_PROJECT_EXTENSION");',
            }.items():
                source = directory / "resource"
                source.write_text(content)
                await environment.upload_file(source, f"/task/work/{name}")
            environment.task_env_config.workdir = "/task/work"
            await agent.exec_as_root(environment, command="nohup /opt/diffex-terminal-bench/node/bin/node /tmp/faux-provider.cjs >/tmp/faux-provider.log 2>&1 </dev/null &")
            await agent.exec_as_root(environment, command="wget --retry-connrefused --tries=20 --waitretry=1 -qO /dev/null http://127.0.0.1:8765/health")
            instruction = "\n  --literal @file 'single' \"double\" $HOME $(touch /task/work/INJECTED) `pwd`\r\nWrite shell.txt and result.txt. Unicode 雪.\n\n"
            run_dirs = []
            for subagents, user in (("disabled", None), ("disabled", None), ("enabled", None), ("disabled", "65534")):
                if user is not None:
                    await agent.exec_as_root(environment, command="chown -R 65534 /task/work")
                environment.default_user = user
                current = DiffexAgent(logs_dir=trial.agent_dir, model_name="openai/gpt-5", thinking="high", subagents=subagents,
                                      extra_env={"OPENAI_API_KEY": "fixture-secret-never-log"})
                before = set(trial.agent_dir.glob("run-*"))
                context = AgentContext()
                async with asyncio.timeout(60):
                    # Exercise Harbor's environment overlay as used by Trial.
                    with environment.scoped_exec_env({"ANTHROPIC_API_KEY": "unrelated-fixture-secret", "DIFFEX_CODING_AGENT_DIR": "/stale-state"}):
                        await current.run(instruction, environment, context)
                run_dir, = set(trial.agent_dir.glob("run-*")) - before
                run_dirs.append(run_dir)
                effective = json.loads((run_dir / "effective.json").read_text())
                assert effective["instruction_sha256"] == hashlib.sha256(instruction.encode()).hexdigest()
                assert effective["cwd"] == "/task/work"
                assert effective["model"] == "gpt-5" and effective["thinking"] == "high"
                prompt = (run_dir / "system-prompt.txt").read_text()
                assert USER_MESSAGE_SUFFIX.strip() not in prompt
                assert "PRESERVE_TASK_CONTEXT" in prompt and "DO_NOT_LOAD_PROJECT_SYSTEM" not in prompt
                assert effective["release_agents_sha256"] == PINS["release_agents_sha256"]
                initial = json.loads((run_dir / "fixture-start.json").read_text())
                assert effective["release_agents_path"] == "/opt/diffex-terminal-bench/cli/node_modules/@diffexai/diffex/dist/AGENTS.md"
                assert initial == {"state_entries": ["home", "settings.json"], "session_entries": [],
                                   "settings": {"evolution": {"enabled": False}}, "unrelated_credential_present": False}
                assert (run_dir / "sessions/root.jsonl").stat().st_size > 0
                state = json.loads((run_dir / "state.json").read_text())
                assert state["state_dir"].startswith("/tmp/diffex-tb-state-")
                assert not (run_dir / "state").exists()
                events = [json.loads(line) for line in (run_dir / "stdout.jsonl").read_text().splitlines()]
                assert not any(event.get("isError") for event in events)
                if subagents == "enabled":
                    assert len(list((run_dir / "sessions").rglob("*.jsonl"))) >= 2
                validator = TrajectoryValidator()
                assert validator.validate(trial.agent_dir / "trajectory.json"), validator.get_errors()
                trajectory = json.loads((trial.agent_dir / "trajectory.json").read_text())
                assert bool(trajectory.get("subagent_trajectories")) == (subagents == "enabled")
                messages = [record["message"] for path in (run_dir / "sessions").rglob("*.jsonl")
                            for line in path.read_text().splitlines() if (record := json.loads(line)).get("type") == "message"
                            and record["message"].get("role") == "assistant"]
                assert context.metadata["diffex_accounting"]["complete"], context.metadata["diffex_accounting"]
                assert context.n_input_tokens == len(messages) * 19
                assert context.n_output_tokens == len(messages) * 7
                assert context.n_cache_tokens == len(messages) * 5
                native_cost = sum(message["usage"]["cost"]["total"] for message in messages)
                assert abs(context.cost_usd - native_cost) < 1e-12 and native_cost > 0
                report["trajectories"].append({"run": run_dir.name, "validated": True, "context": context.model_dump()})
                # Contaminate the previous trial after it completes, proving
                # the next run never inherits auth, sessions, or harness state.
                await current.exec_as_agent(environment, command=shlex.join([
                    "/opt/diffex-terminal-bench/node/bin/node", "/tmp/faux-provider.cjs", "contaminate", state["state_dir"],
                ]))
            await agent.exec_as_root(environment, command="test ! -e /task/work/INJECTED && test \"$(cat cwd.txt)\" = /task/work && test \"$(cat shell.txt)\" = shell-ok && test \"$(cat result.txt)\" = file-ok && test \"$(cat child.txt)\" = child-ok")
            requests = [json.loads(line) for line in (trial.agent_dir / "fixture-requests.jsonl").read_text().splitlines()]
            assert requests and all(entry["credential_received"] for entry in requests)
            assert all(entry["body"]["reasoning_effort"] == "high" for entry in requests)
            for run_dir in run_dirs:
                remote_instruction = f"/logs/agent/{run_dir.name}/instruction.txt"
                expected_prompt = f'<file name="{remote_instruction}">\n{instruction}\n</file>\n{USER_MESSAGE_SUFFIX}'
                assert any(message.get("role") == "user" and message.get("content") in (expected_prompt, [{"type": "text", "text": expected_prompt}])
                           for entry in requests for message in entry["body"]["messages"])
                assert not any(USER_MESSAGE_SUFFIX.strip() in str(message.get("content", ""))
                               for entry in requests for message in entry["body"]["messages"]
                               if message.get("role") in ("system", "developer"))
            for run_dir in run_dirs:
                assert "STALE_HARNESS_SELECTION" not in (run_dir / "system-prompt.txt").read_text()
            for path in trial.agent_dir.rglob("*"):
                if path.is_file():
                    contents = path.read_bytes()
                    assert b"fixture-secret-never-log" not in contents, path
                    assert b"unrelated-fixture-secret" not in contents, path
            report.update(passed=True, trials=len(run_dirs), provider_requests=len(requests))
        finally:
            await environment.stop(delete=True)
            remaining = subprocess.check_output(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={session_id}"], text=True).strip()
            report["cleanup_passed"] = not remaining
            (trial.trial_dir / "smoke.json").write_text(json.dumps(report, indent=2) + "\n")
            if remaining:
                raise RuntimeError("Execution smoke container was not removed")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"), default="linux/amd64")
    args = parser.parse_args()
    asyncio.run(smoke(args.platform))
