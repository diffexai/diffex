"""Describe retained trial failures without exposing provider error text."""

import json
from pathlib import Path
import re


class TrialExecutionFailure(ValueError):
    """A rejected Harbor execution with safe, actionable retained diagnostics."""

    def __init__(self, directory: Path, result: dict):
        self.details = diagnose_trial(directory, result)
        super().__init__(describe_failure(self.details))


def diagnose_trial(directory: Path, result: dict | None = None) -> dict:
    if result is None:
        result = json.loads((directory / "result.json").read_text())
    if not isinstance(result, dict):
        raise ValueError("Expected a Harbor trial result object")
    exception = result.get("exception_info") or {}
    name = exception.get("exception_type") if isinstance(exception, dict) else None
    details = {"harbor_exception": name if isinstance(name, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,99}", name) else None,
               "harbor_failed": bool(exception), "finished": bool(result.get("finished_at")), "retry_attempts": 0,
               "rate_limit_retries": 0, "scheduled_retry_delay_sec": 0.0,
               "retry_evidence_complete": True}
    if details["harbor_exception"] == "AgentTimeoutError":
        timeout = re.fullmatch(r"Agent execution timed out after ([0-9]+(?:\.[0-9]+)?) seconds",
                               str(exception.get("exception_message", "")))
        if timeout and len(timeout[1]) < 16:
            details["agent_timeout_sec"] = float(timeout[1])
    streams = sorted((directory / "agent").glob("run-*/stdout.jsonl"))
    if not streams:
        details["retry_evidence_complete"] = False
    for stream in streams:
        try:
            with stream.open() as source:
                for line in source:
                    try:
                        event = json.loads(line)
                    except ValueError:
                        details["retry_evidence_complete"] = False
                        continue
                    if not line.endswith("\n") or not isinstance(event, dict):
                        details["retry_evidence_complete"] = False
                        continue
                    if event.get("type") != "auto_retry_start":
                        continue
                    details["retry_attempts"] += 1
                    if re.search(r"rate.?limit|too many requests|\b429\b", str(event.get("errorMessage", "")), re.IGNORECASE):
                        details["rate_limit_retries"] += 1
                    delay = event.get("delayMs")
                    if type(delay) in (int, float) and 0 <= delay <= 86_400_000:
                        details["scheduled_retry_delay_sec"] += delay / 1000
        except (OSError, UnicodeError):
            details["retry_evidence_complete"] = False
    return details


def describe_failure(details: dict) -> str:
    reason = details.get("harbor_exception")
    if not reason:
        reason = "Harbor trial failed" if details["harbor_failed"] else (
            "Harbor trial has no finish timestamp" if not details["finished"] else "Harbor trial finished without a recorded exception")
    if "agent_timeout_sec" in details:
        reason += f" at the {details['agent_timeout_sec']:g}s task deadline"
    if details["retry_attempts"]:
        reason += (f"; observed {details['retry_attempts']} scheduled retries"
                   f" ({details['rate_limit_retries']} rate-limit retries,"
                   f" {details['scheduled_retry_delay_sec']:g}s scheduled backoff)")
    if details["rate_limit_retries"]:
        reason += "; provider throttling was observed; ensure available provider capacity before retrying"
    if not details["retry_evidence_complete"]:
        reason += "; retry evidence is incomplete"
    return reason
