"""Convert retained Diffex evidence to validated, self-contained Harbor ATIF."""

from collections import Counter, defaultdict
import base64
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path

from harbor.models.agent.context import AgentContext, ModelUsage
from harbor.models.trajectories.trajectory import Trajectory
from harbor.utils.trajectory_validator import TrajectoryValidator

from diffex_terminal_bench.config import PINS


FIELDS = ("prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd")
CONTEXT_FIELDS = ("n_input_tokens", "n_output_tokens", "n_cache_tokens", "cost_usd")


def read_records(path: Path, gaps: list[str]) -> list[dict]:
    """Keep every intact record, even when a later record is torn or corrupt."""
    records = []
    try:
        with path.open("rb") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        raise ValueError("invalid record")
                    records.append(record)
                    if not line.endswith(b"\n"):
                        gaps.append(f"unterminated_record:{path.name}")
                except (ValueError, UnicodeError):
                    gaps.append(f"invalid_record:{path.name}")
    except OSError:
        gaps.append(f"missing_file:{path.name}")
    return records


def message_key(message: dict) -> str:
    # Response IDs are scoped to the native session. For providers without an
    # ID, the exact final message (including timestamp) identifies a response.
    if message.get("role") == "assistant" and message.get("responseId"):
        return json.dumps([message.get("provider"), message.get("model"), message["responseId"]])
    return json.dumps(message, sort_keys=True, ensure_ascii=False)


def metrics_for(usage: object) -> dict:
    invalid = usage is not None and not isinstance(usage, dict)
    usage = usage if isinstance(usage, dict) else {}
    values = {}
    for key in ("input", "output", "cacheRead", "cacheWrite"):
        value = usage.get(key)
        values[key] = value if type(value) is int and value >= 0 else None
        invalid |= value is not None and values[key] is None
    cost = usage.get("cost", {})
    invalid |= cost is not None and not isinstance(cost, dict)
    cost = cost.get("total") if isinstance(cost, dict) else None
    invalid |= cost is not None and not (type(cost) in (int, float) and math.isfinite(cost) and cost >= 0)
    cost = cost if type(cost) in (int, float) and math.isfinite(cost) and cost >= 0 else None
    inputs = [values[key] for key in ("input", "cacheRead", "cacheWrite")]
    # Native providers initialize usage to zero before receiving telemetry.
    # An all-zero record cannot establish that an inference was free/empty.
    if all(value == 0 for value in values.values()):
        values = dict.fromkeys(values)
        inputs, cost = [None], None
    return {
        "prompt_tokens": sum(inputs) if None not in inputs else None,
        "completion_tokens": values["output"], "cached_tokens": values["cacheRead"],
        "cost_usd": cost,
        "extra": {"input_tokens_uncached": values["input"], "cache_write_tokens": values["cacheWrite"],
                  "native_usage": usage, **({"invalid_usage": True} if invalid else {})},
    }


