"""Validate pre-verifier control shutdown separately from environment teardown."""

import json
from pathlib import Path


def read_cleanup(directory: Path) -> dict:
    report = json.loads((directory / "cleanup.json").read_text())
    if (not isinstance(report, dict) or type(report.get("schema_version")) is not int or report["schema_version"] != 1
            or report.get("phase") != "pre-verifier" or report.get("stop_requested") is not True
            or report.get("agent_execution_stopped") is not True
            or report.get("ownership_validated") is not True
            or report.get("remaining_agent_pids") != [] or not (directory / "stop-requested").is_file()):
        raise ValueError("Agent execution stop is unverified")
    controls = report.get("control_processes")
    records = report.get("ownership_records")
    retained = report.get("retained_processes")
    if not all(isinstance(value, list) for value in (controls, records, retained)):
        raise ValueError("Missing ownership or control evidence")
    expected = []
    for role in ("launcher", "cli"):
        path = directory / f"{role}.json"
        if path.exists():
            control = json.loads(path.read_text())
            if (not isinstance(control, dict) or set(control) != {"pid", "start"}
                    or type(control.get("pid")) is not int or control["pid"] <= 1
                    or not isinstance(control.get("start"), str) or not control["start"]):
                raise ValueError("Invalid control identity")
            expected.append({"role": role, **control})
    if controls != expected:
        raise ValueError("Control identities differ from shutdown evidence")
    process_path = directory / "process.json"
    if process_path.exists():
        process = json.loads(process_path.read_text())
        roles = {control["role"] for control in controls}
        if "launcher" not in roles or (type(process.get("exit_code")) is int
                                       and not process.get("spawn_error") and "cli" not in roles):
            raise ValueError("Missing launched control identity")
    saved = []
    for path in sorted((directory / "ownership").glob("*.json")):
        record = json.loads(path.read_text())
        if path.name != f"{record['executionId']}.json":
            raise ValueError("Ownership filename differs from execution identity")
        saved.append(record)
    if sorted(records, key=lambda record: record["executionId"]) != sorted(saved, key=lambda record: record["executionId"]):
        raise ValueError("Ownership records differ from shutdown evidence")
    by_id = {}
    for record in records:
        if (type(record.get("version")) is not int or record["version"] != 1 or not isinstance(record.get("executionId"), str)
                or not record["executionId"] or record["executionId"] in by_id
                or type(record.get("processGroupId")) is not int or record["processGroupId"] <= 1
                or type(record.get("supervisorPid")) is not int or record["supervisorPid"] <= 1
                or (record.get("owner"), record.get("state")) not in (
                    ("environment", "background"), ("session", "active"), ("session", "terminated"))
                or not isinstance(record.get("members"), list)
                or (record["owner"] == "environment" and not record["members"])):
            raise ValueError("Invalid ownership record")
        for member in record["members"]:
            if (type(member.get("pid")) is not int or member["pid"] <= 1
                    or member.get("processGroupId") != record["processGroupId"]
                    or not isinstance(member.get("startTime"), str) or not member["startTime"]):
                raise ValueError("Invalid owned process identity")
        by_id[record["executionId"]] = record
    seen = set()
    for member in retained:
        record = by_id.get(member.get("executionId"), {})
        if (member.get("owner") != "environment" or record.get("owner") != "environment"
                or member.get("processGroupId") != record.get("processGroupId")
                or type(member.get("pid")) is not int or member["pid"] <= 1 or member["pid"] in seen
                or not isinstance(member.get("startTime"), str) or not member["startTime"]
                or any(control["pid"] == member["pid"] for control in controls)):
            raise ValueError("Retained process lacks unambiguous environment ownership")
        seen.add(member["pid"])
    return report
