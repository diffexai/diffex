# DeepSWE 1.1: complete 113-task evaluation

This workflow schedules all 113 tasks once, for 113 independent trials in one Harbor job.
Concurrency is 8, using E2B.
This preserves the launcher's one-attempt configuration; it does not reproduce four leaderboard passes.

| Setting | Value |
| --- | --- |
| Dataset | [datacurve/deep-swe-1-1](https://hub.harborframework.com/datasets/datacurve/deep-swe-1-1) |
| Revision | `sha256:5affcd534fd90ac85d202d4c63f8b35ddc942140afdd5d60014a21365440a2f5` |
| Coverage | 113 distinct tasks, 1 attempt each, 113 trials |
| Diffex | Published 0.3.2 |
| Model | `openai/gpt-6-luna` |
| Thinking | `max` |
| Subagents | Disabled |
| Self evolution | Disabled by the adapter's fresh per-run settings |
| Environment | `deepswe_e2b:ResourceCheckedE2B` |
| Dependencies | Harbor 0.24.0, E2B 2.59.0, shared Terminal-Bench lock |
| Concurrent trials | 8 |
| Automatic Harbor trial retries | 0 |

The official [leaderboard data](https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json) records four whole-benchmark passes.
The official leaderboard uses mini-swe-agent on Modal; this run uses Diffex on E2B and must be identified accordingly.
Diffex 0.3.2 retains its published request retry behavior; the proposed 5, 15, 45-second change is not part of this pinned release.

## Preparation

1. Synchronize the shared locked evaluation project; no `--with` dependency overlays are needed:

   ```zsh
   cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
   uv --cache-dir /tmp/diffex-e2b-uv-cache sync --locked
   ```

2. Download and validate every task without starting sandboxes or model calls:

   ```zsh
   zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-full.zsh --prepare
   ```

   Preparation saves `job.yaml`, `manifest.json`, and `task-cache/` in `.artifacts/deepswe/prepared-113x1-c8-runtime-v3/`.
   It verifies the release pins, all 113 task identities, separate verification, agent-only model network access, and offline verifiers.
   Every task is included explicitly; no random subset or seed is used.
   The manifest records each task's original resource requirements and timeouts.
   The configuration preserves these limits.

3. Inspect the resolved configuration:

   ```zsh
   zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-full.zsh --print-config
   ```

   Confirm one attempt, concurrency eight, the pinned dataset, all 113 task names, Luna at max effort, and disabled subagents.
   Evolution is disabled inside the adapter, not by a Harbor YAML setting.
   The upstream artifact overlap warning about `/logs/artifacts/model.patch` is expected; inspect retained patches after execution.

## Execution and evidence

The launcher revalidates preparation and prompts silently for missing `E2B_API_KEY` and `OPENAI_API_KEY` values.
It creates a fresh `evals/terminal-bench/results/deepswe-1-1-luna-max-113x1-<timestamp>-<uuid>/` directory.
The native Harbor job lives in its `full-113x1/` subdirectory, whose absolute path is printed at launch.
The parent directory retains the manifest, configuration, launcher, backend, adapter snapshot, Git revision, and adapter diff.

The adapter installs Diffex 0.3.2, uses its evaluation system prompt, disables automatic context files, and starts with fresh state for every attempt.
The selected tools contain no subagent tools.
Agents commit their changes, and Harbor extracts the resulting patch for a separate pristine verifier sandbox as required by DeepSWE 1.1.
Only `api.openai.com` is added to the agent's network allowlist; the verifier remains offline.
Disclose this model-endpoint exception with results.

Eight active trials can require up to sixteen agent and verifier sandboxes.
The backend checks actual CPU, memory, and disk capacity for each sandbox.
Harbor collects local artifacts and deletes sandboxes through its normal lifecycle.
Keep the terminal and computer running until verification and cleanup finish.

## After completion

1. Set `DS_JOB` to the exact absolute job path printed by the launcher and inspect `result.json`.
2. Require 113 terminal trial results covering 113 distinct tasks exactly once each.
   Inspect errors separately from failed solutions and retain all attempts.
3. Inspect verifier rewards, `verifier/test-stdout.txt`, collected `model.patch`, `agent/trajectory.json`, and native `agent/run-*/sessions/`.
   Check requested and effective settings for the model, max thinking, disabled subagents and evolution, delivered instructions, and confirmed shutdown.
4. Validate existing trajectories:

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

   Separately check missing trajectories and incomplete token accounting.
   Official pass@1 is successful scored attempts divided by scored attempts; pass@4 is tasks with at least one successful attempt divided by tasks attempted across four attempts.
   This one-attempt run cannot measure pass@4.
   Official scoring excludes provider, verifier, and network errors but counts agent timeouts and context-window failures as failures.
   Report coverage and exclusions alongside scores; Harbor's raw mean may use a different denominator.

5. To upload the native job privately under Diffex after verification:

   ```zsh
   cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
   uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
     harbor upload "$DS_JOB" --org diffex --private
   ```

   If authentication is required, run `uv run --locked harbor auth login` first.
   Verify ownership, private visibility, all 113 trials, and available traces at the printed Hub link.
   Retry a partial upload using the same job directory.

If interrupted, preserve the entire output directory, inspect job and trial logs, and check E2B for remaining sandboxes after Harbor cleanup.
Each launcher invocation starts a fresh job; it does not resume an interrupted job or replace failed attempts.

## Final command

Run this command to start all 113 trials:

```zsh
zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-full.zsh
```
