# Terminal-Bench release gate

This gate qualifies a specific Diffex adapter, dataset, model, and harness configuration for a larger benchmark run.
It does not publish a product release or submit a leaderboard entry.
The implementation supports all qualification stages; live Diffex qualification remains pending a model-provider credential.

## Configuration and prerequisites

Use a clean committed checkout, Python 3.13, uv 0.11.2, Git, and a Daytona Cloud account.
Run all commands below from `evals/terminal-bench/`.
No Docker installation is needed for the Daytona runner.
Docker is required for the separate controlled Linux smoke tests.

```bash
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
uv run --locked python -m diffex_terminal_bench.benchmark --prepare
```

[benchmark.toml](benchmark.toml) pins Terminal-Bench 2.1 at Git commit `7131e4375048a0e408a8fb404b5f499d726b695b` from the [upstream repository](https://github.com/harbor-framework/terminal-bench-2-1/tree/7131e4375048a0e408a8fb404b5f499d726b695b).
The archive SHA-256 is `aa992a8848a1f3ed5191a34fa72ed5700d67dd9f968413a0e0a567b6188cb527`.
The runner verifies the archive before extraction, checks all 89 tasks under `tasks/`, and calculates Harbor content digests for every task.
Repository templates outside `tasks/` are excluded.
This source archive pin identifies internal qualification inputs; it does not claim equivalence to an independently versioned Harbor Hub dataset digest.
Each invocation extracts a fresh copy of the verified archive; it does not reuse editable extracted task directories or resolve a mutable dataset alias.
The preparation command writes `results/release-gate/dataset.json` without creating sandboxes or calling a model.

Harbor 0.23.0 and Daytona SDK 0.210.0 are locked in the benchmark's private Python environment.
Node 22.23.2, Diffex 0.2.4, npm integrity, registry, and Node archive checksums come from [pins.toml](src/diffex_terminal_bench/pins.toml).
The default is `openai/gpt-5.5`, `xhigh` thinking, tools `read,bash,edit,write,update_plan`, enabled subagents, disabled evolution, and `context-only` project resources.
Enabled subagents add `spawn_agent`, `agent_action`, and `agents` to the model's tools; Diffex chooses whether to use them.
Children execute inside the parent trial's sandbox and their sessions and usage remain in the trial evidence.
Change and commit the configuration before starting a new qualification sequence.
Every subsequent stage must match the exact recorded identity, including the adapter commit and dependency lock.
The earlier TB 2.0 / Diffex 0.2.2 oracle evidence cannot qualify this configuration.
Start a fresh sequence with `--output results/qualification-tb21` and use that output argument for every stage, recovery, and evidence verification command.

Load `DAYTONA_API_KEY` through your normal secret-loading mechanism.
The key needs permission to create, inspect, list, and delete sandboxes.
The oracle uses only this key.
Diffex stages additionally require the selected model's credential, such as `OPENAI_API_KEY` for the default model.
A Daytona key does not authenticate OpenAI model requests.
Never put credential values in benchmark configuration or command-line arguments.
The runner records provider environment-variable references and lets Harbor resolve and scrub their values.

Optional `DAYTONA_TARGET` and `DAYTONA_API_URL` settings are recorded in the run identity.
If omitted, Daytona selects the organization's default region.
The account needs sufficient sandbox resources and access to task dependencies, npm, Node downloads, apt mirrors, and the chosen model endpoint.
Task resource requests vary; the runner uses the dataset's resource limits without overrides.
Provision quota and network access in the account instead of changing benchmark task limits.
Record the created sandbox IDs, snapshots, and actual CPU, memory, and disk from `sandbox-created.json` when diagnosing backend differences.
The pinned dataset includes upstream image tags and network-installed dependencies; archive verification does not make those external services immutable.

## Ordered stages

### Refresh and restart with parallel trials

The adapter runs from the local uv project, and a newly started command reads the current Python source and `benchmark.toml`.
An already running command keeps its loaded code and policy; let it finish or interrupt it once with Ctrl-C and wait for cleanup before restarting.
No Diffex npm release or product rebuild is needed for these runner and policy changes; new sandboxes install the existing pinned release with the updated tool allowlist.

After updating the checkout, run the following in your Mac's zsh terminal with `DAYTONA_API_KEY` and `OPENAI_API_KEY` exported.
`git status --short` must produce no output.
Use a fresh output directory because the adapter commit, concurrency, and subagent policy must match across the entire sequence; old prerequisites cannot qualify the new configuration.

```zsh
cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
git status --short
uv sync --locked

TB_OUTPUT="results/qualification-tb21-$(date +%Y%m%d-%H%M%S)"

# Step 3: verify all dataset inputs.
uv run --locked python -m diffex_terminal_bench.benchmark \
  --prepare -n 3 --output "$TB_OUTPUT"

# Step 4: oracle, single trial, then three concurrent integration trials.
uv run --locked python -m diffex_terminal_bench.benchmark \
  --through integration -n 3 --output "$TB_OUTPUT"

# Step 5: after step 4 passes, ten total trials with at most three active.
uv run --locked python -m diffex_terminal_bench.benchmark \
  --stage pilot -n 3 --output "$TB_OUTPUT"

# Step 6: verify using the same checkout, output, and concurrency.
uv run --locked python -m diffex_terminal_bench.benchmark \
  --verify-through pilot -n 3 --output "$TB_OUTPUT"
open "$TB_OUTPUT/pilot"
```

Keep the same terminal or restore the exact `TB_OUTPUT` value when continuing later.
Do not change the checkout, configuration, or concurrency between steps 4-6.
The recorded `gate.json` identity shows `concurrency: 3` and `policy.subagents: enabled`.
Each Diffex run's `requested.json` and `effective.json` show the coordination tool allowlist; native sessions and `trajectory.json` show actual calls and child execution.

### Shared dataset cache and run index

All runs share content-addressed archives in `results/dataset-cache/` by default, including runs with a custom `--output` directory.
Use `--dataset-cache /path/to/cache` to choose another shared cache.
Each use verifies the pinned SHA-256 and extracts independent temporary task files.
Concurrent preparation uses a per-digest file lock and atomic publication so another run cannot read a partial download.
Locks cover preparation only; benchmark execution proceeds independently.
Existing per-run caches remain untouched and can be deleted when no older benchmark process is using them.

The runner updates `index.md` in the output directory's parent after preparation, stage start, each checked trial, and stage completion or failure.
It links each qualification run and its stage reports, showing the model, thinking level, dataset, recorded gate status, checked-trial counts, and full-reward counts.
Smoke-test directories are excluded because they use separate report formats.
The index summarizes recorded reports and does not replace `--verify-through` evidence verification.
An unfinished stage may be running or may have stopped without writing a final report.
Neither caching nor index generation adds model calls.
Rebuild the index from existing local reports without credentials, dataset downloads, or a clean checkout:

```bash
uv run --locked python -m diffex_terminal_bench.benchmark --refresh-index --results-dir results
open results/index.md
```

### Stage sequence

| Stage | Trials | Required evidence |
| --- | ---: | --- |
| `oracle` | 1 | Official solution earns full reward; logs and sandbox deletion retained |
| `trial` | 1 | Diffex installs and completes the same task with validated ATIF and reconciled usage |
| `integration` | 3 | Git repair, certificate/file work, and log processing with the same configuration |
| `pilot` | 10 | All ten declared tasks complete the integration checks |
| `reliability` | 30 | Three additional passes over the ten tasks with fresh state and no unexplained infrastructure failures |
| `full` | 445 | Five attempts per task across all 89 tasks, after all prerequisites pass |

The pilot task order is declared before observing model results.
The first trial uses TB 2.1's updated `fix-git` task, followed by `openssl-selfsigned-cert` and `log-summary-date-ranges` for integration.
The remaining pilot tasks are `nginx-request-logging`, `sanitize-git-repo`, `db-wal-recovery`, `build-cython-ext`, `multi-source-data-merger`, `polyglot-c-py`, and `sqlite-db-truncate`, all from the same verified 2.1 archive.
It covers certificates, text processing, Git, service configuration, database recovery, compilation, and data manipulation.
The runner defaults to one concurrent trial and accepts `-n 3` (or `--concurrency 3`) for up to three simultaneous trials.
The limit includes sandbox creation, installation, execution, verification, and confirmed cleanup; a replacement starts only after that slot finishes.
Set `concurrency` in `benchmark.toml` to change the checked-in default.
Use the same concurrency for preparation, every stage, and `--verify-through`, because it is part of the qualification identity.
Stages remain sequential, so the one-task oracle and trial stages each create only one sandbox even with `-n 3`.
There are no Harbor retries.
Task execution and verifier timeouts remain unchanged.
Only Diffex installation receives the existing 630-second setup allowance.

Run the stages separately to inspect evidence between them:

```bash
uv run --locked python -m diffex_terminal_bench.benchmark --stage oracle
uv run --locked python -m diffex_terminal_bench.benchmark --stage trial
uv run --locked python -m diffex_terminal_bench.benchmark --stage integration
uv run --locked python -m diffex_terminal_bench.benchmark --stage pilot
uv run --locked python -m diffex_terminal_bench.benchmark --stage reliability
```

Alternatively, `--through reliability` runs the first five stages in order and stops on the first failed gate.
Each stage requires a new output directory and refuses to overwrite an earlier attempt.
Use `--output results/qualification-NAME` to start a new sequence after investigating a failure or changing configuration.
Keep failed sequences for diagnosis; do not delete failed trials or edit a report to qualify a stage.
The full run is explicit and is never started by `--through`:

```bash
uv run --locked python -m diffex_terminal_bench.benchmark --stage full
```

Before full execution, run the repository's `npm run check`, controlled Linux smokes, and production-content inspection documented in [README.md](README.md#local-validation), or require the corresponding benchmark CI jobs.
Every previous stage must still have its original artifacts and matching identity.
The gate hashes and revalidates their evidence before allowing progression.

## Evidence and failure policy

### Diagnose a stopped trial

Inspect a retained trial without credentials, downloads, a clean checkout, or another evaluation:

```zsh
uv run --locked python -m diffex_terminal_bench.benchmark \
  --diagnose-trial "$TB_OUTPUT/pilot/007-build-cython-ext"
```

The command reports the Harbor exception, a recorded agent deadline, scheduled retry counts, and observed rate-limit retries without printing raw provider errors.
New live-stage failures also record these diagnostics in `gate.json` and print the evidence directory instead of a generic traceback.
Scheduled backoff is the sum of requested retry delays, not a measurement of all time spent waiting on the provider.

The retained `qualification-tb21-gpt55-xhigh-20260915-132556` pilot stopped on `build-cython-ext` at its 900-second agent deadline after 68 rate-limit retry events and 210 seconds of scheduled backoff.
Its sandbox cleanup succeeded and the verifier awarded full reward, but timed-out execution still fails qualification.
That run already used concurrency 1; lowering concurrency alone cannot resolve a single trial's provider limit.
Ensure enough available provider token capacity, including other traffic using the same limits, before starting a fresh qualification sequence.
Use `-n 1` throughout that sequence while capacity remains constrained; task deadlines and resource limits stay unchanged.

### Retained evidence

Each stage writes `gate.json` before starting remote work and updates it after every verified trial.
It records dataset/archive and per-task digests, adapter commit, Harbor/Daytona/Python versions, dependency lock hash, installation pins, model, thinking, tools, subagent policy, and hashes of adapter/harness files and the release instructions.
Each Diffex trial additionally retains the effective system prompt and its SHA-256.
Full system prompt hashes can differ between isolated trials because context includes trial-specific paths.
The release instructions and harness source identity must remain consistent.

Trial directories contain Harbor `config.json`, `lock.json`, `result.json`, verifier reward and combined stdout/stderr, agent logs, native sessions, and sandbox lifecycle evidence.
Diffex installation evidence includes the three CLI checks and verified npm/Node pins.
The oracle does not install Diffex or call a model, so its Diffex installation, model usage, and ATIF checks are not applicable.

The gate re-parses native process/stream evidence instead of trusting the outcome summary alone.
It regenerates ATIF into a temporary directory, validates it with Harbor, and compares it with retained trajectories and image attachments.
Native totals, per-model totals, `accounting.json`, and `AgentContext` must reconcile.
Unknown telemetry remains unknown and cannot satisfy complete accounting.
Verifier reward must agree with the retained reward file.
A completed, fully accounted Diffex trial with reward zero passes integration checks and remains a zero-reward benchmark result.
An oracle with reward zero fails the smoke.

Timeouts, provider errors, missing telemetry, missing logs, invalid ATIF, altered configuration, and cleanup failures retain their original evidence and stop qualification for investigation.
The runner does not convert them to successful executions or silently rerun them.
This conservative integration gate can stop on a legitimate task timeout; the timeout remains a recorded task result and must not be described as an installation failure.
No failed or interrupted run establishes readiness merely because its process exited zero.

The backend records sandbox IDs before Harbor tears them down.
Cleanup independently checks known IDs and lists all sandboxes with the trial's unique label, allowing bounded time for asynchronous deletion.
Only a Daytona not-found response establishes absence; authentication or transport errors do not.
An orphan is deleted when possible, but needing recovery still fails qualification.
SIGTERM and cancellation preserve cleanup and reports.
If a parallel trial fails, the runner stops queued work, cancels active peers, and waits for their cleanup before closing the clients.
Completed trial entries stay in declared task order even when they finish out of order, and the failure identifies the actual trial directory and index.
After a host crash, forced kill, or interrupted CI job, recheck only the sandboxes belonging to the retained sequence:

```bash
uv run --locked python -m diffex_terminal_bench.recover results/release-gate
```

Recovery records `sandbox-recovery.json` and preserves the original cleanup report.
It does not turn a failed sequence into a passing one.
It requires the original output directory and access to the same Daytona account.

## Export retained trials for Harbor Hub

The staged runner writes individual Harbor trials and `gate.json`, so its stage directories cannot be passed directly to `harbor upload`.
Export a stage into a new job directory first:

```zsh
cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
uv sync --locked

TB_JOB="results/harbor-exports/pilot-$(date +%Y%m%d-%H%M%S)"
uv run --locked python -m diffex_terminal_bench.export_job \
  "$TB_OUTPUT/pilot" --output "$TB_JOB"
```

The default requires a stopped stage with recorded passing status and complete trial coverage.
To share a failed or incomplete stopped stage for diagnosis, explicitly include every retained terminal result:

```zsh
uv run --locked python -m diffex_terminal_bench.export_job \
  "$TB_OUTPUT/pilot" --output "$TB_JOB" --allow-partial
```

Use one of those export commands, not both with the same destination.
The exporter refuses to overwrite an existing job, copy a running stage, omit a started trial without a terminal result/lock, or accept changed evidence for a checked trial.
It works offline with old recorded configurations and does not require the original clean checkout, provider credentials, or temporary dataset extraction.
It neither reruns trials nor changes source results.

The job contains Harbor `config.json`, `result.json`, and `lock.json`, plus independent copies of all trial files.
Rewards, exception records, trial IDs, native sessions, ATIF trajectories, and media remain unchanged.
Job totals retain the planned trial count and separately count terminal results, errors, and unrun tasks.
Unknown usage in failed trials remains unknown in those trials; job usage is an observed sum, not a claim of complete accounting.
`analysis.md` explains whether the source gate passed, and `export.json` records source hashes and missing trials.
This packaging check does not requalify the source stage or establish leaderboard eligibility.
The exported configuration retains original task paths for provenance; use the custom staged runner for future evaluations, not `harbor job resume` on an export.

Harbor's upload archive filters omit custom files at the trial root.
The exporter also places sandbox lifecycle evidence under each trial's `artifacts/diffex-qualification/`, with the source gate and export manifest under the first trial's artifact directory, so those files survive Hub downloads.
Hidden child-session directories remain under `agent/` and are included in Harbor's archives.
Repeated exports of the same source snapshot have a stable job ID; retry an upload from the same exported directory.

Authenticate and upload the exported job privately:

```zsh
uv run --locked harbor auth login
uv run --locked harbor upload "$TB_JOB" --private
```

To publish it publicly instead, use:

```zsh
uv run --locked harbor upload "$TB_JOB" --public
```

Harbor prints the Hub viewing link after upload.
The export command does not upload anything or change visibility.
See the [Harbor job sharing documentation](https://www.harborframework.com/docs/sharing/jobs) for visibility and download options.

## CI and remote evidence

[terminal-bench.yml](../../.github/workflows/terminal-bench.yml) is separate from product CI.
Pull requests and benchmark branch pushes run deterministic adapter/converter/gate tests, dataset verification, controlled Linux execution/outcome smokes, and production-tarball exclusion checks.
These jobs require no Daytona or model credentials.

For live runs, configure the `terminal-bench` GitHub environment with `DAYTONA_API_KEY` and `OPENAI_API_KEY` secrets for the checked-in default model.
Dispatch the workflow on the committed benchmark branch and select the last qualification stage to run.
If selecting another provider, update the checked-in configuration and workflow's credential environment together.
Live stages never run automatically on pull requests.
Full benchmark execution and official submission are not workflow-dispatch options.
The live job leaves time for cleanup and artifact upload before its six-hour GitHub job limit; use the local stage commands if a sequence needs longer.

CI retains complete evidence, including hidden child-session directories, even when a stage fails.
Successful uploads record the artifact URL and archive SHA-256 in the job summary.
Successful live runs download the uploaded archive and revalidate all stage evidence, including trajectories and usage.
To check a downloaded artifact yourself, use the same clean adapter commit and configuration:

```bash
uv run --locked python -m diffex_terminal_bench.benchmark \
  --verify-through reliability --output /path/to/downloaded-evidence
```

This command verifies dataset inputs and artifacts without Daytona or model calls.
Local validation is not an upload receipt.
Retain the CI artifact URL/digest or equivalent durable storage receipt with any future submission.

## Official submission gate

Rules and availability were checked on 2026-09-15.
The [official Terminal-Bench 2.1 repository](https://github.com/harbor-framework/terminal-bench-2-1#submitting-to-the-leaderboard) currently accepts only maintainer-run submissions; community submissions are closed.
Its published submission instructions require at least five trials per task and public Harbor Hub uploads using `--upload --public`.
Official runs must use the required Hub dataset revision and preserve task timeouts and resources.
The [leaderboard integrity policy](https://www.tbench.ai/news/leaderboard-integrity-update) requires ATIF for passing trials and prohibits cheating and reward hacking.

Treat this integration's outputs as internal qualification evidence until the applicable submission process is open and its current requirements have been reviewed again.
Before planning an official submission, record the date, source links, availability, required dataset version, repeat count, limits, and artifact-upload requirements in a new review record.
Inspect passing trajectories for prohibited task-specific assistance, solution access, and verifier leakage.
Require remote evidence receipts and validation of every rewarded trial's uploaded ATIF, including child trajectories and media.
Do not infer official eligibility from a passing internal gate or an npm publication.
