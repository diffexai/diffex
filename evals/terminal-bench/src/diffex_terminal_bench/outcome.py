"""Classify execution evidence independently of verifier rewards and CLI versions."""

import json
from pathlib import Path
import re

from harbor.agents.installed.base import AgentAuthenticationError, NonZeroAgentExitCodeError

from diffex_terminal_bench.lifecycle import read_cleanup
from diffex_terminal_bench.execution import SYSTEM_PROMPT_SHA256, USER_MESSAGE_SUFFIX


class DiffexExecutionError(NonZeroAgentExitCodeError):
    """An agent infrastructure failure, not a completed task with reward zero."""


class DiffexControlStopError(RuntimeError):
    """Block Harbor verification when agent execution may still be running."""


def parse_outcome(directory: Path, interruption: str | None = None,
                  launcher_exit_code: int | None = None, *, shutdown_directory: Path | None = None) -> dict:
    result = {"status": "incomplete", "reason": "missing_evidence", "stream_complete": False,
              "assistant_stop_reason": None, "retry_attempts": 0, "recovered_retries": 0,
              "launcher_exit_code": launcher_exit_code, "interruption": interruption}
    try:
        process = json.loads((directory / "process.json").read_text())
        if not isinstance(process, dict):
            raise ValueError("invalid_process")
        result["process"] = process
    except (OSError, ValueError):
        process = {}
    try:
        cleanup = read_cleanup(shutdown_directory if shutdown_directory is not None else directory)
        result.update(cleanup_confirmed=True, agent_execution_stopped=True,
                      retained_processes=cleanup["retained_processes"])
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        result.update(cleanup_confirmed=False, agent_execution_stopped=False)
    # Parse incrementally so long runs do not require the whole stream in memory.
    active = False
    ended = False
    settled = False
    pending_retry = False
    failed_retry = False
    open_message = False
    last_assistant = None
    terminal = None
    stream_error = None
    saw_session = False
    try:
        with (directory / "stdout.jsonl").open(encoding="utf-8") as stream:
            for line in stream:
                if not line.endswith("\n"):
                    raise ValueError("truncated_line")
                event = json.loads(line)
                if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                    raise ValueError("invalid_event")
                kind = event["type"]
                if settled:
                    raise ValueError("event_after_settled")
                if kind == "session":
                    if saw_session:
                        raise ValueError("duplicate_session")
                    saw_session = True
                elif kind == "agent_start":
                    if active or open_message:
                        raise ValueError("overlapping_run")
                    active, ended, terminal = True, False, None
                    last_assistant = None
                elif kind == "message_start":
                    if not active or open_message:
                        raise ValueError("unexpected_message")
                    open_message = True
                elif kind == "message_end":
                    if not active or not open_message:
                        raise ValueError("unexpected_message_end")
                    open_message = False
                    message = event.get("message")
                    if not isinstance(message, dict):
                        raise ValueError("invalid_message")
                    if message.get("role") == "assistant":
                        last_assistant = message
                elif kind == "message_update":
                    if not active or not open_message:
                        raise ValueError("unexpected_update")
                elif kind == "agent_end":
                    if not active or open_message:
                        raise ValueError("unexpected_agent_end")
                    messages = event.get("messages")
                    if not isinstance(messages, list) or not messages or not isinstance(messages[-1], dict):
                        raise ValueError("missing_terminal_message")
                    terminal = messages[-1]
                    if terminal.get("role") != "assistant" or terminal != last_assistant:
                        raise ValueError("terminal_message_mismatch")
                    active, ended = False, True
                    pending_retry = pending_retry or event.get("willRetry") is True
                elif kind == "auto_retry_start":
                    pending_retry, ended = True, False
                    result["retry_attempts"] += 1
                elif kind == "auto_retry_end":
                    if not isinstance(event.get("success"), bool):
                        raise ValueError("invalid_retry_outcome")
                    pending_retry = False
                    failed_retry = not event["success"]
                    if event["success"]:
                        result["recovered_retries"] += 1
                elif kind == "agent_settled":
                    if active or not ended or pending_retry or open_message:
                        raise ValueError("premature_settled")
                    settled = True
                elif kind == "error":
                    raise ValueError("unhandled_error_event")
                elif kind in ("turn_start", "turn_end", "tool_execution_start", "tool_execution_update", "tool_execution_end"):
                    if not active:
                        raise ValueError("event_outside_run")
    except (OSError, ValueError, UnicodeError) as exc:
        # Never copy provider text or malformed raw output into summary/errors.
        stream_error = type(exc).__name__
    complete = saw_session and ended and settled and not active and not open_message and not pending_retry and stream_error is None
    result["stream_complete"] = complete
    if terminal:
        result["assistant_stop_reason"] = terminal.get("stopReason")
    if interruption:
        result.update(status=interruption, reason="execution_interrupted")
    elif not result.get("cleanup_confirmed"):
        result.update(status="cleanup_failure", reason="process_cleanup_unverified")
    elif terminal and terminal.get("stopReason") in ("error", "aborted"):
        authentication = re.search(r"\b401\b|authentication_error|invalid[ _-]api[ _-]key|unauthorized",
                                   str(terminal.get("errorMessage", "")), re.IGNORECASE)
        result.update(status="authentication_failure" if authentication else "provider_failure",
                      reason="terminal_assistant_error")
    elif failed_retry:
        result.update(status="provider_failure", reason="retry_failed")
    elif process.get("exit_code") != 0 or process.get("signal") or process.get("spawn_error") or launcher_exit_code != 0:
        result.update(status="process_failure", reason="unsuccessful_process")
    elif not complete or not terminal or terminal.get("stopReason") != "stop":
        result.update(status="incomplete", reason="unfinished_json_stream")
    else:
        try:
            requested = json.loads((directory / "requested.json").read_text())
            effective = json.loads((directory / "effective.json").read_text())
            if not isinstance(requested, dict) or not isinstance(effective, dict):
                raise ValueError("invalid_configuration")
            matches = all(effective.get(key) == requested[key] for key in ("provider", "model", "thinking", "instruction_sha256", "background_process_lifetime", "user_message_suffix", "system_prompt_sha256"))
            matches = matches and requested["user_message_suffix"] == USER_MESSAGE_SUFFIX
            matches = matches and requested["system_prompt_sha256"] == SYSTEM_PROMPT_SHA256
            matches = matches and requested.get("background_process_lifetime") == "environment"
            matches = matches and effective.get("context_files_disabled") is True and effective.get("instruction_delivered") is True
            matches = matches and sorted(effective["tools"]) == sorted(requested["tools"])
        except (OSError, ValueError, KeyError, TypeError):
            matches = False
        result.update(status="completed" if matches else "configuration_failure",
                      reason="completed" if matches else "effective_configuration_mismatch")
    return result


def require_completed(outcome: dict) -> None:
    if outcome.get("agent_execution_stopped") is not True:
        raise DiffexControlStopError("Agent execution stop is unverified; verification is blocked")
    if outcome["status"] == "completed":
        return
    message = f"Diffex execution {outcome['status']}: {outcome['reason']}; see retained run artifacts"
    if outcome["status"] == "authentication_failure":
        raise AgentAuthenticationError(message)
    raise DiffexExecutionError(message)
