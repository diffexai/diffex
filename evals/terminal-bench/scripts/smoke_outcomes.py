"""Exercise real pinned CLI failures, retry recovery, and timeout cleanup in Harbor."""

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
import tomllib
import uuid

from harbor.agents.installed.base import AgentAuthenticationError
from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.dataset import load_config, prepare_dataset
from diffex_terminal_bench.gate import sha256
from diffex_terminal_bench.outcome import DiffexExecutionError


async def smoke(platform, source_image=None, grpc_fixture=False):
    config = tomllib.loads(Path("smoke.toml").read_text())
    session_id = f"diffex-outcomes-{uuid.uuid4().hex[:12]}"
    trial = TrialPaths(Path("results", session_id).resolve())
    trial.mkdir()
    report = {"platform": platform, "image": (source_image or config["images"][platform]), "pins": PINS,
              "qualification": "source-only" if source_image else "pinned-release",
              "passed": False, "cleanup_passed": False, "outcomes": []}
    print(f"Outcome evidence: {trial.trial_dir}", flush=True)
    with tempfile.TemporaryDirectory(prefix="diffex-outcomes-") as temp:
        directory = Path(temp)
        overlay = directory / "platform.yaml"
        overlay.write_text(f"services:\n  main:\n    platform: {platform}\n")
        environment = DockerEnvironment(
            environment_dir=directory, environment_name="diffex-outcomes-smoke", session_id=session_id,
            trial_paths=trial, task_env_config=EnvironmentConfig(docker_image=(source_image or config["images"][platform])),
            extra_docker_compose=[overlay],
            mounts=[{"type": "bind", "source": str(trial.agent_dir), "target": "/logs/agent"}],
        )
        try:
            await asyncio.wait_for(environment.start(force_build=False), config["environment_timeout_sec"])
            agent = DiffexAgent(logs_dir=trial.agent_dir, model_name="openai/gpt-5", thinking="high",
                                extra_env={"OPENAI_API_KEY": "fixture-secret-never-log"})
            if source_image:
                source_wrapper = directory / "source-cli"
                source_wrapper.write_text('#!/bin/sh\nexport TSX_TSCONFIG_PATH=/repo/tsconfig.json\nexec node --import /repo/node_modules/tsx/dist/loader.mjs /repo/packages/coding-agent/src/cli.ts "$@"\n')
                await environment.upload_file(source_wrapper, "/usr/local/bin/diffex")
                await agent.exec_as_root(environment, command="chmod 755 /usr/local/bin/diffex")
            else:
                await asyncio.wait_for(agent.setup(environment), PINS["setup_timeout_sec"] + 15)
            await environment.upload_file(Path("tests/faux-outcomes.cjs"), "/tmp/faux-outcomes.cjs")
            await environment.upload_file(Path("src/diffex_terminal_bench/cleanup.cjs"), "/tmp/faux-cleanup.cjs")
            wrapper = directory / "diffex"
            wrapper.write_text(
                '#!/bin/sh\n'
                '/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs prepare\n'
                'if [ "$(cat /tmp/outcome-scenario)" != interrupted-output ]; then\n'
                '  exec /usr/local/bin/diffex-release "$@"\n'
                'fi\n'
                '/usr/local/bin/diffex-release "$@"\n'
                'status=$?\n'
                '/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs interrupt-output\n'
                'exit "$status"\n'
            )
            await agent.exec_as_root(environment, command="mv /usr/local/bin/diffex /usr/local/bin/diffex-release")
            await environment.upload_file(wrapper, "/usr/local/bin/diffex")
            await agent.exec_as_root(environment, command="chmod 755 /usr/local/bin/diffex && mkdir -p /task/work && chmod 777 /task/work")
            environment.task_env_config.workdir = "/task/work"
            await agent.exec_as_root(environment, command="nohup /opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs >/tmp/faux-outcomes.log 2>&1 </dev/null &")
            await agent.exec_as_root(environment, command="/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs health")
            if grpc_fixture:
                await agent.exec_as_root(environment, command="mkdir -p /app /tests && chmod 777 /app")
                await environment.upload_file(Path("tests/fixtures/kv-store.proto"), "/app/kv-store.proto")
                await environment.upload_file(Path("tests/fixtures/grpc_server.py"), "/app/server.py")
                benchmark = load_config(Path("benchmark.toml"))
                with prepare_dataset(benchmark, Path("results/dataset-cache")) as (tasks, digests):
                    verifier = tasks["kv-store-grpc"] / "tests/test_outputs.py"
                    report["verifier"] = {"dataset": benchmark.dataset.model_dump(),
                                          "task_digest": digests["kv-store-grpc"], "test_sha256": sha256(verifier)}
                    await environment.upload_file(verifier, "/tests/test_outputs.py")
            for user in (None,) if grpc_fixture else (None, "65534"):
                environment.default_user = user
                scenarios = (("grpc", "completed", None),) if grpc_fixture else (
                    ("success", "completed", None),
                    ("service-failure", "provider_failure", DiffexExecutionError),
                    ("forced-death", "process_failure", DiffexExecutionError),
                    ("authentication", "authentication_failure", AgentAuthenticationError),
                    ("exhausted", "provider_failure", DiffexExecutionError),
                    ("recovered", "completed", None),
                    ("interrupted-output", "incomplete", DiffexExecutionError),
                    ("timeout", "cancelled", TimeoutError),
                )
                for scenario, expected, exception in scenarios:
                    source = directory / "scenario"
                    source.write_text(scenario)
                    await environment.upload_file(source, "/tmp/outcome-scenario")
                    context = AgentContext()
                    caught = None
                    try:
                        await asyncio.wait_for(agent.run("Perform the controlled task.", environment, context),
                                               timeout=10 if scenario == "timeout" else 60)
                    except (AgentAuthenticationError, DiffexExecutionError, TimeoutError) as exc:
                        caught = type(exc)
                    assert caught is exception, (scenario, caught, context)
                    outcome = context.metadata["diffex_outcome"]
                    assert outcome["status"] == expected, outcome
                    assert outcome["cleanup_confirmed"] is True, outcome
                    run_dir = trial.agent_dir / Path(context.metadata["diffex_run_dir"]).name
                    assert (run_dir / "stdout.jsonl").stat().st_size > 0
                    assert (run_dir / "stderr.log").exists()
                    assert (run_dir / "sessions/root.jsonl").stat().st_size > 0
                    assert (run_dir / "process.json").exists()
                    validator = TrajectoryValidator()
                    assert validator.validate(trial.agent_dir / "trajectory.json"), validator.get_errors()
                    assert context.metadata["diffex_trajectory"]["validated"]
                    if expected != "completed":
                        assert not context.metadata["diffex_accounting"]["complete"]
                        assert context.n_input_tokens is None and context.cost_usd is None
                    if scenario in ("authentication", "exhausted"):
                        assert outcome["process"]["exit_code"] == 1, outcome
                    if scenario == "interrupted-output":
                        assert outcome["process"]["exit_code"] == 0, outcome
                    if scenario == "recovered":
                        assert outcome["recovered_retries"] == 1, outcome
                    if scenario in ("success", "timeout", "service-failure", "forced-death", "grpc"):
                        verification = await agent.exec_as_agent(environment, command=
                            f"/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs verify-service {context.metadata['diffex_run_dir']}")
                        (run_dir / "service-verification.json").write_text(verification.stdout)
                        assert json.loads(verification.stdout)["verified"] is True
                        before = json.loads((run_dir / "service-before-exit.json").read_text())
                        after = json.loads(verification.stdout)
                        assert (before["pid"], before["start"]) == (after["pid"], after["start"])
                    if grpc_fixture:
                        verifier = await agent.exec_as_agent(environment, command=
                            "/opt/verifier/bin/python -m pytest /tests/test_outputs.py -v -p no:cacheprovider", timeout_sec=30)
                        (run_dir / "verifier.stdout.txt").write_text(verifier.stdout)
                        assert "7 passed" in verifier.stdout, verifier.stdout
                        # Check the same process again after all verifier RPCs.
                        await agent.exec_as_agent(environment, command=
                            f"/opt/diffex-terminal-bench/node/bin/node /tmp/faux-outcomes.cjs verify-service {context.metadata['diffex_run_dir']}")
                    report["outcomes"].append({"scenario": scenario, "user": user, "outcome": outcome,
                                               "trajectory_validated": True, "accounting": context.metadata["diffex_accounting"]})
                    print(f"{scenario} user={user}: {outcome['status']}, cleanup confirmed", flush=True)
            for path in trial.agent_dir.rglob("*"):
                if path.is_file():
                    assert b"fixture-secret-never-log" not in path.read_bytes(), path
            report["passed"] = True
        finally:
            await environment.stop(delete=True)
            remaining = subprocess.check_output(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={session_id}"], text=True).strip()
            report["cleanup_passed"] = not remaining
            (trial.trial_dir / "smoke.json").write_text(json.dumps(report, indent=2) + "\n")
            assert not remaining, "Outcome smoke container was not removed"
    print(f"Passed {len(report['outcomes'])} controlled outcome trials; container removed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"), default="linux/amd64")
    parser.add_argument("--source-image", help="Development-only image with /repo source and Linux dependencies; never qualifies release pins")
    parser.add_argument("--grpc-fixture", action="store_true", help="Run the known-correct service against all seven pinned verifier tests (requires source image)")
    args = parser.parse_args()
    if args.grpc_fixture and not args.source_image:
        parser.error("--grpc-fixture requires --source-image with the isolated verifier environment")
    asyncio.run(smoke(args.platform, args.source_image, args.grpc_fixture))
