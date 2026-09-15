# Diffex Terminal-Bench integration

This private Python package installs and executes the pinned Diffex release through Harbor.
Execution uses explicit model and harness policies, fresh trial state, and retained native sessions.
Execution outcomes include native stream completion, terminal assistant state, retries, process status, configuration, and cleanup verification.
ATIF export and usage accounting run after evidence recovery, including interrupted trials.
The staged benchmark release gate remains a subsequent implementation step.
This integration is not yet ready for leaderboard runs.

## Host setup

Use Python 3.13 and uv (validated with uv 0.11.2).
The benchmark has its own Python environment and lockfile, outside the npm workspaces.

```bash
cd evals/terminal-bench
uv sync --locked
uv run --locked python -c 'from diffex_terminal_bench.adapter import DiffexAgent; print(DiffexAgent.import_path())'
```

The import path is `diffex_terminal_bench.adapter:DiffexAgent`.
Harbor is pinned to `0.23.0` in `pyproject.toml` and `uv.lock`.
The adapter follows that release's `BaseInstalledAgent.install(environment)` interface.
See [Harbor's installed-agent documentation](https://www.harborframework.com/docs/agents).

## Installation contract

The task container must provide Debian/Ubuntu Linux with glibc, root access, Bash, GNU coreutils, and network access to its apt mirrors, nodejs.org, and registry.npmjs.org.
Linux x86_64 and aarch64 have separate pinned Node archive checksums.
The installer fails explicitly on unsupported platforms and refuses to reuse an existing installation.

[pins.toml](src/diffex_terminal_bench/pins.toml) records Node `22.23.2`, Diffex `0.2.2`, the public npm registry, archive checksums, npm integrity, and a 600-second installation deadline.
The deadline includes apt prerequisites, Node download, npm installation, and all three CLI checks.
GNU `timeout` terminates the installer process group at the deadline and kills it after a ten-second grace period.
Harbor's command transport allows another five seconds to collect the result.

Setup installs Node under `/opt/diffex-terminal-bench/node` and uses `npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @diffexai/diffex@0.2.2` with a private prefix.
An isolated home and npm cache prevent host or task npm settings from changing installation.
Node archive SHA-256, registry metadata, installed package version, and npm lockfile integrity must match the checked-in pins.
The `/usr/local/bin/diffex` wrapper always invokes the pinned Node binary.
No monorepo source files or provider credentials are required inside the container.

Setup then runs `diffex --version`, `diffex --help`, and `diffex --list-models` from `/tmp` with stdin closed and a fresh smoke-state directory.
The setup directory under Harbor's agent logs contains installation stdout/stderr, registry metadata, the resolved npm installation lockfile, and stdout/stderr for each CLI check.
`installation.json` is written only after every check passes and records installed versions, integrity, elapsed time, and the deadline.

## Run the Linux installation smoke

Start Docker with Compose support, then run from this directory:

```bash
uv run --locked python scripts/smoke_install.py
uv run --locked python scripts/smoke_install.py --platform linux/arm64
```

[smoke.toml](smoke.toml) pins Ubuntu 24.04 by platform-specific image digest and defaults to Linux amd64.
An arm64 host needs amd64 emulation for the default check; the second command uses native arm64 where available.
Image pull and container startup have a separate 600-second environment deadline.
The runner invokes the actual Harbor `DiffexAgent.setup()` method, including the 600-second installer deadline.
Only a fresh agent log directory is mounted; the runner inspects Docker's actual mounts to reject access to monorepo source or dependencies.
No API keys or model calls are used.

Each invocation writes a unique `results/diffex-install-*/` directory.
Inspect `agent/setup/installation.json`, the CLI stdout/stderr files, and `smoke.json` for the image digest, platform, actual mounts, setup wall time, and cleanup result.
The runner removes its container in a `finally` block and fails if Docker still reports a container for that invocation.
Installation failure logs remain available through the mounted agent log directory.
These are installation checks, not Terminal-Bench task scores.

## Local validation

```bash
uv run --locked python -m unittest discover -s tests -v
uv run --locked python scripts/smoke_execution.py --platform linux/arm64
uv run --locked python scripts/smoke_execution.py --platform linux/amd64
uv run --locked python scripts/smoke_outcomes.py --platform linux/arm64
uv run --locked python scripts/smoke_outcomes.py --platform linux/amd64
uv run --locked python scripts/check_production_contents.py
```

The unit checks cover installation pins, configuration validation, explicit credentials, prompt uploads, fresh trial paths, and subagent policy.
They also cover outcome parsing, incomplete streams, transport failures, log-collection failures, and repeated cancellation during recovery.
Converter checks cover deduplication, tool observations, nested child trajectories, auxiliary usage, unknown telemetry, images, and partial messages.
The execution smoke installs the real npm release, then redirects a fixture model to a loopback faux provider with a test-only wrapper.
It exercises shell and file tools, multiline instructions with shell metacharacters and Unicode, repeated trials, enabled child agents, and non-root execution without paid API calls.
The fixture checks the actual request credentials without storing their values, verifies empty initial sessions and state, and scans retained artifacts for the fixture secrets.
It also checks that task context and the exact release instructions reach the system prompt while project settings, extensions, and `SYSTEM.md` are ignored.
Only the agent log directory is mounted, and each invocation removes its container in a `finally` block.
Generated evidence is retained under `results/diffex-execution-*/`.
Each execution smoke validates ATIF with Harbor's validator and reconciles nonzero input, output, cached-token, and cost totals against every root and child response.
The outcome smoke exercises success, authentication failure, exhausted retry, recovered retry, interrupted JSON output, and a Harbor-style execution timeout as both root and a non-root user.
It uses the pinned npm release with a loopback provider and confirms that zero-exit failures are rejected.
Success and timeout cases create a detached tool descendant that ignores TERM, then verify that cleanup stops it before the next trial.
Evidence is retained under `results/diffex-outcomes-*/`, including partial stdout, stderr, native sessions, process status, cleanup, and outcomes.
The outcome smoke also validates recoverable ATIF steps and checks that interrupted runs report incomplete accounting.
The packaging check packs every public npm workspace into temporary tarballs with lifecycle scripts disabled, inspects their contents for benchmark paths, and records file counts and SHA-256 hashes in `results/production-contents.json`.
It requires existing production build output, including `packages/coding-agent/dist/cli.js`, and fails if that CLI entrypoint is missing.
It does not build, publish, or regenerate release artifacts.
Run `npm run check` from the repository root after changing code.

### Recorded validation

On 2026-09-14, both pinned Ubuntu images passed through Harbor 0.23.0 on Docker Desktop with an arm64 host.

| Container platform | Setup wall time | CLI checks | Cleanup |
| --- | --- | --- | --- |
| Linux amd64, emulated | 38.627 seconds | All three passed | Container removed |
| Linux arm64, native | 14.454 seconds | All three passed | Container removed |

Both installations reported Diffex 0.2.2, Node 22.23.2, npm 10.9.8, and the pinned npm integrity, with empty stderr for the three CLI checks.
The production content check inspected the current checkout's public `@diffexai/diffex@0.2.4` tarball (1,170 entries) and found no benchmark content.
The five unit tests and repository `npm run check` passed.
These observations validate installation on the specified images; broader task-environment coverage remains a later step.

On 2026-09-15, the execution smoke passed four controlled trials on each pinned Linux image (amd64 emulated and arm64 native).
Each platform covered two isolated single-agent trials, an enabled-subagent trial, and a non-root trial, with 16 loopback provider requests and successful container cleanup.
All trials preserved the instruction bytes, selected `openai/gpt-5` with `high` thinking, retained the exact release context, executed shell/file tasks in `/task/work`, and retained their native sessions.
The credential-leak scans, ten unit tests, production package-content check, and repository `npm run check` passed.
These controlled provider responses validate execution plumbing; they do not measure model task performance or validate item 3's outcome handling.

On 2026-09-15, the outcome smoke passed 12 trials on each pinned Linux image, covering all six outcome cases as root and UID 65534.
Authentication failures, exhausted retries, and truncated output from the pinned CLI all exited zero and were correctly rejected by the adapter.
Recovered retries completed successfully, and timeout trials retained their logs and sessions while stopping TERM-resistant detached descendants.
Every successful smoke invocation confirmed container removal.
The prior execution smoke also passed again on both architectures, including enabled subagents.
The 22 adapter unit tests, 11 source print-mode tests, production-content check, and repository `npm run check` passed.
An initial arm64 installation encountered an Ubuntu mirror hash mismatch; the subsequent clean installation passed without changing installation pins or weakening integrity checks.
These results validate controlled execution outcomes and cleanup, not model quality, ATIF export, or the later benchmark release gate.

On 2026-09-15, ATIF validation passed four execution trials and 12 outcome trials on each pinned Linux image.
The execution trials covered single agents, an enabled child agent, and non-root execution, using 16 loopback model responses per platform.
Each single-agent execution reconciled to 57 input tokens, 21 output tokens, 15 cache hits, and USD 0.0000915 in fixture cost telemetry.
Each enabled-subagent execution reconciled to 133 input tokens, 49 output tokens, 35 cache hits, and USD 0.0002135 across seven root/child responses.
The outcome trials retained valid trajectories for authentication errors, exhausted/recovered retries, truncated output, and timeouts; missing telemetry and interrupted accounting remained explicitly unknown.
Both smoke runners confirmed process and container cleanup on both architectures.
The 37 adapter tests, repository `npm run check`, and production-content inspection passed; the public tarball contained no benchmark files.
These checks use controlled responses without paid model calls and do not establish leaderboard readiness or remote artifact-upload completion.

## Execute a controlled task

Start Docker and make the selected provider credential available in the host environment through your normal secret-loading mechanism.
Set the exact `model_name` in `execution.yaml`, then run from this directory with your task path:

```bash
uv run --locked harbor run --config execution.yaml \
  --path /absolute/path/to/task
```

[execution.yaml](execution.yaml) records the default policy and allows 630 seconds for Harbor setup, encompassing the installer's 600-second deadline and transport overhead.
The task's agent timeout remains in effect.
Use `--ak thinking=medium`, `--ak tools=read,bash,edit,write`, or `--ak subagents=enabled` to change the corresponding policy explicitly.
Inspect accepted options with `uv run --locked harbor agent schema diffex_terminal_bench.adapter:DiffexAgent`.
Unknown options, arbitrary native config, prompt templates, injected skills, and MCP servers are rejected.
Model IDs must include a supported provider prefix; fuzzy patterns and thinking suffixes are rejected.
The adapter also checks the resolved model, thinking level, and active tools against the requested configuration after execution.

Supported credential environments are:

| Provider | Credential variables |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |

Harbor's agent `extra_env` takes precedence over the host environment.
Only the selected provider's credential variables are forwarded, using Harbor's `environment.exec(env=...)` mechanism along with the model and thinking configuration.
Credential values never appear in adapter commands or configuration artifacts.
The launcher starts Diffex with an explicit environment, discarding inherited agent directories, credentials for other providers, and configuration overrides.
Stored OAuth accounts, host credentials files, and custom provider endpoints are not imported.

### Prompt and harness policy

The adapter uploads the complete UTF-8 instruction and runs `diffex --mode json --print @instruction.txt` in the task's default working directory and as Harbor's configured agent user.
The CLI receives stdin EOF through `/dev/null` and the launcher's ignored stdin.
Native `@file` transport adds Diffex's standard `<file name="...">` wrapper while retaining all instruction bytes, including leading/trailing whitespace and CRLF line endings.
Instruction contents never become shell command text or command-line flags.
The observer extension checks that the first user message contains exactly that wrapper and the original instruction.
It registers only a `message_start` observer, preserving compatibility with child agents.

Each invocation creates an exclusive `run-<uuid>/` under Harbor's agent logs.
Its fresh `state/` is the `DIFFEX_CODING_AGENT_DIR`, with a fresh home and global `settings.json` containing `{"evolution":{"enabled":false}}` before startup.
No prior settings, credentials, sessions, or evolved harness selections are copied into it.
Startup network updates are disabled with the supported offline setting so the pinned model catalog remains stable.

The `context-only` project policy retains ancestor `AGENTS.md`/`CLAUDE.md` context and disables project trust, discovered extensions, skills, prompt templates, and themes.
It does not pass `--no-context-files` or replace the system prompt.
The pinned npm `0.2.2` release lacks `dist/AGENTS.md`, so the adapter supplies an exact copy of the repository's `AGENTS_release.md` in fresh global context.
If an installed release provides that packaged file, the adapter retains it without adding a global duplicate.
The effective system prompt must contain the release instructions, and their SHA-256 is recorded.

Subagents are disabled by omitting coordination tools from the explicit tool allowlist.
Enabling them adds `spawn_agent`, `agent_action`, and `agents`; the pinned CLI owns child scheduling and its default concurrency limit.
Root and child sessions are retained together beneath `run-<uuid>/sessions/`, including the parent-owned child session directories.

### Execution evidence

Each run directory retains:

- `requested.json`: pins, model, thinking, tools, subagent policy, project policy, credential variable names, and instruction hash.
- `instruction.txt`: the original instruction.
- `effective.json`: resolved model, thinking, tools, working directory, session path, prompt hashes, and release-context verification.
- `system-prompt.txt`: the effective system prompt, including release and task context.
- `stdout.jsonl`, `stderr.log`, and `process.json`: native JSON events, diagnostics, and process status.
- `launcher.json` and `cleanup.json`: launcher process identity and verified cleanup status.
- `launcher.stdout.log` and `launcher.stderr.log`: launcher diagnostics, including failures before CLI startup.
- `outcome.json`: execution classification, stream completeness, final assistant stop reason, retry counts, interruption state, and recovery errors.
- `accounting.json`: observed usage, nullable totals, per-model observations, and reasons accounting is incomplete.
- `sessions/` and `state/`: native root/child history and isolated harness state.

Harbor collects the agent log tree after the run; avoid log filters that exclude these paths.
`trajectory.json` sits directly under Harbor's agent log directory, with embedded child trajectories and optional `trajectory-media/` image files.
Provider usage fields in `AgentContext` contain reconciled totals when the evidence establishes them.
`AgentContext.metadata.diffex_outcome` contains the execution outcome, and `diffex_run_dir` identifies its artifacts.

### Execution outcomes and interruption recovery

A completed execution requires zero CLI and launcher exit codes, no terminating signal or spawn error, matching effective configuration, and verified cleanup.
The parser reads JSONL incrementally and requires matching assistant messages, a final `stop` response, closed message/run boundaries, resolved retries, and the native `agent_settled` event.
Malformed or truncated lines, missing completion events, pending tool use, token-limit termination, and unresolved retries cannot count as completed runs.
Earlier provider errors are recoverable when retry events and the subsequent terminal assistant state establish success.
Tool errors alone do not fail execution: the assistant can inspect and recover from them.

| Evidence | Adapter outcome | Harbor behavior |
| --- | --- | --- |
| Complete successful run, including recovered retry | `completed` | Return normally; verifier determines reward |
| Terminal authentication error | `authentication_failure` | Raise `AgentAuthenticationError` |
| Terminal assistant error or failed retry | `provider_failure` | Raise `DiffexExecutionError` |
| Nonzero process, signal, or spawn error | `process_failure` | Raise `DiffexExecutionError` |
| Missing, truncated, or unfinished native stream | `incomplete` | Raise `DiffexExecutionError` |
| Effective configuration mismatch | `configuration_failure` | Raise `DiffexExecutionError` |
| Unverified cleanup or failed evidence collection | `cleanup_failure` / `infrastructure_failure` | Raise `DiffexExecutionError` |
| Harbor task deadline cancels `run()` | `cancelled` | Preserve cancellation; Harbor raises `AgentTimeoutError` |
| Environment transport timeout or failure | `timeout` / `transport_failure` | Preserve the original exception |

`DiffexExecutionError` subclasses Harbor's `NonZeroAgentExitCodeError`, so infrastructure failures retain exception information rather than becoming ordinary zero-reward results.
The adapter never sets or infers verifier reward.
A completed assistant that produces an incorrect solution returns normally and can earn zero from the verifier.
The pinned `0.2.2` release remains unchanged; adapter parsing handles its zero-exit terminal errors.
The source CLI fix makes terminal assistant errors and aborts return nonzero in JSON mode as well as text mode, and requires a future release to reach the pinned installation.

The launcher writes stdout and stderr directly to files and retains native sessions during execution.
On success, failure, or cancellation, an independent Harbor exec requests launcher shutdown, stops the CLI process group, and scans Linux `/proc` for same-user descendants carrying the trial's unique environment marker.
Process start times protect against signaling a reused PID.
Cleanup escalates from TERM to KILL after five seconds, waits up to two more seconds, and records whether any live tracked processes remain.
Already exited zombies cannot execute and are left for sandbox init to reap.
A stop-request file prevents delayed launch after transport cancellation.
Task commands must preserve the inherited trial environment marker for detached descendants to remain discoverable.
Harbor must still delete the sandbox after the trial for complete environment isolation.

Recovery is shielded against repeated cancellation and runs before `run()` returns or re-raises the interruption.
It allows up to 15 seconds for the cleanup transport and 15 seconds for mounted-log preparation or 30 seconds for remote log download.
The final summary is written directly to host agent logs after recovery, so later remote log collection cannot overwrite a cancellation classification.
These bounded recovery operations can extend the task deadline; they do not grant the agent additional task execution time.
If the sandbox transport becomes unavailable, available host logs and recovery diagnostics remain, cleanup is not reported as successful, and Harbor's environment teardown remains necessary.
Avoid log filters that discard the retained evidence.

### ATIF export and accounting

The converter emits `ATIF-v1.8` using the models and validator shipped with pinned Harbor 0.23.0.
See [Harbor's ATIF documentation](https://www.harborframework.com/docs/agents/trajectory-format) for the schema and validation command.
It writes the final trajectory atomically after cleanup and evidence collection, before returning to Harbor.
Export failure changes an otherwise completed execution to `infrastructure_failure`; it preserves an existing provider failure or cancellation.
An empty run with no recoverable steps retains accounting diagnostics without fabricating a trajectory.

Native session message entries are authoritative, including history retained before compaction.
Unmatched root `message_end` events supplement responses absent from persistence, such as discarded retries.
Matching uses provider/model/response ID within a session, falling back to the complete message including its native timestamp when no response ID exists.
Repeated native entry IDs and assistant response identities count once.
`message_start`, `message_update`, `turn_end`, and `agent_end` copies never add another charge for a completed response.
The last unfinished streamed assistant message is retained as partial, with unknown usage.
Malformed JSONL records do not discard intact earlier or later records, but they make accounting incomplete.

Assistant tool calls and their native `toolResult` observations share an ATIF step and match by tool-call ID.
Completed `tool_execution_end` events recover observations missing from message persistence.
Unresolved observations remain system observations with their original call ID in metadata.
User messages, custom context messages, visible thinking, tool errors, and summary text remain in the trajectory.
Images are decoded into content-addressed files under `trajectory-media/`, with paths relative to `trajectory.json`.

Child sessions are collected recursively, including hidden `.subagents` directories.
The parent roster's `childSessionId` identifies each child, and its agent name links the child trajectory to the matching `spawn_agent` observation.
Repeated roster snapshots do not duplicate children or their usage.
Nested child trajectories are embedded with resolvable `trajectory_id` references so uploading the root JSON also uploads their steps.
Missing child sessions, missing observations, and incomplete child execution are explicit accounting gaps.
Recoverable orphan child histories are embedded with an unresolved-link diagnostic.

| Native Diffex usage | ATIF step metric | Harbor `AgentContext` |
| --- | --- | --- |
| `input + cacheRead + cacheWrite` | `prompt_tokens` | `n_input_tokens` |
| `output` | `completion_tokens` | `n_output_tokens` |
| `cacheRead` | `cached_tokens` | `n_cache_tokens` |
| `cost.total` | `cost_usd` | `cost_usd` |

Cache writes contribute to prompt tokens, but are not cache hits.
`metrics.extra.cache_write_tokens`, uncached input, and the native usage object preserve the additional detail.
`totalTokens` is not added separately because it already aggregates token categories.
Native cost is reported as recorded; the converter does not reprice responses or claim it is an independently verified provider invoice.
Every trajectory's final token and cost totals include its descendants; `total_steps` counts its own steps.
The root context totals visit each native session exactly once, without summing child-inclusive parent totals again.

Compaction and branch-summary entries contribute their `usage` when available, without dropping the earlier responses they summarize.
Their model attribution is `unattributed` because those entries do not identify the model that produced the summary.
Missing summary usage or a compaction start without a persisted summary marks accounting incomplete.
Work with no native telemetry cannot be reconstructed, and interrupted runs cannot establish a complete total.
An all-zero native usage object is treated as unverified because Diffex initializes those fields before receiving provider usage.
Missing or invalid individual usage fields remain unknown; other measured fields can still have totals when the rest of the execution evidence is complete.

`AgentContext.metadata.diffex_accounting` and `accounting.json` retain observed lower bounds, missing fields, and structural gaps.
Unknown context totals are `null`, and unknown ATIF totals are omitted.
`model_usage` contains per-model totals when accounting is complete; otherwise it is empty to prevent Harbor from backfilling incomplete token data as zero.
`diffex_trajectory.validated` records successful export, and `accounting_complete` separately records accounting completeness.
Verifier reward is independent of accounting completeness.

For leaderboard validation, require a validated trajectory and complete accounting for every rewarded trial, then upload the entire agent log tree including `trajectory.json` and `trajectory-media/`.
Validate the downloaded/uploaded artifact copy using the command below; a local export alone is not proof of remote upload.
Submission destination, credentials, and the benchmark release gate belong to the later benchmark-validation stage.

```bash
uv run --locked python -m harbor.utils.trajectory_validator /path/to/trial/agent/trajectory.json
```

## Production exclusion

This directory is outside every npm workspace and every production package's file allowlist.
The repository root is npm-private, and this Python package carries the `Private :: Do Not Upload` classifier.
Do not publish it to npm or PyPI.
Generated environments, Python caches, `results/`, and Harbor `jobs/` are ignored locally.

## Updating pins

Change the Harbor requirement and matching runtime pin together, then regenerate `uv.lock` with `uv lock` and review the dependency changes.
Update Node checksums from the selected release's [official SHASUMS256.txt](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).
For Diffex, query the exact release with `npm view @diffexai/diffex@VERSION version dist engines --json --registry=https://registry.npmjs.org/` and review the new version, engine requirement, and integrity.
Rerun the clean Linux installation checks after any pin change.
