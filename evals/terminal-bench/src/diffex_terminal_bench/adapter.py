"""Harbor setup contract; benchmark execution is a separate implementation step."""

from importlib.metadata import version
from importlib.resources import as_file, files
import shlex

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from diffex_terminal_bench.config import PINS


class DiffexAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "diffex"

    def version(self) -> str:
        return PINS["diffex_version"]

    async def install(self, environment: BaseEnvironment) -> None:
        if version("harbor") != PINS["harbor_version"]:
            raise RuntimeError("Harbor version differs from pins.toml; run uv sync --locked")
        if self._version not in (None, PINS["diffex_version"]):
            raise ValueError("Change pins.toml to select a different Diffex release")

        remote_dir = "/installed-agent/diffex-terminal-bench"
        logs_dir = str(self.environment_logs_dir / "setup")
        await self.exec_as_root(
            environment,
            command=f"mkdir -p {remote_dir} {shlex.quote(logs_dir)}",
            timeout_sec=10,
        )
        for filename in ("install.sh", "verify-install.cjs"):
            with as_file(files(__package__).joinpath(filename)) as source:
                await environment.upload_file(source, f"{remote_dir}/{filename}")

        # An empty environment keeps task npm configuration and credentials out
        # of setup. The wrapper installed below binds Diffex to the pinned Node.
        env = {
            "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "HOME": "/opt/diffex-terminal-bench/home",
            "DEBIAN_FRONTEND": "noninteractive",
            "NODE_VERSION": PINS["node_version"],
            "NODE_SHA256_X64": PINS["node_sha256"]["x64"],
            "NODE_SHA256_ARM64": PINS["node_sha256"]["arm64"],
            "DIFFEX_VERSION": PINS["diffex_version"],
            "DIFFEX_INTEGRITY": PINS["diffex_integrity"],
            "NPM_REGISTRY": PINS["npm_registry"],
            "HARBOR_VERSION": PINS["harbor_version"],
            "SETUP_TIMEOUT_SEC": str(PINS["setup_timeout_sec"]),
            "SETUP_LOGS": logs_dir,
        }
        command = shlex.join([
            "env", "-i", *(f"{key}={value}" for key, value in env.items()),
            "timeout", "--signal=TERM", "--kill-after=10",
            str(PINS["setup_timeout_sec"]), "bash", f"{remote_dir}/install.sh",
        ])
        await self.exec_as_root(
            environment,
            command=command,
            timeout_sec=PINS["setup_timeout_sec"] + 15,
        )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        raise NotImplementedError(
            "This adapter currently validates installation only. "
            "Task execution, trial isolation, and outcome parsing are not implemented."
        )
