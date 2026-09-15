"""Repeatable Daytona qualification stages with retained evidence."""

import argparse
import asyncio
from datetime import datetime, timezone
from importlib.metadata import version
import os
from pathlib import Path
import platform
import signal
import subprocess
import uuid

from daytona import AsyncDaytona
from harbor.environments.daytona.environment import DaytonaClientManager
from harbor.models.trial.config import AgentConfig, EnvironmentConfig, TaskConfig, TrialConfig
from harbor.publisher.packager import Packager
from harbor.trial.trial import Trial

from diffex_terminal_bench.adapter import DiffexAgent
from diffex_terminal_bench.config import PINS
from diffex_terminal_bench.dataset import BenchmarkConfig, load_config, prepare_dataset
from diffex_terminal_bench.daytona_backend import confirm_cleanup
from diffex_terminal_bench.diagnostics import TrialExecutionFailure, describe_failure, diagnose_trial
from diffex_terminal_bench.execution import PROVIDER_ENV
from diffex_terminal_bench.gate import STAGES, fingerprint, inventory, require_previous, sha256, stage_tasks, validate_trial, write_json
from diffex_terminal_bench.summary import refresh_index, write_index


PACKAGE = Path(__file__).resolve().parents[2]
REPOSITORY = PACKAGE.parents[1]


class StageFailedError(RuntimeError):
    """Expected qualification failure after all started trials are cleaned up."""


def preflight(config: BenchmarkConfig, *, oracle: bool) -> None:
    if version("harbor") != PINS["harbor_version"] or version("daytona") != "0.210.0":
        raise ValueError("Run uv sync --locked to install the pinned Harbor/Daytona versions")
    if not os.environ.get("DAYTONA_API_KEY"):
        raise ValueError("Set DAYTONA_API_KEY through your secret-loading mechanism")
    if not oracle and not any(os.environ.get(name) for name in PROVIDER_ENV[config.model.split("/", 1)[0]]):
        raise ValueError("Set the selected provider credential through your secret-loading mechanism")


def run_identity(config: BenchmarkConfig, digests: dict) -> dict:
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=REPOSITORY, text=True)
    if status.strip():
        raise ValueError("Qualification requires a clean committed checkout")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPOSITORY, text=True).strip()
    return {"adapter_commit": commit, "dataset": config.dataset.model_dump(), "task_digests": digests,
            "pins": PINS, "harbor_version": version("harbor"), "daytona_version": version("daytona"),
            "python_version": platform.python_version(), "uv_lock_sha256": sha256(PACKAGE / "uv.lock"),
            "model": config.model, "policy": config.policy.model_dump(include={"thinking", "tools", "subagents", "project_resources"}),
            "pilot_tasks": config.pilot_tasks, "backend": "daytona",
            "daytona_target": os.environ.get("DAYTONA_TARGET", "organization-default"),
            "daytona_api_url": os.environ.get("DAYTONA_API_URL", "https://app.daytona.io/api"),
            "harness_files": {path.name: sha256(path) for path in sorted(Path(__file__).parent.iterdir()) if path.is_file()},
            "release_agents_sha256": sha256(Path(__file__).with_name("release-agents.md")),
            "timeout_multiplier": 1.0, "resource_overrides": None, "concurrency": config.concurrency, "harbor_retries": 0}


def trial_config(config: BenchmarkConfig, task_path: Path, directory: Path, label: str, *, oracle: bool) -> TrialConfig:
    agent = AgentConfig(name="oracle") if oracle else AgentConfig(
        import_path=DiffexAgent.import_path(), model_name=config.model,
        override_setup_timeout_sec=630,
        kwargs=config.policy.model_dump(include={"thinking", "tools", "subagents", "project_resources"}),
        # Variable references are serialized, never credential values. Harbor
        # also uses these names to scrub accidental credential output from logs.
        env={name: f"${{{name}}}" for name in PROVIDER_ENV[config.model.split("/", 1)[0]] if os.environ.get(name)},
    )
    return TrialConfig(task=TaskConfig(path=task_path, source=f"{config.dataset.name}@{config.dataset.version}"),
                       trial_name=directory.name, trials_dir=directory.parent, agent=agent,
                       environment=EnvironmentConfig(import_path="diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment",
                           delete=True, kwargs={"labels": {"diffex.gate_trial": label}}))


