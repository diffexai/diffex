"""Retain sandbox identities and independently verify Harbor's cleanup."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path

from daytona import AsyncDaytona, ListSandboxesQuery
from daytona.common.errors import DaytonaNotFoundError
from harbor.environments.daytona import DaytonaEnvironment

from diffex_terminal_bench.gate import read_json, write_json


class RecordedDaytonaEnvironment(DaytonaEnvironment):
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
    try:
        # List is paginated by the SDK. The unique trial label also catches a
        # sandbox created remotely during a timed-out create request.
        async with asyncio.timeout(120):
            created_path = directory / "sandbox-created.json"
            created = read_json(created_path)["sandboxes"] if created_path.exists() else []
            for identifier in sorted({row["id"] for row in created}):
                # Deletion may be asynchronous even when Harbor stop returns.
                for attempt in range(10):
                    try:
                        await client.get(identifier, request_timeout=10)
                    except DaytonaNotFoundError:
                        report["absent_ids"].append(identifier)
                        break
                    if attempt == 9:
                        break
                    await asyncio.sleep(2)
            remaining = [sandbox async for sandbox in client.list(
                ListSandboxesQuery(labels={"diffex.gate_trial": label}), request_timeout=20)]
            report["unexpected_sandboxes"] = [sandbox.id for sandbox in remaining]
            for sandbox in remaining:
                await client.delete(sandbox, wait=True, timeout=60)
                try:
                    await client.get(sandbox.id, request_timeout=10)
                except DaytonaNotFoundError:
                    report["absent_ids"].append(sandbox.id)
                else:
                    raise RuntimeError("Sandbox remains after recovery deletion")
            if [sandbox.id async for sandbox in client.list(
                ListSandboxesQuery(labels={"diffex.gate_trial": label}), request_timeout=20)]:
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
