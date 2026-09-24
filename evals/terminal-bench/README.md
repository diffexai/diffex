# Diffex Terminal-Bench integration

This private Python package installs and executes the pinned Diffex release through Harbor.
Execution uses explicit model and harness policies, fresh trial state, and retained native sessions.
Execution outcomes include native stream completion, terminal assistant state, retries, process status, configuration, and cleanup verification.
ATIF export and usage accounting run after evidence recovery, including interrupted trials.
The [staged benchmark release gate](RELEASE_GATE.md) pins dataset inputs and verifies retained evidence before larger Daytona runs.
Use the [offline job exporter](RELEASE_GATE.md#export-retained-trials-for-harbor-hub) to package existing stage results for Harbor Hub without rerunning evaluations.
This integration is not yet ready for leaderboard runs.
The adapter now requires a release with `--background-process-lifetime` and `--background-process-ownership-dir` support.
The checked-in Diffex 0.3.1 pin supports these flags; installation verifies their availability alongside the release integrity.
Source-only lifecycle tests do not qualify the installed release or a live benchmark trial.

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

## Full evaluation with additional sandbox storage

The native full job uses [full.yaml](full.yaml): 89 tasks, five attempts each, three concurrent trials, and no automatic retries.
It selects `RecordedDaytonaEnvironment` to retain logs and transcripts in one shared Daytona volume with isolated sandbox subpaths.
For an existing command that uses `--env daytona` without this config, replace that option with `--env diffex_terminal_bench.daytona_backend:RecordedDaytonaEnvironment` to enable volume storage.
See [artifact collection and retention](ARTIFACTS.md) for recovery records, retry bounds, and Tier 4 quota considerations.
It requests 20 GiB of disk per sandbox so task files and Harbor's temporary log archive have more room than the failing 10 GiB allocation.
This is an explicit resource override, not an evaluation with the official task resource limits unchanged.
Daytona must allow the requested per-sandbox allocation and enough total storage for concurrent sandboxes.
The extra disk reduces the risk of archive failures; it does not guarantee that an unbounded task cannot fill the disk.

After exporting `DAYTONA_API_KEY` and `OPENAI_API_KEY`, prepare and inspect a fresh job in zsh:

```zsh
TB_OUTPUT="results/full-89x5-tb21-$(date +%Y%m%d-%H%M%S)-$(uuidgen)"
TB_STORAGE_MB=20480
mkdir -p "$TB_OUTPUT"
git rev-parse HEAD > "$TB_OUTPUT/adapter-commit.txt"
TB_RUN=(uv run --locked harbor run --config full.yaml
  --override-storage-mb "$TB_STORAGE_MB"
  --jobs-dir "$TB_OUTPUT" --job-name full)
"${TB_RUN[@]}" --print-config > "$TB_OUTPUT/planned-config.json"
cat "$TB_OUTPUT/planned-config.json"
```

Start only after reviewing the resolved configuration:

```zsh
"${TB_RUN[@]}"
```

Use a new output directory when changing disk allocation; do not mix results from different resource limits.
The adapter installs the published version in `pins.toml`, so local runtime fixes require a new published release and a reviewed pin update before they are exercised by this job.

## Installation contract

The task container must provide Debian/Ubuntu Linux with glibc, root access, Bash, GNU coreutils, and network access to its apt mirrors, nodejs.org, and registry.npmjs.org.
Linux x86_64 and aarch64 have separate pinned Node archive checksums.
The installer fails explicitly on unsupported platforms and refuses to reuse an existing installation.

[pins.toml](src/diffex_terminal_bench/pins.toml) records Node `22.23.2`, Diffex `0.3.1`, the public npm registry, archive checksums, npm integrity, and a 600-second installation deadline.
The deadline includes apt prerequisites, Node download, npm installation, and all three CLI checks.
GNU `timeout` terminates the installer process group at the deadline and kills it after a ten-second grace period.
Harbor's command transport allows another five seconds to collect the result.

Setup installs Node under `/opt/diffex-terminal-bench/node` and uses `npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @diffexai/diffex@0.3.1` with a private prefix.
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
node --test tests/launcher.test.cjs
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
It uses the pinned npm release with a loopback provider and checks nonzero terminal-error exits and rejection of truncated output even when the process exits zero.
Success, provider-failure, forced-CLI-death, and timeout cases create a TERM-resistant background service and verify that its PID and start time are unchanged across adapter cleanup.
The verifier phase queries that same service and checks that the launcher, CLI, and provider requests have stopped.
The Linux cleanup regression independently creates a detached service with durable handoff evidence, and covers PID reuse, delayed launch, malformed records, and TERM-resistant active work.
Evidence is retained under `results/diffex-outcomes-*/`, including partial stdout, stderr, native sessions, process status, cleanup, and outcomes.
The outcome smoke also validates recoverable ATIF steps and checks that interrupted runs report incomplete accounting.
The packaging check packs every public npm workspace into temporary tarballs with lifecycle scripts disabled, inspects their contents for benchmark paths, and records file counts and SHA-256 hashes in `results/production-contents.json`.
It requires existing production build output, including `packages/coding-agent/dist/cli.js`, and fails if that CLI entrypoint is missing.
It does not build, publish, or regenerate release artifacts.
Run `npm run check` from the repository root after changing code.

### Source lifecycle validation

To validate unpublished lifecycle changes, build the development-only image from the repository root:

```bash
docker build --platform linux/arm64 -f evals/terminal-bench/tests/fixtures/Dockerfile.source -t diffex-adapter-tests:arm64 .
cd evals/terminal-bench
uv run --locked python scripts/smoke_outcomes.py --platform linux/arm64 --source-image diffex-adapter-tests:arm64
uv run --locked python scripts/smoke_outcomes.py --platform linux/arm64 --source-image diffex-adapter-tests:arm64 --grpc-fixture
docker run --rm --init --user 65534:65534 -v "$PWD:/eval:ro" diffex-adapter-tests:arm64 node --test /eval/tests/cleanup.test.cjs
```

Repeat with `linux/amd64` and an `amd64` image tag for emulated coverage on an arm64 host.
Run the cleanup regression without `--user` for root coverage.
The development image installs dependencies without lifecycle scripts and runs the source CLI through `tsx`.
The gRPC fixture uses a known-correct implementation and all seven unmodified verifier tests extracted from the SHA-256-verified dataset archive.
It checks the original process identity before and after verifier RPCs and confirms container deletion afterward.
Every development smoke report is marked `qualification: source-only`.
After changing `pins.toml`, rerun both pinned-release Linux smokes and start a fresh live benchmark trial before declaring integration qualification complete.

On 2026-09-20, source-only validation passed 16 controlled outcome cases on each architecture, including root and UID 65534 execution.
Both architectures also passed all seven pinned gRPC verifier tests with unchanged service identity and confirmed container deletion.
The Linux cleanup suite passed seven deterministic cases, including forced death before CLI identity publication, and all 142 Python tests and `npm run check` passed.
The retained outcome reports are `results/diffex-outcomes-8dab466d6f5c/smoke.json` (arm64) and `results/diffex-outcomes-284ee6f0c224/smoke.json` (amd64).
The gRPC reports are `results/diffex-outcomes-8d83db9627fb/smoke.json` (arm64) and `results/diffex-outcomes-da1f6f5534a3/smoke.json` (amd64).
These local source checks leave pinned-release smokes and a fresh live benchmark trial pending.

### Recorded validation

The following historical smoke records used Diffex 0.2.2.
They do not qualify the updated Diffex 0.3.1 / Terminal-Bench 2.1 configuration.

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

### Diffex 0.2.4 pin validation

On 2026-09-15, Diffex 0.2.4 passed four execution trials and 12 outcome trials on each pinned Linux image (arm64 native and amd64 emulated).
Installation integrity and CLI checks passed, the packaged release context loaded without duplication, and both runners confirmed process and container cleanup.
Execution trajectories reconciled root and child usage; failed and interrupted outcomes retained validated ATIF with incomplete accounting where appropriate.
All 55 adapter tests, `npm run check`, `./test.sh`, and production-content inspection passed.
Dataset preparation verified all 89 Terminal-Bench 2.1 tasks and the ten declared pilot selections from the pinned source archive.
These controlled tests use a loopback provider; a new Daytona oracle and live Diffex trial remain necessary for the updated qualification identity.

### Diffex 0.2.5 pin validation

On 2026-09-17, the published Diffex 0.2.5 tarball matched its npm integrity and the checked-in release instructions.
Four execution trials and 12 outcome trials passed on each pinned Linux image (arm64 native and amd64 emulated), with verified installation, validated trajectories, reconciled execution usage, and confirmed container cleanup.
The enabled-subagent allowlist uses the release's renamed `wait_for_agents` tool.
Authentication and exhausted-retry cases returned exit code 1; truncated output remained rejected even with exit code 0.
An initial arm64 setup encountered an Ubuntu mirror hash mismatch; subsequent clean installations passed without weakening checksum checks.
All 120 adapter tests and `npm run check` passed.
These checks used a loopback provider; live Daytona qualification must start a new sequence for the updated pins and adapter identity.

### Diffex 0.2.6 pin validation

On 2026-09-18, the published Diffex 0.2.6 tarball matched its npm integrity, and the adapter's release instructions were synchronized with the packaged `dist/AGENTS.md`.
Clean installation checks passed on both pinned Linux images (arm64 native and amd64 emulated), including version, help, model listing, and container cleanup.
The packaged OpenAI catalog supports `gpt-5.6-luna` with `max` thinking, now selected in `benchmark.toml`.
All 120 adapter tests and `npm run check` passed.
These checks did not call a live model; Daytona qualification requires a fresh sequence for the updated identity.

### Diffex 0.3.1 pin validation

On 2026-09-20, the published Diffex 0.3.1 tarball matched its npm integrity and the checked-in release instructions.
Four execution trials and 16 outcome trials passed on each pinned Linux image (arm64 native and amd64 emulated), including root and UID 65534 execution, enabled subagents, validated trajectories, and confirmed container cleanup.
The lifecycle cases verified environment-owned service retention after successful execution, provider failure, and forced agent death.
All 142 adapter tests and `npm run check` passed.
The retained execution reports are `results/diffex-execution-a6196c0988e3/smoke.json` (arm64) and `results/diffex-execution-91c70a4694a1/smoke.json` (amd64).
The retained outcome reports are `results/diffex-outcomes-dea6f3573741/smoke.json` (arm64) and `results/diffex-outcomes-94cec6443269/smoke.json` (amd64).
These checks used a loopback provider; live Daytona qualification requires a fresh sequence for the updated pins and adapter identity.

## Execute a controlled task

Start Docker and make the selected provider credential available in the host environment through your normal secret-loading mechanism.
Set the exact `model_name` in `execution.yaml`, then run from this directory with your task path:

```bash
uv run --locked harbor run --config execution.yaml \
  --path /absolute/path/to/task
```

[execution.yaml](execution.yaml) records the default policy and allows 630 seconds for Harbor setup, encompassing the installer's 600-second deadline and transport overhead.
The task's agent timeout remains in effect.
Use `--ak thinking=medium`, `--ak tools=read,bash,edit,write`, or `--ak subagents=disabled` to change the corresponding policy explicitly.
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
Its `DIFFEX_CODING_AGENT_DIR` is a fresh private `/tmp/diffex-tb-state-*` directory on sandbox disk, with a fresh home and global `settings.json` containing `{"evolution":{"enabled":false}}` before startup.
Packages and caches remain outside the exported logs and survive until sandbox teardown so retained task services can use them during verification.
No prior settings, credentials, sessions, or evolved harness selections are copied into it.
Startup network updates are disabled with the supported offline setting so the pinned model catalog remains stable.

The `context-only` project policy retains ancestor `AGENTS.md`/`CLAUDE.md` context and disables project trust, discovered extensions, skills, prompt templates, and themes.
It does not pass `--no-context-files` or replace the system prompt.
The pinned npm `0.3.1` release includes `dist/AGENTS.md`, which matches the adapter's checked-in release instructions.
The adapter retains that packaged context without adding a global duplicate.
The effective system prompt must contain the release instructions, and their SHA-256 is recorded.

The checked-in `benchmark.toml` disables subagents, omitting `spawn_agent`, `agent_action`, and `agent_status` from the explicit tool allowlist.
The separate controlled smoke configuration in `execution.yaml` enables subagents and includes those tools.
Diffex decides whether to call those tools; enabling them does not require a child on every task.
Children share their trial's sandbox, and the pinned CLI owns child scheduling and its default concurrency limit.
The staged runner's `-n/--concurrency` controls simultaneous trials and sandboxes separately.
An adapter invocation that omits the subagent policy still defaults to disabled, omitting coordination tools.
Root and child sessions are retained together beneath `run-<uuid>/sessions/`, including the parent-owned child session directories.

### Execution evidence

Each run directory retains:

- `requested.json`: pins, model, thinking, tools, subagent policy, project policy, credential variable names, and instruction hash.
- `instruction.txt`: the original instruction.
- `effective.json`: resolved model, thinking, tools, working directory, session path, prompt hashes, and release-context verification.
- `system-prompt.txt`: the effective system prompt, including release and task context.
- `stdout.jsonl`, `stderr.log`, and `process.json`: native JSON events, diagnostics, and process status.
- `launcher.json` and `cli.json`: launcher and root CLI PID/start-time identities.
- `ownership/*.json`: durable shell ownership records published by the CLI.
- `stop-requested` and `cleanup.json`: the launch barrier, verified control shutdown, and explicitly retained environment-owned processes.
- `launcher.stdout.log` and `launcher.stderr.log`: launcher diagnostics, including failures before CLI startup.
- `outcome.json`: execution classification, stream completeness, final assistant stop reason, retry counts, interruption state, shutdown recovery errors, and separate artifact errors.
- `accounting.json`: observed usage, nullable totals, per-model observations, and reasons accounting is incomplete.
- `sessions/`: native root/child history.
- `state.json`: sandbox-local harness state and home paths, without exporting their contents.

Harbor collects the agent log tree after the run; avoid log filters that exclude these paths.
`trajectory.json` sits directly under Harbor's agent log directory, with embedded child trajectories and optional `trajectory-media/` image files.
Provider usage fields in `AgentContext` contain reconciled sums of recorded usage, with accounting completeness recorded separately.
`AgentContext.metadata.diffex_outcome` contains the execution outcome, and `diffex_run_dir` identifies its artifacts.

### Execution outcomes and interruption recovery

A completed execution requires zero CLI and launcher exit codes, no terminating signal or spawn error, matching effective configuration, and verified cessation of agent execution.
Environment-owned services may remain alive for shared-environment verification.
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
| Unverified agent shutdown or missing shutdown evidence | `cleanup_failure` | Raise `DiffexControlStopError`; block verification |
| Failed artifact collection with verified shutdown | `artifact_collection_failure`, or preserve an existing failure | Record `artifact_errors`; permit verification |
| Harbor task deadline cancels `run()` | `cancelled` | Preserve cancellation; Harbor raises `AgentTimeoutError` |
| Environment transport timeout or failure | `timeout` / `transport_failure` | Preserve the original exception |

`DiffexExecutionError` subclasses Harbor's `NonZeroAgentExitCodeError`, so infrastructure failures retain exception information rather than becoming ordinary zero-reward results.
The adapter never sets or infers verifier reward.
A completed assistant that produces an incorrect solution returns normally and can earn zero from the verifier.
The pinned `0.3.1` release returns nonzero for terminal assistant errors and aborts in JSON mode as well as text mode.
The adapter also parses native events to classify provider failures and reject incomplete output independently of process exit status.

The launcher writes stdout and stderr directly to files and retains native sessions during execution.
On success, failure, or cancellation, an independent Harbor exec writes the stop barrier and signals identified launcher and CLI processes individually.
A private pipe prevents CLI startup until the launcher has recorded its PID and start time; launcher death before publication closes the pipe without starting agent execution.
No launcher process-group signal can include a retained service.
After control processes exit, cleanup reads durable ownership records and scans Linux `/proc` for trial-marked processes and identified shell groups.
Linux boot ID, PID, start time, process group, and shell execution tokens distinguish transferred groups from reused process IDs.
Environment-owned groups survive; active or otherwise untransferred work receives TERM, escalating to KILL within a seven-second recovery budget.
Control escalation begins after three seconds, reserving time for active descendants; active-work escalation begins after five seconds.
Already exited zombies cannot execute and are left for sandbox init to reap.
The report records `agent_execution_stopped`, `ownership_validated`, `remaining_agent_pids`, control identities, retained service identities, and the consumed ownership records.
Outcome parsing and gate validation reconcile these records with retained files.
`cleanup_confirmed` in the outcome means pre-verifier agent shutdown, not an empty sandbox.
Missing, malformed, contradictory, or unverified shutdown evidence raises `DiffexControlStopError`, which is outside Harbor's verifier-eligible timeout and nonzero-exit exceptions.
This exception overrides a pending cancellation while retaining its interrupted outcome in the evidence.
Verified shutdown preserves Harbor's existing verification behavior for deadlines and nonzero agent exits without changing their failed classifications.
Task commands must preserve the inherited trial marker or remain in an identified shell group for unfinished descendants to remain discoverable.
Harbor stops the shared environment after verification, including verifier failure or timeout recovery; separate-environment verification keeps Harbor's artifact-based lifecycle.
The benchmark runner independently confirms sandbox deletion after every trial, including abandonment and transport failures.

Recovery is shielded against repeated cancellation and runs before `run()` returns or re-raises the interruption.
It allows up to 15 seconds for cleanup transport, then retrieves and validates only shutdown evidence with three bounded attempts within 90 seconds.
After shutdown validation, it allows 15 seconds for mounted-log preparation or 30 seconds for bulk remote log download.
Bulk download and local artifact persistence failures cannot invalidate independently confirmed shutdown.
The final summary is written directly to host agent logs after recovery, so later remote log collection cannot overwrite a cancellation classification.
These bounded recovery operations can extend the task deadline; they do not grant the agent additional task execution time.
If the sandbox transport becomes unavailable, available host logs and recovery diagnostics remain, cleanup is not reported as successful, and Harbor's environment teardown remains necessary.
Avoid log filters that discard the retained evidence.

### ATIF export and accounting

The converter emits `ATIF-v1.8` using the models and validator shipped with pinned Harbor 0.23.0.
See [Harbor's ATIF documentation](https://www.harborframework.com/docs/agents/trajectory-format) for the schema and validation command.
It writes the final trajectory atomically after cleanup and evidence collection, before returning to Harbor.
Export failure changes an otherwise completed execution to `artifact_collection_failure`; it preserves an existing provider failure or cancellation.
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
A child marked `interrupted` in the parent roster is a valid terminal state when a successful parent `agent_action` interrupt call establishes intent.
An intentional stop can end during a model response or tool execution; it does not require an additional final assistant reply.
A child marked `failed` in the final parent roster with a nonempty error is also a recorded terminal outcome.
Its trajectory retains `execution_status: failed`, the scheduler's `execution_error`, and native response errors; it does not require a successful final assistant reply.
The parent can finish normally despite that child failure, and the verifier independently determines the task reward.
Missing child sessions, malformed records, unresolved tool calls, unproven interruptions, root execution failures, and cleanup failures still fail qualification.
Missing usage telemetry remains explicitly incomplete and does not erase known usage.
This policy runs in the local Python adapter and needs no new Diffex npm release.
The staged runner requires a clean committed checkout and fresh output for the changed adapter identity; existing runs and retained reports are not rewritten.

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
Missing summary usage marks accounting incomplete; a compaction start without a persisted summary also leaves an evidence gap.
Work with no native telemetry cannot be reconstructed; an aborted request without telemetry prevents a complete total.
An all-zero native usage object is treated as unverified because Diffex initializes those fields before receiving provider usage.
Missing individual usage fields remain unknown; invalid values are evidence errors.

`AgentContext.metadata.diffex_accounting` and `accounting.json` retain observed lower bounds, missing fields, and structural gaps.
When execution evidence is valid, totals retain the known usage across the root and all children even if individual requests lack telemetry.
Such totals are partial lower bounds, with `complete: false` in accounting and `accounting_complete: false` in ATIF final-metric metadata.
Fields with no known observations remain `null` in context totals and are omitted from ATIF totals.
Structural evidence gaps still invalidate totals and fail qualification.
`model_usage` contains per-model totals when accounting is complete; otherwise it is empty to prevent Harbor from backfilling incomplete token data as zero.
Per-model observations remain available in `observed_model_usage` even when accounting is partial.
`diffex_trajectory.validated` records successful export, and `accounting_complete` separately records accounting completeness.
Verifier reward is independent of accounting completeness.
The internal qualification gate accepts valid executions with partial accounting, records `usage_complete` and `usage_missing_fields`, and continues the stage.

For leaderboard validation, require a validated trajectory and complete accounting for every rewarded trial, then upload the entire agent log tree including `trajectory.json` and `trajectory-media/`.
Validate the downloaded/uploaded artifact copy using the command below; a local export alone is not proof of remote upload.
The [release gate](RELEASE_GATE.md) documents staged execution, CI artifact verification, and the separate official submission requirements.

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