async def run_stage(config: BenchmarkConfig, tasks: dict[str, Path], identity: dict, root: Path, stage: str) -> None:
    require_previous(root, stage, identity, config.pilot_tasks, list(tasks))
    selected = stage_tasks(stage, config.pilot_tasks, list(tasks))
    directory = root / stage
    directory.mkdir(parents=True)  # Never overwrite a previous attempt.
    report = {"schema_version": 1, "stage": stage, "identity": identity, "identity_sha256": fingerprint(identity),
              "started_at": datetime.now(timezone.utc).isoformat(), "passed": False, "trials": []}
    write_json(directory / "gate.json", report)
    refresh_index(root.parent)
    try:
        async with AsyncDaytona() as client:
            pending = iter(enumerate(selected, 1))

            def record_failure(index: int, task: str, exc: BaseException) -> None:
                failure = {"error": type(exc).__name__, "trial_index": index,
                           "task": task, "directory": f"{index:03d}-{task}"}
                if isinstance(exc, TrialExecutionFailure):
                    failure["diagnostics"] = exc.details
                report.setdefault("failure", failure)

            async def run_trial(index: int, task: str) -> None:
                trial_dir = directory / f"{index:03d}-{task}"
                label = uuid.uuid4().hex
                trial_dir.mkdir()
                write_json(trial_dir / "cleanup-request.json", {"label": label})
                print(f"{stage} {index}/{len(selected)}: {task}", flush=True)
                try:
                    if "sha256:" + Packager.compute_content_hash(tasks[task])[0] != identity["task_digests"][task]:
                        raise ValueError("Task content changed after dataset verification")
                    trial = await Trial.create(trial_config(config, tasks[task], trial_dir, label, oracle=stage == "oracle"))
                    await trial.run()
                except BaseException as exc:
                    # Stop queued work immediately, including while cleanup of
                    # the failed trial is still in progress.
                    record_failure(index, task, exc)
                    raise
                finally:
                    cleanup = asyncio.create_task(confirm_cleanup(client, trial_dir, label))
                    cancelled = False
                    while not cleanup.done():
                        try:
                            await asyncio.shield(cleanup)
                        except asyncio.CancelledError:
                            # Preserve evidence and finish remote deletion even
                            # when SIGTERM arrives during a cancelled trial.
                            cancelled = True
                    cleanup.result()
                    if cancelled:
                        raise asyncio.CancelledError
                evidence = validate_trial(trial_dir, task, identity, oracle=stage == "oracle")
                report["trials"].append({"task": task, "directory": trial_dir.name,
                                         "evidence": evidence, "files": inventory(trial_dir)})
                report["trials"].sort(key=lambda row: row["directory"])
                write_json(directory / "gate.json", report)
                refresh_index(root.parent)

            async def worker() -> None:
                # A slot includes installation, execution, verification, and
                # confirmed cleanup. Do not launch queued work after a failure.
                while "failure" not in report:
                    item = next(pending, None)
                    if item is None:
                        return
                    index, task = item
                    try:
                        await run_trial(index, task)
                    except BaseException as exc:
                        record_failure(index, task, exc)
                        raise

            # TaskGroup cancels peers on failure and waits for their shielded
            # cleanup before either Daytona client can close.
            async with asyncio.TaskGroup() as group:
                for _ in range(min(config.concurrency, len(selected))):
                    group.create_task(worker())
            # TaskGroup permits a worker to cancel itself without propagating
            # an exception. Missing trials must still fail qualification.
            if "failure" in report or len(report["trials"]) != len(selected):
                raise RuntimeError("Stage did not complete every selected trial")
        report["passed"] = True
    except BaseException as exc:
        report.setdefault("failure", {"error": type(exc).__name__})
        if isinstance(exc, Exception) and "diagnostics" in report["failure"]:
            failure = report["failure"]
            location = directory / failure["directory"]
            reason = describe_failure(failure["diagnostics"])
            raise StageFailedError(f"{stage}: qualification failed: {reason}. Evidence: {location}. "
                                   "The stage remains unqualified; no existing trial will be overwritten.") from exc
        raise
    finally:
        report["finished_at"] = datetime.now(timezone.utc).isoformat()
        write_json(directory / "gate.json", report)
        refresh_index(root.parent)
        # Harbor owns a separate singleton HTTP client; close it on this loop.
        manager = await DaytonaClientManager.get_instance()
        await manager._cleanup()
    print(f"{stage}: passed; evidence: {directory}", flush=True)


