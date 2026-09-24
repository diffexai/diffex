"""Reclaim completed trial prefixes after verification and local validation."""

import asyncio
import json
import logging
import math
from pathlib import Path
import re
from uuid import uuid4

from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams, VolumeMount
from daytona.common.errors import DaytonaNotFoundError
from harbor.job import Job
from harbor.models.job.result import JobResult
from harbor.trial.hooks import TrialEvent, TrialHookEvent
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.gate import inventory, read_json, write_json
from diffex_terminal_bench.outcome import parse_outcome
from diffex_terminal_bench.transport import retry_transport


LOGGER = logging.getLogger(__name__)


def validate_retention(directory: Path) -> dict[str, str]:
    result = read_json(directory / "result.json")
    if result.get("exception_info") or not result.get("finished_at"):
        raise ValueError("Trial did not complete")
    rewards = (result.get("verifier_result") or {}).get("rewards")
    if not isinstance(rewards, dict) or not rewards or any(
        type(value) not in (int, float) or not math.isfinite(value) for value in rewards.values()
    ):
        raise ValueError("Verification did not complete")
    verifier = directory / "verifier"
    saved = read_json(verifier / "reward.json") if (verifier / "reward.json").exists() else {
        "reward": float((verifier / "reward.txt").read_text())}
    if saved != rewards or not (verifier / "test-stdout.txt").is_file():
        raise ValueError("Verifier evidence is incomplete")
    runs = list((directory / "agent").glob("run-*"))
    if len(runs) != 1:
        raise ValueError("Expected one completed Diffex run")
    outcome = read_json(runs[0] / "outcome.json")
    if outcome.get("status") != "completed" or outcome.get("artifact_errors") or outcome.get("recovery_errors"):
        raise ValueError("Execution or artifact collection failed")
    native = parse_outcome(runs[0], launcher_exit_code=outcome.get("launcher_exit_code"))
    if native["status"] != "completed" or not native["cleanup_confirmed"]:
        raise ValueError("Native completion and shutdown are not established")
    if not TrajectoryValidator().validate(directory / "agent/trajectory.json"):
        raise ValueError("Invalid local trajectory")
    if read_json(runs[0] / "accounting.json").get("gaps"):
        raise ValueError("Incomplete native sessions")
    files = inventory(directory)
    # Harbor stores the convention /logs/artifacts directory by source path.
    expected = {}
    for name, digest in files.items():
        if name.startswith(("agent/", "verifier/", "user-agent/")):
            expected[name] = digest
        elif name.startswith("artifacts/logs/artifacts/"):
            expected[name.removeprefix("artifacts/logs/")] = digest
    return expected


async def cleanup_trial_volume(client: AsyncDaytona, directory: Path) -> dict:
    report = {"status": "retained", "confirmed": False}
    sandbox = None
    try:
        expected = validate_retention(directory)
        mounts = read_json(directory / "artifact-volume.json")["mounts"]
        created = read_json(directory / "sandbox-created.json")["sandboxes"]
        if not mounts or len(mounts) != len(created):
            raise ValueError("Incomplete sandbox creation records")
        for mount in mounts:
            if not re.fullmatch(r"trials/[0-9a-f]{32}", mount["subpath"]) or mount["mount_path"] != "/logs":
                raise ValueError("Invalid trial volume prefix")
        # Retained services and separate verifiers must all be gone first.
        for row in created:
            async def confirm_absent():
                try:
                    await client.get(row["id"], request_timeout=10)
                except DaytonaNotFoundError:
                    return
                # Harbor's delete request returns before deletion settles.
                raise TimeoutError("Trial sandbox deletion is still pending")

            await retry_transport(confirm_absent)
        roots = [f"/mnt/trial-{index}" for index in range(len(mounts))]
        report["mounts"] = mounts
        report["cleanup_label"] = uuid4().hex
        report["status"] = "cleaning"
        write_json(directory / "volume-cleanup.json", report)
        # Never retry a create: a lost response could allocate another sandbox.
        # Automatic stop/delete also bounds leaks if the runner loses this RPC.
        sandbox = await client.create(CreateSandboxFromSnapshotParams(
            language="python", os_user="root", auto_stop_interval=2, auto_delete_interval=0, ttl_minutes=10,
            labels={"diffex.volume_cleanup": report["cleanup_label"]},
            volumes=[VolumeMount(volume_id=mount["volume_id"], subpath=mount["subpath"], mount_path=root)
                     for mount, root in zip(mounts, roots, strict=True)],
        ), timeout=60)
        report["sandbox_id"] = sandbox.id
        write_json(directory / "volume-cleanup.json", report)
        await retry_transport(lambda: sandbox.fs.upload_file(
            Path(__file__).with_name("prune_volume.py").read_bytes(), "/tmp/prune-volume.py"))
        payload = json.dumps({"roots": roots, "expected": expected}).encode()
        await retry_transport(lambda: sandbox.fs.upload_file(payload, "/tmp/prune-request.json"))

        async def prune():
            response = await sandbox.process.exec("python3 /tmp/prune-volume.py /tmp/prune-request.json", timeout=60)
            if response.exit_code != 0:
                raise ValueError("Remote artifact comparison or cleanup failed")
            value = json.loads(response.result)
            if value.get("confirmed") is not True:
                raise ValueError("Remote cleanup was not confirmed")
            return value

        report.update(await retry_transport(prune, request_timeout=65, total_timeout=210))
        report["status"] = "cleaned"
    except Exception as exc:
        report["status"] = "retained" if sandbox is None else "cleanup_failed"
        report["error"] = type(exc).__name__
        LOGGER.info("Retaining volume recovery records for %s: %s", directory.name, exc)
    finally:
        if sandbox is not None:
            async def delete():
                try:
                    await client.delete(sandbox, wait=True, timeout=15)
                except DaytonaNotFoundError:
                    pass

            deletion = asyncio.create_task(retry_transport(delete))
            cancelled = False
            while not deletion.done():
                try:
                    await asyncio.shield(deletion)
                except asyncio.CancelledError:
                    cancelled = True
                except Exception:
                    break
            try:
                deletion.result()
                report["cleanup_sandbox_deleted"] = True
            except Exception as exc:
                report["cleanup_sandbox_deleted"] = False
                report["sandbox_error"] = type(exc).__name__
            if cancelled:
                report["interrupted"] = True
        try:
            write_json(directory / "volume-cleanup.json", report)
        except OSError:
            LOGGER.warning("Could not save volume cleanup report for %s", directory, exc_info=True)
        if sandbox is not None and cancelled:
            raise asyncio.CancelledError
    return report


class VolumeCleanupPlugin:
    async def on_job_start(self, job: Job) -> None:
        job.add_hook(TrialEvent.END, self.on_trial_end)

    async def on_trial_end(self, event: TrialHookEvent) -> None:
        if (event.config.environment.import_path != "diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment"
                or not event.config.environment.delete):
            return
        directory = event.config.trials_dir / event.config.trial_name
        try:
            async with AsyncDaytona() as client:
                await cleanup_trial_volume(client, directory)
        except Exception:
            LOGGER.warning("Volume cleanup unavailable for %s", directory, exc_info=True)

    async def on_job_end(self, job_result: JobResult) -> None:
        pass