class Session:
    def __init__(self, path: Path, records: list[dict], gaps: list[str], export_dir: Path):
        self.path = path
        self.records = records
        self.gaps = gaps
        self.header = next((record for record in records if record.get("type") == "session"), {})
        self.id = self.header.get("id") or hashlib.sha256(str(path).encode()).hexdigest()
        self.children: dict[str, dict] = {}
        self.steps: list[dict] = []
        self.calls: dict[str, dict] = {}
        self.export_dir = export_dir

    def supplement(self, events: list[dict]) -> None:
        # Match occurrences, not just a set: identical legitimate messages can
        # occur twice. Never sum message_start/update/turn_end/agent_end copies.
        available = Counter(message_key(record["message"]) for record in self.records
                            if record.get("type") == "message")
        pending = None
        tool_results = {}
        compactions = sum(record.get("type") == "compaction" for record in self.records)
        for index, event in enumerate(events):
            kind = event.get("type")
            if kind in ("message_start", "message_update"):
                pending = event.get("message")
            elif kind == "message_end" and isinstance(event.get("message"), dict):
                pending = None
                message = event["message"]
                key = message_key(message)
                if available[key]:
                    available[key] -= 1
                else:
                    self.records.append({"type": "message", "id": f"event-{index}", "message": message})
            elif kind == "auto_compaction_start":
                if compactions:
                    compactions -= 1
                else:
                    self.gaps.append("compaction_telemetry_missing")
            elif kind == "tool_execution_end" and isinstance(event.get("result"), dict):
                tool_results[event.get("toolCallId")] = event
        known_results = {record["message"].get("toolCallId") for record in self.records
                         if record.get("type") == "message" and record["message"].get("role") == "toolResult"}
        for call_id, event in tool_results.items():
            if call_id not in known_results:
                self.records.append({"type": "message", "id": f"tool-event-{call_id}", "message": {
                    "role": "toolResult", "toolCallId": call_id, "toolName": event.get("toolName"),
                    "content": event["result"].get("content", []), "details": event["result"].get("details"),
                    "isError": event.get("isError"),
                }})
        if isinstance(pending, dict) and pending.get("role") == "assistant":
            # A persisted final message can outlive a torn stdout message_end.
            if not any(record.get("message", {}).get("timestamp") == pending.get("timestamp")
                       and record.get("message", {}).get("role") == "assistant" for record in self.records):
                self.records.append({"type": "message", "id": "partial-stream-message",
                                     "message": pending, "partial": True})
            self.gaps.append("unfinished_model_response")
        # Supplemental retry messages must appear before their successful
        # successors, even if persistence discarded the failed response.
        def timestamp(record):
            value = record.get("timestamp")
            if value:
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            return record.get("message", {}).get("timestamp", float("inf")) / 1000
        self.records.sort(key=timestamp)

    def convert(self, requested: dict, system_prompt: str | None) -> dict:
        model = "/".join([requested.get("provider", "unknown"), requested.get("model", "unknown")])
        thinking = requested.get("thinking")
        if system_prompt is not None:
            self.steps.append({"source": "system", "message": system_prompt})
        seen = set()
        responses = set()
        for record in self.records:
            kind = record.get("type")
            entry_id = record.get("id")
            if entry_id and entry_id in seen:
                continue
            seen.add(entry_id)
            if kind == "model_change":
                model = f"{record['provider']}/{record['modelId']}"
            elif kind == "thinking_level_change":
                thinking = record.get("thinkingLevel")
            elif kind == "custom" and record.get("customType") == "diffex.subagents":
                for child in record.get("data", {}).get("agents", []):
                    if child.get("childSessionId"):
                        self.children[child["childSessionId"]] = child
            elif kind in ("compaction", "branch_summary"):
                metrics = metrics_for(record.get("usage"))
                self.steps.append({"source": "agent", "message": record.get("summary", ""),
                                   "model_name": "unattributed", "metrics": metrics, "extra": {"native_type": kind, "native_entry_id": entry_id,
                                                                 "model_attribution": "unavailable"}})
            elif kind == "custom_message":
                self.steps.append({"source": "user", "message": self.content(record.get("content", "")),
                                   "extra": {"native_type": kind, "custom_type": record.get("customType")}})
            elif kind == "message":
                message = record["message"]
                role = message.get("role")
                extra = {"native_entry_id": entry_id, "native_role": role}
                if role == "toolResult":
                    call_id = message.get("toolCallId")
                    observation = {"content": self.content(message.get("content", "")),
                                   "extra": {**extra, "is_error": message.get("isError"),
                                             "details": message.get("details")}}
                    if call_id in self.calls:
                        observation["source_call_id"] = call_id
                        self.calls[call_id].setdefault("observation", {"results": []})["results"].append(observation)
                    else:
                        self.gaps.append("orphan_tool_result")
                        observation["extra"]["unresolved_call_id"] = call_id
                        self.steps.append({"source": "system", "message": "Recovered tool result",
                                           "observation": {"results": [observation]}})
                    continue
                step = {"source": "agent" if role == "assistant" else "user",
                        "message": self.content(message.get("content", "")), "extra": extra}
                if message.get("timestamp") is not None:
                    step["timestamp"] = datetime.fromtimestamp(message["timestamp"] / 1000, timezone.utc).isoformat()
                if role == "assistant":
                    key = message_key(message)
                    if key in responses:
                        continue
                    responses.add(key)
                    step.update(model_name=f"{message.get('provider', model.split('/')[0])}/{message.get('model', model.split('/', 1)[1])}",
                                reasoning_effort=thinking, llm_call_count=1,
                                metrics=metrics_for(None if record.get("partial") else message.get("usage")))
                    extra.update(stop_reason=message.get("stopReason"), response_id=message.get("responseId"),
                                 partial=record.get("partial", False), error_message=message.get("errorMessage"))
                    blocks = message.get("content", [])
                    if isinstance(blocks, list):
                        reasoning = [block["thinking"] for block in blocks if block.get("type") == "thinking" and "thinking" in block]
                        if reasoning:
                            step["reasoning_content"] = "\n".join(reasoning)
                        calls = []
                        for block in blocks:
                            if block.get("type") != "toolCall":
                                continue
                            if not block.get("id") or not block.get("name") or not isinstance(block.get("arguments"), dict):
                                extra.setdefault("incomplete_tool_calls", []).append(block)
                                continue
                            calls.append({"tool_call_id": block["id"], "function_name": block["name"],
                                          "arguments": block["arguments"]})
                        if calls:
                            step["tool_calls"] = calls
                            for call in calls:
                                self.calls[call["tool_call_id"]] = step
                self.steps.append(step)
        for step in self.steps:
            if step.get("metrics", {}).get("extra", {}).get("invalid_usage"):
                self.gaps.append("invalid_usage")
        for index, step in enumerate(self.steps, 1):
            step["step_id"] = index
        return {"schema_version": "ATIF-v1.8", "session_id": self.id, "trajectory_id": self.id,
                "agent": {"name": "diffex", "version": PINS["diffex_version"], "model_name": model},
                "steps": self.steps, "extra": {"native_session": self.path.name}}

    def content(self, content: object) -> str | list[dict]:
        if isinstance(content, str):
            return content
        parts = []
        for block in content if isinstance(content, list) else []:
            if block.get("type") == "text":
                parts.append({"type": "text", "text": block.get("text", "")})
            elif block.get("type") == "image":
                data = base64.b64decode(block["data"], validate=True)
                name = f"trajectory-media/{hashlib.sha256(data).hexdigest()}"
                path = self.export_dir / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                parts.append({"type": "image", "source": {"media_type": block["mimeType"],
                              "path": name}})
            elif block.get("type") not in ("thinking", "toolCall"):
                self.gaps.append("unsupported_content")
        if all(part["type"] == "text" for part in parts):
            return "\n".join(part["text"] for part in parts)
        return parts


