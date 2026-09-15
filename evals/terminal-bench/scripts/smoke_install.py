"""Exercise the real Harbor setup contract in a clean Linux container."""

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import tempfile
import time
import tomllib
import uuid

from harbor.environments.docker.docker import DockerEnvironment
from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.config import PINS


async def smoke(config_path: Path, output: Path, platform: str | None) -> None:
    config = tomllib.loads(config_path.read_text())
    selected_platform = platform or config["platform"]
    if selected_platform not in ("linux/amd64", "linux/arm64"):
        raise ValueError("Smoke platform must be linux/amd64 or linux/arm64")
    session_id = f"diffex-install-{uuid.uuid4().hex[:12]}"
    trial = TrialPaths(output.resolve() / session_id)
    trial.mkdir()
    report = {
        "session_id": session_id,
        "image": config["images"][selected_platform],
        "platform": selected_platform,
        "pins": PINS,
        "setup_passed": False,
        "cleanup_passed": False,
    }
    print(f"Installation evidence: {trial.trial_dir}", flush=True)
    with tempfile.TemporaryDirectory(prefix="diffex-smoke-environment-") as temp:
        environment_dir = Path(temp)
        overlay = environment_dir / "platform.yaml"
        overlay.write_text(f"services:\n  main:\n    platform: {selected_platform}\n")
        environment = DockerEnvironment(
            environment_dir=environment_dir,
            environment_name="diffex-install-smoke",
            session_id=session_id,
            trial_paths=trial,
            task_env_config=EnvironmentConfig(docker_image=config["images"][selected_platform]),
            extra_docker_compose=[overlay],
            mounts=[{
                "type": "bind", "source": str(trial.agent_dir), "target": "/logs/agent",
            }],
        )
        agent = DiffexAgent(logs_dir=trial.agent_dir)
        try:
            async with asyncio.timeout(config["environment_timeout_sec"]):
                await environment.start(force_build=False)
            # Inspect actual mounts, not just the requested Harbor config.
            containers = subprocess.check_output(
                ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={session_id}"],
                text=True,
            ).split()
            if len(containers) != 1:
                raise RuntimeError(f"Expected one smoke container, found {containers}")
            inspection = json.loads(subprocess.check_output(
                ["docker", "inspect", containers[0]], text=True
            ))[0]
            report["container_image_id"] = inspection["Image"]
            report["mounts"] = inspection["Mounts"]
            if len(inspection["Mounts"]) != 1:
                raise RuntimeError("Expected only the agent log directory to be mounted")
            for mount in inspection["Mounts"]:
                if mount["Type"] != "bind" or not Path(mount["Source"]).is_relative_to(trial.trial_dir):
                    raise RuntimeError(f"Unexpected smoke mount: {mount}")
            started = time.monotonic()
            async with asyncio.timeout(PINS["setup_timeout_sec"] + 15):
                await agent.setup(environment)
            report["setup_wall_time_sec"] = round(time.monotonic() - started, 3)
            evidence = json.loads((trial.agent_dir / "setup/installation.json").read_text())
            if not evidence["verified"]:
                raise RuntimeError("Installer did not produce verified evidence")
            expected_arch = "x64" if selected_platform == "linux/amd64" else "arm64"
            if evidence["node_arch"] != expected_arch:
                raise RuntimeError("Installed Node architecture differs from the smoke platform")
            if report["setup_wall_time_sec"] >= PINS["setup_timeout_sec"]:
                raise RuntimeError("Harbor setup exceeded the configured deadline")
            report["setup_passed"] = True
        except Exception as error:
            report["error_type"] = type(error).__name__
            raise
        finally:
            await environment.stop(delete=True)
            remaining = subprocess.check_output(
                ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={session_id}"],
                text=True,
            ).strip()
            report["cleanup_passed"] = not remaining
            (trial.trial_dir / "smoke.json").write_text(json.dumps(report, indent=2) + "\n")
            if remaining:
                raise RuntimeError(f"Smoke containers were not removed: {remaining}")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("smoke.toml"))
    parser.add_argument("--output", type=Path, default=Path("results"))
    parser.add_argument("--platform", choices=("linux/amd64", "linux/arm64"))
    args = parser.parse_args()
    asyncio.run(smoke(args.config, args.output, args.platform))
