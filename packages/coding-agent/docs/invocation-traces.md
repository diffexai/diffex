# Invocation Traces

Diffex creates one invocation trace for each CLI process whose initial session is persisted.
Ephemeral commands such as `--no-session`, `--help`, and `--list-models` do not create traces.

Trace creation is passive.
If the trace file cannot be created, Diffex prints one warning and continues without durable telemetry.

## Storage and Discovery

Trace files are stored in `~/.diffex/agent/traces/` by default, or beneath the directory selected by `DIFFEX_CODING_AGENT_DIR`.
Each file is named `<UTC timestamp>_<trace ID>.jsonl`.
The trace directory is restricted to the current user with mode `0700`, and each trace file uses mode `0600` on POSIX systems.

Tools can discover traces by scanning this directory for `.jsonl` files and validating them with the harness trace reader.
The trace header identifies the producing Diffex build and runtime.
Session attachment records identify every referenced session ID, path, format, and transition reason.

## Retention and Session Changes

Traces are retained until the user explicitly removes them.
Diffex does not currently apply an automatic age or size limit.

Deleting a session does not delete its traces.
Moving or renaming a session does not rewrite existing trace references.
This preserves invocation evidence while allowing readers to report that referenced session content is missing or moved.

Trace files contain execution telemetry and immutable session entry references, not duplicated transcript content.

## Evidence Ownership

Each fact has one authoritative source so a trace remains compact and materialization does not create competing copies.

| Source | Authoritative facts | Materialized form |
| --- | --- | --- |
| Coding-agent v3 session JSONL | Messages, assistant tool calls, tool results, message usage, model and thinking changes, compaction and branch summaries, custom extension entries, labels, and session metadata | `session_item` evidence selected by entry ordinal, entry ID, and digest |
| AgentHarness session JSONL | Durable entries, operation admission and settlement, abort requests, retry attempts, tool admission, queue changes, deferred writes, usage, lane pointers, and session facts | `session_item` evidence selected by durable session sequence |
| Agent and AI telemetry spans | Agent runs, turns, logical provider requests, provider outcomes, tool execution outcomes, usage, and causal invocation, turn, request, and tool-call identifiers | Consolidated `span` evidence |
| Coding-agent and extension telemetry spans | User-visible operations, retries and sleeps, extension hook outcomes, subagent coordination, terminal commands, external artifact references, and runtime diagnostics | Consolidated `span` evidence |
| Trace lifecycle records | Producer identity, session bindings, harness activation, session segments, trace writer degradation, and completed, failed, or aborted process termination | `trace_record` evidence and document diagnostics |
| Missing trace footer | A process that did not close its trace orderly | A `crashed` materialized termination status with a missing-footer diagnostic |

Agent and extension events remain live notification APIs.
Their durable facts are represented by the owning session entry, session record, or telemetry span listed above rather than by copying event payloads into the trace.

Startup and configuration failures are recorded as runtime diagnostic spans after trace creation.
Failures that prevent trace creation remain an explicit limitation because no durable trace destination exists.

## Materialization

`materializeJsonlInvocation()` reads and validates a trace, resolves every referenced session binding, verifies each segment boundary, and returns a versioned `MaterializedInvocation` document.
The optional session path resolver can locate a session that moved after the trace was written while preserving both its recorded and resolved paths.

Coding-agent v3 content digests are SHA-256 hashes of `JSON.stringify(entry)`.
Prefix digests are SHA-256 hashes of the LF-framed canonical entry JSON from the first non-header entry through the referenced entry.
AgentHarness segments use inclusive durable session sequence bounds.

The materializer embeds only session items referenced by trace segments.
It preserves message and tool payloads exactly as stored in the session, combines span starts, events, and settlements, and retains every contributing trace record ID, span ID, session binding ID, session entry ID, and session sequence.

Evidence is ordered deterministically by trace sequence, session cursor, timestamp, span parentage, and causal identifiers.
Session cursor order is durable inside a segment, but the document reports ordering ambiguity when clocks and segment boundaries cannot establish a total order with trace records.

Missing, changed, truncated, or incompatible session data produces diagnostics without discarding valid trace records or earlier session evidence.
Writer-degraded and crashed traces likewise produce partial documents instead of failing materialization.

`serializeMaterializedInvocation()` emits stable, indented JSON with a trailing newline for storage or bounded LLM analysis.
The materialized document contains evidence only and does not include extracted claims, evolution proposals, approval state, or behavior mutations.