def export_trajectory(directory: Path, destination: Path, context: AgentContext, outcome: dict) -> dict:
    """Export before returning to Harbor, including failure/cancellation paths."""
    gaps: list[str] = []
    requested = {}
    try:
        requested = json.loads((directory / "requested.json").read_text())
    except (OSError, ValueError):
        gaps.append("missing_requested_configuration")
    sessions = []
    root_path = directory / "sessions/root.jsonl"
    for path in [root_path, *sorted(path for path in (directory / "sessions").rglob("*.jsonl") if path != root_path)]:
        local_gaps: list[str] = []
        sessions.append(Session(path, read_records(path, local_gaps), local_gaps, destination.parent))
    root = sessions[0]
    root.supplement(read_records(directory / "stdout.jsonl", gaps))
    prompt_path = directory / "system-prompt.txt"
    documents = {session.id: session.convert(requested, prompt_path.read_text() if session is root and prompt_path.exists() else None)
                 for session in sessions}
    if len(documents) != len(sessions):
        raise ValueError("duplicate native session IDs")
    root_document = documents[root.id]
    linked = set()
    interrupted = set()
    for session in sessions:
        document = documents[session.id]
        children = []
        for child_id, child in session.children.items():
            child_document = documents.get(child_id)
            if child_document is None or not child_document["steps"]:
                session.gaps.append("missing_child_trajectory")
                continue
            if child_id == root.id or child_id in linked:
                raise ValueError("cyclic or multiply-owned child session")
            linked.add(child_id)
            children.append(child_document)
            # Shutdown can also mark children interrupted. Accept a deliberate
            # stop only when the parent retained a successful interrupt call.
            if child.get("status") == "interrupted" and any(
                call["function_name"] == "agent_action"
                and call["arguments"].get("action") == "interrupt"
                and call["arguments"].get("target") == child.get("name")
                and any(result.get("source_call_id") == call["tool_call_id"]
                        and result.get("extra", {}).get("is_error") is False
                        for result in step.get("observation", {}).get("results", []))
                for step in document["steps"] for call in step.get("tool_calls", [])
            ):
                interrupted.add(child_id)
                child_document["extra"]["execution_status"] = "interrupted"
            attached = False
            for step in document["steps"]:
                for call in step.get("tool_calls", []):
                    if call["function_name"] != "spawn_agent" or call["arguments"].get("name") != child.get("name"):
                        continue
                    results = step.setdefault("observation", {"results": []})["results"]
                    result = next((result for result in results if result.get("source_call_id") == call["tool_call_id"]), None)
                    if result is None:
                        result = {"source_call_id": call["tool_call_id"], "extra": {"tool_result_missing": True}}
                        results.append(result)
                    result.setdefault("subagent_trajectory_ref", []).append({"trajectory_id": child_id})
                    attached = True
                    break
                if attached:
                    break
            if not attached:
                session.gaps.append("unlinked_child_trajectory")
        if children:
            document["subagent_trajectories"] = children
    # Retain children whose parent metadata was lost on interruption.
    for session in sessions[1:]:
        if session.id not in linked and documents[session.id]["steps"]:
            root_document.setdefault("subagent_trajectories", []).append(documents[session.id])
            gaps.append("unlinked_child_trajectory")
        assistants = [step for step in session.steps if step.get("extra", {}).get("native_role") == "assistant"]
        stop_reason = assistants[-1]["extra"].get("stop_reason") if assistants else None
        # Auth/setup cancellation can arrive as an error before streaming starts.
        # The parent must still prove that it deliberately interrupted this child.
        if (session.id in interrupted and stop_reason == "error"
                and assistants[-1]["extra"].get("error_message") == "This operation was aborted"):
            stop_reason = "aborted"
        if stop_reason != "stop" and not (session.id in interrupted and stop_reason in (None, "aborted", "toolUse")):
            session.gaps.append("child_execution_incomplete")
    for session in sessions:
        last_assistant = next((step for step in reversed(session.steps)
                               if step.get("extra", {}).get("native_role") == "assistant"), None)
        for step in session.steps:
            # A deliberately aborted response may contain unfinished calls
            # that were never dispatched. Earlier calls still need results.
            aborted = (session.id in interrupted and step is last_assistant
                       and step.get("extra", {}).get("stop_reason") == "aborted")
            if step.get("extra", {}).get("incomplete_tool_calls") and not aborted:
                session.gaps.append("incomplete_tool_call")
            for call in step.get("tool_calls", []):
                results = [result for result in step.get("observation", {}).get("results", [])
                           if result.get("source_call_id") == call["tool_call_id"]]
                if not results and not aborted:
                    session.gaps.append("missing_tool_result")
                if call["function_name"] == "spawn_agent":
                    if any(not result.get("extra", {}).get("is_error") and not result.get("subagent_trajectory_ref") for result in results):
                        session.gaps.append("missing_child_link")
    if outcome.get("status") != "completed" or not outcome.get("stream_complete"):
        gaps.append("execution_incomplete")
    for session in sessions:
        gaps.extend(f"{session.id}:{gap}" for gap in session.gaps)
    observed = dict.fromkeys(FIELDS, 0)
    known = set()
    missing = set()
    by_model = defaultdict(lambda: dict.fromkeys(FIELDS, 0))
    for session in sessions:
        own = dict.fromkeys(FIELDS, 0)
        own_known = set()
        own_missing = set()
        for step in session.steps:
            if "metrics" not in step:
                continue
            for field in FIELDS:
                value = step["metrics"].get(field)
                if value is None:
                    missing.add(field)
                    own_missing.add(field)
                else:
                    known.add(field)
                    own_known.add(field)
                    own[field] += value
                    observed[field] += value
                    by_model[step.get("model_name", "unattributed")][field] += value
        documents[session.id]["final_metrics"] = {
            **{f"total_{field}": None if gaps or (field in own_missing and field not in own_known) else value
               for field, value in own.items()},
            "total_steps": len(session.steps),
            "extra": {"scope": "this_session", "observed_usage": own, "accounting_complete": not gaps and not own_missing},
        }
    # Each nested trajectory includes its descendants in its totals. Global
    # usage above still visits each native session exactly once.
    def aggregate(document):
        metrics = document["final_metrics"]
        for child in document.get("subagent_trajectories", []):
            aggregate(child)
            for field in FIELDS:
                key = f"total_{field}"
                values = [value for value in (metrics[key], child["final_metrics"][key]) if value is not None]
                metrics[key] = sum(values) if values else None
            metrics["extra"]["accounting_complete"] &= child["final_metrics"]["extra"]["accounting_complete"]
        metrics["extra"]["scope"] = "session_and_descendants"
    aggregate(root_document)
    # Missing telemetry affects completeness, not the usage already recorded.
    # Keep unknown-only fields null and retain known sums as partial totals.
    totals = {field: None if gaps or (field in missing and field not in known) else value for field, value in observed.items()}
    accounting = {"complete": not gaps and not missing, "gaps": sorted(set(gaps)),
                  "missing_fields": sorted(missing), "observed_usage": observed,
                  "observed_model_usage": dict(by_model), "totals": totals}
    root_document["extra"].update(accounting=accounting, execution_status=outcome.get("status"),
                                  background_process_lifetime=requested.get("background_process_lifetime"),
                                  agent_execution_stopped=outcome.get("agent_execution_stopped"),
                                  retained_processes=outcome.get("retained_processes", []))
    root_document["final_metrics"] = {
        **{f"total_{field}": value for field, value in totals.items()}, "total_steps": len(root.steps),
        "extra": {"scope": "root_and_all_descendants", "observed_usage": observed, "accounting_complete": accounting["complete"]},
    }
    for field, target in zip(FIELDS, CONTEXT_FIELDS):
        setattr(context, target, totals[field])
    # Harbor's ModelUsage defaults missing token fields to zero. Suppress its
    # automatic ATIF backfill when accounting cannot establish complete totals.
    context.model_usage = {model: ModelUsage(**dict(zip(CONTEXT_FIELDS, (values[field] for field in FIELDS))))
                           for model, values in by_model.items()} if accounting["complete"] else {}
    context.metadata = {**(context.metadata or {}), "diffex_accounting": accounting}
    (directory / "accounting.json").write_text(json.dumps(accounting, indent=2, allow_nan=False) + "\n")
    if not root.steps:
        raise ValueError("no recoverable ATIF steps")
    trajectory = Trajectory.model_validate(root_document)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(trajectory.model_dump_json(indent=2, exclude_none=True) + "\n")
    validator = TrajectoryValidator()
    if not validator.validate(temporary):
        raise ValueError("ATIF validation failed")
    temporary.replace(destination)
    return accounting
