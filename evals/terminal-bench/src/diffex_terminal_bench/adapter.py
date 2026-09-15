"""Pinned Harbor installation and isolated headless execution."""

from importlib.metadata import version
from importlib.resources import as_file, files
import asyncio
import shlex
import hashlib
import json
from pathlib import Path, PurePosixPath
import tempfile
import uuid

from harbor.agents.installed.base import BaseInstalledAgent, NonZeroAgentExitCodeError
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.execution import ExecutionOptions, PROVIDER_ENV, SUBAGENT_TOOLS
from diffex_terminal_bench.outcome import parse_outcome, require_completed


class DiffexAgent(BaseInstalledAgent):
    options_model = ExecutionOptions

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
        if version("harbor") != PINS["harbor_version"] or self._version not in (None, PINS["diffex_version"]):
            raise ValueError("Execution requires the checked-in Harbor and Diffex pins")
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("model_name must be an exact provider/model ID")
        provider, model = self.model_name.split("/", 1)
        if provider not in PROVIDER_ENV or not model or any(char in model for char in "*?:\n\r"):
            raise ValueError("Select a supported provider and exact model ID without a thinking suffix")
        if not instruction.strip():
            raise ValueError("The trial instruction must not be empty")
        if self.mcp_servers or self.skills_dir:
            raise ValueError("Task MCP servers and injected skills are outside the context-only policy")
        credentials = {
            name: value for name in PROVIDER_ENV[provider]
            if (value := self._get_env(name))
        }
        if not credentials:
            raise ValueError(f"Missing provider credentials: set one of {', '.join(PROVIDER_ENV[provider])}")
        options = self.options
        if not isinstance(options, ExecutionOptions):
            raise TypeError("Expected validated execution options")
        tools = options.tools.split(",")
        if options.subagents == "enabled":
            tools.extend(SUBAGENT_TOOLS)
        run_dir = self.environment_logs_dir / f"run-{uuid.uuid4().hex}"
        requested = {
            "pins": PINS, "provider": provider, "model": model,
            "thinking": options.thinking, "tools": tools,
            "subagents": options.subagents, "project_resources": options.project_resources,
            "evolution": {"enabled": False}, "state_policy": "fresh-per-run",
            "credential_env_names": sorted(credentials),
            "instruction_sha256": hashlib.sha256(instruction.encode("utf-8")).hexdigest(),
        }
        await self.exec_as_root(environment, command=f"umask 077 && mkdir -p {shlex.quote(str(self.environment_logs_dir))} && mkdir {shlex.quote(str(run_dir))}")
        with tempfile.TemporaryDirectory(prefix="diffex-trial-") as temp:
            for name, content in (("instruction.txt", instruction), ("requested.json", json.dumps(requested, indent=2))):
                source = Path(temp, name)
                source.write_text(content, encoding="utf-8")
                await environment.upload_file(source, str(run_dir / name))
            for name in ("run.cjs", "cleanup.cjs", "observe.mjs", "release-agents.md"):
                with as_file(files(__package__).joinpath(name)) as source:
                    await environment.upload_file(source, str(run_dir / name))
        # Uploads may be root-owned even when the task selects a non-root user.
        if environment.default_user is not None:
            await self.exec_as_root(environment, command=f"chown -R {shlex.quote(str(environment.default_user))} {shlex.quote(str(run_dir))}")
        # Credentials travel only through Harbor's env parameter. The launcher
        # discards all unselected inherited variables before starting Diffex.
        execution = {"interruption": None, "launcher_exit_code": None}
        try:
            result = await self.exec_as_agent(
                environment,
                command="umask 077; " + shlex.join(["/opt/diffex-terminal-bench/node/bin/node", str(run_dir / "run.cjs"), str(run_dir)])
                + f" </dev/null >{shlex.quote(str(run_dir / 'launcher.stdout.log'))} 2>{shlex.quote(str(run_dir / 'launcher.stderr.log'))}",
                env={**credentials, "DIFFEX_TB_PROVIDER": provider,
                     "DIFFEX_TB_MODEL": model, "DIFFEX_TB_THINKING": options.thinking},
            )
            execution["launcher_exit_code"] = result.return_code
        except NonZeroAgentExitCodeError:
            # The persisted process status and stream provide the actual cause.
            execution["launcher_exit_code"] = 1
        except asyncio.CancelledError:
            execution["interruption"] = "cancelled"
            raise
        except TimeoutError:
            execution["interruption"] = "timeout"
            raise
        except Exception:
            execution["interruption"] = "transport_failure"
            raise
        finally:
            # Harbor cancels run() at the task deadline. An independent exec
            # must stop the remote process before Harbor downloads logs/verifies.
            finish = asyncio.create_task(self._finish_run(
                environment, run_dir, context, execution,
            ))
            while not finish.done():
                try:
                    await asyncio.shield(finish)
                except asyncio.CancelledError:
                    # A second cancellation must not abandon remote cleanup.
                    execution["interruption"] = execution["interruption"] or "cancelled"
            outcome = finish.result()
            # A deadline can arrive just as recovery completes.
            if execution["interruption"]:
                outcome.update(status=execution["interruption"], interruption=execution["interruption"],
                               reason="execution_interrupted")
            (self.logs_dir / run_dir.name / "outcome.json").write_text(json.dumps(outcome, indent=2) + "\n")
        if execution["interruption"] == "cancelled":
            raise asyncio.CancelledError
        require_completed(outcome)

    async def _finish_run(self, environment: BaseEnvironment, run_dir: PurePosixPath,
                          context: AgentContext, execution: dict) -> dict:
        directory = self.logs_dir / run_dir.name
        directory.mkdir(parents=True, exist_ok=True)
        failures = []
        try:
            await asyncio.wait_for(self.exec_as_agent(
                environment,
                command=shlex.join(["/opt/diffex-terminal-bench/node/bin/node", str(run_dir / "cleanup.cjs"), str(run_dir)]),
                timeout_sec=10,
            ), timeout=15)
        except Exception as exc:
            failures.append({"phase": "cleanup", "error": type(exc).__name__})
        try:
            if environment.capabilities.mounted:
                await asyncio.wait_for(environment.prepare_logs_for_host(), timeout=15)
            else:
                await asyncio.wait_for(environment.download_dir(str(run_dir), directory), timeout=30)
        except Exception as exc:
            failures.append({"phase": "log_collection", "error": type(exc).__name__})
        outcome = parse_outcome(directory, execution["interruption"], execution["launcher_exit_code"])
        if failures:
            outcome["recovery_errors"] = failures
            if not execution["interruption"]:
                outcome.update(status="infrastructure_failure", reason="recovery_failed")
        context.metadata = {**(context.metadata or {}), "diffex_outcome": outcome, "diffex_run_dir": str(run_dir)}
        # The caller writes the summary to host logs after shielded recovery.
        # Do not upload a second copy that could overwrite a later cancellation
        # classification when Harbor collects the remote tree again.
        return outcome
