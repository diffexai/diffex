# DeepSWE 1.1: five random tasks, two attempts each

This workflow schedules 10 independent trials: five distinct randomly selected tasks, each attempted twice, with concurrency 5.
Both attempts use the same task selection; Harbor schedules them in one job rather than enforcing a barrier between two passes.
Preparation downloads task definitions and validates configuration without provisioning E2B sandboxes or calling the model.
The final command starts the evaluation.

| Setting | Value |
| --- | --- |
| Dataset | [datacurve/deep-swe-1-1](https://hub.harborframework.com/datasets/datacurve/deep-swe-1-1), 113 tasks |
| Dataset revision | `sha256:5affcd534fd90ac85d202d4c63f8b35ddc942140afdd5d60014a21365440a2f5` |
| Diffex | Published `0.3.2` |
| Model | `openai/gpt-6-luna` |
| Thinking | `max` |
| Subagents | Disabled |
| Self evolution | Disabled by the adapter's fresh `evolution.enabled=false` settings |
| Environment | E2B, through `deepswe_e2b:ResourceCheckedE2B` |
| Harness dependencies | Harbor `0.24.0`, E2B `2.59.0`, shared Terminal-Bench lock |
| Sample | Five tasks selected without replacement using a saved random seed |
| Attempts per task | 2 |
| Concurrent trials | 5 |
| Automatic Harbor retries | 0 |

The published leaderboard uses four whole-dataset passes, or 452 trials per configuration, and reports pass@1 across scored attempts.
This 5-by-2 run is a test subset, not a full leaderboard evaluation.
See the official [leaderboard data](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json).

## Prepare the environment

1. Open zsh and synchronize the existing evaluation project:

    ```zsh
    cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
    uv --cache-dir /tmp/diffex-e2b-uv-cache sync --locked
    ```

2. Using the shared locked environment without dependency overlays, select five random tasks and download and validate their definitions:

    ```zsh
    zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-sample.zsh --prepare
    ```

    Preparation saves `seed.json`, `manifest.json`, `job.yaml`, and a task cache in `.artifacts/deepswe/prepared-5x2-runtime-v3/` under the repository root.
    It confirms Diffex 0.3.2, the 113-task dataset digest, five selected task identities, two attempts, concurrency five, and separate verification.
    Repeating preparation retains the existing seed and selected tasks.
    Harbor's `n_tasks` takes the first entries, so this launcher explicitly samples a sorted task list with the recorded seed and writes `task_names` into the prepared configuration.
    Harbor warns that the original explicit `model.patch` artifact overlaps its standard `/logs/artifacts` collection.
    The upstream task definitions are preserved; check that the patch is retained after execution.

3. Inspect the resolved configuration and selection:

    ```zsh
    zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-sample.zsh --print-config
    python3 -m json.tool /Users/jialeyu/Projects/diffex-new/.artifacts/deepswe/prepared-5x2-runtime-v3/manifest.json
    ```

    Confirm `n_attempts: 2`, `n_concurrent_trials: 5`, the five task names, the pinned dataset, `thinking: max`, and disabled subagents.
    The backend import must be `deepswe_e2b:ResourceCheckedE2B`.
    No trial, agent, verifier, CPU, memory, or storage limit overrides are configured.
    The manifest records the original resource requirements and deadlines for each task.

The initial preparation selected these tasks with seed `5414959033685670815`:

- `datacurve/go-critic-doc-link-checker`
- `datacurve/koota-composite-trait-aspects`
- `datacurve/superjson-error-stack-serialization`
- `datacurve/anko-typed-variable-bindings`
- `datacurve/bandit-structured-nosec-directives`

Each selected task declares 2 vCPU, 8192 MiB RAM, 20480 MiB disk capacity, a 5400-second agent deadline, and an 1800-second verifier deadline.
The saved manifest is authoritative if a separate preparation directory is used later.

## Execution and retained evidence

The adapter installs the published Diffex 0.3.2 release inside each agent sandbox.
It uses the checked-in evaluation system prompt, disables automatic context files, and includes the existing anti-cheating instruction.
The fresh Diffex settings disable self evolution, and the selected tools contain no subagent tools.

DeepSWE 1.1 requires the agent to commit its work.
Harbor collects the commit-derived `model.patch`, applies it in a separate pristine verifier sandbox, and runs the held-out tests there.
The original task instruction, commit collection, verifier, and resource limits remain intact.

The original tasks forbid execution-time network access.
This configuration adds the existing adapter's agent-only `api.openai.com` exception so Diffex can call its model inside the sandbox.
The verifier remains offline, and other agent destinations remain blocked during execution.
Installation occurs before the restricted execution phase.
Disclose this network exception and the Diffex harness with results.

E2B capacity checks require the task's declared CPU and memory and at least its declared disk capacity in both sandboxes.
Disk capacity is not a free-space measurement.
Concurrency five means five active trials; each trial uses distinct agent and verifier sandboxes, so allow E2B quota for up to ten simultaneous sandboxes.
Actual E2B provisioning, API access, and runtime behavior are validated only when the evaluation starts.

The launcher creates a fresh `evals/terminal-bench/results/deepswe-1-1-luna-max-5x2-<timestamp>-<uuid>/` directory each time.
It saves the seed, manifest, job configuration, launcher, E2B backend, adapter source snapshot, Git revision, and adapter working-tree diff.
The native Harbor job is its `sample-5x2/` subdirectory.
No Daytona volumes or volume-cleanup plugins are used.
Harbor collects local logs and deletes sandboxes through its normal lifecycle.

## Inspect results after completion

1. Use the exact absolute job path printed by the launcher:

    ```zsh
    DS_JOB='/Users/jialeyu/Projects/diffex-new/evals/terminal-bench/results/ACTUAL-OUTPUT/sample-5x2'
    python3 -m json.tool "$DS_JOB/result.json"
    open "$DS_JOB"
    ```

2. Require 10 terminal trial results covering exactly the selected five tasks twice each.
   Inspect job and trial `config.json`, `lock.json`, `result.json`, and any execution exceptions.
   A finished job does not imply that the solutions passed.

3. Inspect every trial's verifier reward, `verifier/test-stdout.txt`, `model.patch`, `agent/trajectory.json`, and native `agent/run-*/sessions/`.
   Check `requested.json` for `thinking: max`, `subagents: disabled`, and `evolution: {enabled: false}`.
   Check `effective.json` for the expected model and thinking setting, disabled context files, and delivered instructions.
   Check confirmed shutdown and complete usage accounting before treating execution evidence as complete.
   Successful trials should retain two distinct verified records in `artifacts/e2b-resources/`.

4. Validate retained trajectories with the pinned environment:

    ```zsh
    (
      set -e
      cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
      DS_TRACES=("$DS_JOB"/*/agent/trajectory.json(N))
      [[ ${#DS_TRACES} -gt 0 ]]
      for DS_TRACE in "${DS_TRACES[@]}"; do
        uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
          python -m harbor.utils.trajectory_validator "$DS_TRACE"
      done
    )
    ```

    This validates existing trajectories; separately check that every successfully executed trial has one.
    Retain incomplete traces and errors rather than silently dropping attempts.
    Report successful attempts, failed solutions, infrastructure errors, and completed coverage separately.
    Official DeepSWE scoring excludes provider, verifier, and network errors while counting agent timeouts and context-window failures as failures.
    Harbor's raw job mean may use different error handling, so disclose the denominator when reporting a score.

## Optional private upload

Native Harbor jobs can be uploaded without the Terminal-Bench staged export command:

```zsh
cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
  harbor auth login
uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
  harbor upload "$DS_JOB" --org diffex --private
```

`--org diffex` assigns ownership to Diffex.
Save the printed link and verify visibility, ownership, ten trials, and available trajectories.
Retry a partial upload using the same job directory.

## Failure or interruption

Preserve the complete output directory and inspect `job.log`, trial exceptions, and retained logs.
Wait for Harbor cleanup and inspect E2B for sandboxes left by this job before restarting.
Do not reuse an existing job directory or selectively replace failed attempts.
The launcher starts a new output directory while keeping the same saved five-task sample.
To intentionally choose another random sample, set `DS_PREPARED` to a fresh absolute directory before preparation and launch.
Keep each sample's seed and results separate.

## Final command: start the 10-trial test

Run this in your terminal after preparation.
If `E2B_API_KEY` or `OPENAI_API_KEY` is missing, the launcher prompts for it without echoing or saving it in the configuration.
Keep the terminal running until Harbor finishes verification and cleanup.

```zsh
zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-sample.zsh
```