async def execute(config: BenchmarkConfig, tasks: dict, identity: dict, root: Path, stage: str, through: bool) -> None:
    current = asyncio.current_task()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, current.cancel)
    try:
        for name in STAGES[:STAGES.index(stage) + 1] if through else (stage,):
            await run_stage(config, tasks, identity, root, name)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=PACKAGE / "benchmark.toml")
    parser.add_argument("--output", type=Path, default=PACKAGE / "results/release-gate")
    parser.add_argument("-n", "--concurrency", type=int,
                        help="Maximum simultaneous trials, including cleanup (default: config concurrency or 1); use the same value for every stage and verification")
    parser.add_argument("--dataset-cache", type=Path, default=PACKAGE / "results/dataset-cache",
                        help="Shared archive cache; every use verifies the pinned SHA-256")
    parser.add_argument("--results-dir", type=Path, help="Directory to scan with --refresh-index (defaults to the output parent)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true", help="Verify dataset and report stage sizes without creating sandboxes")
    mode.add_argument("--refresh-index", action="store_true", help="Rebuild index.md from local reports without downloads or API calls")
    mode.add_argument("--diagnose-trial", type=Path, help="Explain a retained trial failure without downloads or API calls")
    mode.add_argument("--stage", choices=STAGES)
    mode.add_argument("--verify-through", choices=STAGES, help="Recheck retained or downloaded stage evidence without API calls")
    mode.add_argument("--through", choices=STAGES[:-1], help="Run prerequisite stages in order; stops on first failure")
    args = parser.parse_args()
    if args.results_dir is not None and not args.refresh_index:
        parser.error("--results-dir requires --refresh-index")
    if args.concurrency is not None and args.concurrency < 1:
        parser.error("--concurrency must be a positive integer")
    os.umask(0o077)
    root = args.output.resolve()
    if args.diagnose_trial:
        directory = args.diagnose_trial.resolve()
        print(f"{directory.name}: {describe_failure(diagnose_trial(directory))}")
        print(f"Retained evidence: {directory}")
        return
    if args.refresh_index:
        directory = args.results_dir.resolve() if args.results_dir is not None else root.parent
        print(f"Updated run index: {write_index(directory)}")
        return
    config = load_config(args.config)
    if args.concurrency is not None:
        config = BenchmarkConfig.model_validate({**config.model_dump(), "concurrency": args.concurrency})
    stage = args.stage or args.through
    if not args.prepare and not args.verify_through:
        preflight(config, oracle=stage == "oracle")
    with prepare_dataset(config, args.dataset_cache.resolve()) as (tasks, digests):
        if args.prepare:
            write_json(root / "dataset.json", {"dataset": config.dataset.model_dump(), "task_digests": digests,
                       "model": config.model, "policy": config.policy.model_dump(), "concurrency": config.concurrency,
                       "stages": {name: len(stage_tasks(name, config.pilot_tasks, list(tasks))) for name in STAGES}})
            refresh_index(root.parent)
            print(f"Verified {len(tasks)} pinned tasks: {root / 'dataset.json'}")
            return
        identity = run_identity(config, digests)
        if args.verify_through:
            require_previous(root, args.verify_through, identity, config.pilot_tasks, list(tasks), include_current=True)
            refresh_index(root.parent)
            print(f"Verified retained evidence through {args.verify_through}: {root}")
            return
        try:
            asyncio.run(execute(config, tasks, identity, root, stage, bool(args.through)))
        except StageFailedError as exc:
            raise SystemExit(str(exc)) from None


if __name__ == "__main__":
    main()
