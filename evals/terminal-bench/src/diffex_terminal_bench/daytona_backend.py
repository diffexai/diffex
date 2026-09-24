"""Retain sandbox identities and independently verify Harbor's cleanup."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from daytona import AsyncDaytona, CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, ListSandboxesQuery, VolumeMount
from daytona.common.errors import DaytonaConflictError, DaytonaNotFoundError
from harbor.environments.daytona import DaytonaEnvironment

from diffex_terminal_bench.gate import read_json, write_json
from diffex_terminal_bench.transport import retry_transport


class RecordedDaytonaEnvironment(DaytonaEnvironment):
    async def _create_sandbox(
        self, params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams,
        daytona: AsyncDaytona | None = None,
    ) -> None:
        # Harbor 0.23.0 has no public hook for SDK volume mounts. This creation
        # boundary covers both direct sandboxes and the DinD host (whose /logs
        # paths Harbor bind-mounts into the task container).
        if daytona is None:
            if self._client_manager is None:
                raise RuntimeError("Daytona client manager is not initialized")
            daytona = await self._client_manager.get_client()
        name = self._kwargs.get("artifact_volume", "diffex-terminal-bench-logs")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("artifact_volume must be a nonempty volume name")

        async def get_volume():
            try:
                return await daytona.volume.get(name, create=True)
            except DaytonaConflictError:
                # Another concurrent trial or runner created the shared volume.
                return await daytona.volume.get(name)

        async with asyncio.timeout(120):
            volume = await retry_transport(get_volume)
            while volume.state != "ready":
                if volume.state not in ("pending_create", "creating"):
                    raise RuntimeError(f"Artifact volume is not usable: {volume.state}")
                await asyncio.sleep(1)
                volume = await retry_transport(lambda: daytona.volume.get(name))

        # One project volume, not one per trial: Daytona permits 100 volumes
        # per organization. A random subpath isolates concurrent jobs/retries.
        mount = VolumeMount(volume_id=volume.id, mount_path="/logs", subpath=f"trials/{uuid4().hex}")
        params.volumes = [*(params.volumes or []), mount]
        path = self.trial_paths.trial_dir / "artifact-volume.json"
        record = read_json(path) if path.exists() else {"mounts": []}
        record["mounts"].append({
            "session_id": self.session_id, "environment_name": self.environment_name,
            "volume_id": volume.id, "volume_name": name,
            "mount_path": mount.mount_path, "subpath": mount.subpath,
        })
        write_json(path, record)
        await super()._create_sandbox(params=params, daytona=daytona)

    async def start(self, force_build: bool) -> None:
        try:
            await super().start(force_build)
        finally:
            # Harbor 0.23.0 exposes no public creation-result API. Read its
            # pinned sandbox reference before stop() deliberately clears it.
            if self._sandbox is not None:
                path = self.trial_paths.trial_dir / "sandbox-created.json"
                record = read_json(path) if path.exists() else {"sandboxes": []}
                sandbox = self._sandbox
                record["sandboxes"].append({"id": sandbox.id, "snapshot": sandbox.snapshot,
                                            "cpu": sandbox.cpu, "memory_gib": sandbox.memory,
                                            "disk_gib": sandbox.disk, "labels": sandbox.labels})
                write_json(path, record)


async def confirm_cleanup(client: AsyncDaytona, directory: Path, label: str, *, report_path: Path | None = None) -> dict:
    """Delete only this trial's orphans; recovered leaks still fail the gate."""
    report = {"confirmed": False, "unexpected_sandboxes": [], "absent_ids": [], "label": label}

    async def is_absent(identifier: str) -> bool:
        try:
            await client.get(identifier, request_timeout=10)
        except DaytonaNotFoundError:
            if identifier not in report["absent_ids"]:
                report["absent_ids"].append(identifier)
            return True
        if identifier in report["absent_ids"]:
            report["absent_ids"].remove(identifier)
        return False

    try:
        # List is paginated by the SDK. The unique trial label also catches a
        # sandbox created remotely during a timed-out create request.
        async with asyncio.timeout(120):
            created_path = directory / "sandbox-created.json"
            created = read_json(created_path)["sandboxes"] if created_path.exists() else []
            for identifier in sorted({row["id"] for row in created}):
                # Deletion may be asynchronous even when Harbor stop returns.
                for attempt in range(10):
                    if await is_absent(identifier):
                        break
                    if attempt == 9:
                        break
                    await asyncio.sleep(2)
            remaining = [sandbox async for sandbox in client.list(
                ListSandboxesQuery(labels={"diffex.gate_trial": label}), request_timeout=20)]
            for sandbox in remaining:
                # Listings can retain deleted sandboxes after get() returns
                # not-found. Confirm existence before classifying a leak.
                if await is_absent(sandbox.id):
                    continue
                try:
                    await client.delete(sandbox, wait=True, timeout=60)
                except DaytonaNotFoundError:
                    # Harbor's deletion may finish between lookup and delete.
                    # A fresh lookup must independently establish absence.
                    pass
                else:
                    report["unexpected_sandboxes"].append(sandbox.id)
                if not await is_absent(sandbox.id):
                    raise RuntimeError("Sandbox remains after recovery deletion")
            async for sandbox in client.list(
                ListSandboxesQuery(labels={"diffex.gate_trial": label}), request_timeout=20):
                if not await is_absent(sandbox.id):
                    raise RuntimeError("Sandbox appeared after cleanup")
            if not {row["id"] for row in created}.issubset(report["absent_ids"]):
                raise RuntimeError("Known sandbox deletion could not be confirmed")
            report["confirmed"] = True
    except Exception as exc:
        report["error"] = type(exc).__name__
    finally:
        report["checked_at"] = datetime.now(timezone.utc).isoformat()
        write_json(report_path or directory / "sandbox-cleanup.json", report)
    return report
