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
