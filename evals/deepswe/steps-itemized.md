# DeepSWE 1.1: smoke trial, inspect evidence, and upload privately

- Run the commands below in the same zsh terminal.
- Continue only after the preceding command succeeds.
- This workflow runs one fresh attempt at `datacurve/abs-stepped-slices`, with concurrency 1 and zero automatic retries.
- Defaults are Diffex 0.3.2, `openai/gpt-6-luna`, `max` thinking, disabled evolution, disabled subagents, and E2B sandboxes.
- The original task declares 2 vCPU, 8192 MiB RAM, 20480 MiB storage, a 5400-second agent deadline, and an 1800-second verifier deadline.
- No CPU, memory, or task deadline overrides are added.
- A zero verifier reward is allowed for smoke qualification if execution and retained evidence are complete.
- Preparation checks passed locally; live E2B provisioning, network isolation, and separate verification must still be exercised by this smoke trial.

## Pinned inputs and isolation

The [Harbor dataset](https://hub.harborframework.com/datasets/datacurve/deep-swe-1-1) contains 113 tasks.
This workflow pins the dataset to `sha256:5affcd534fd90ac85d202d4c63f8b35ddc942140afdd5d60014a21365440a2f5`.
The smoke task pin is `sha256:602b5b3144f5386bc54107a58e9bb9eef276e9cdae98610b482f95eb4e960310`.
Harbor 0.24.0 and E2B 2.59.0 are pinned in the existing Terminal-Bench uv project and lockfile.
All DeepSWE launchers use that shared environment without `--with` dependency overlays.
The existing `diffex_terminal_bench.adapter:DiffexAgent` installs the published Diffex release pinned in `evals/terminal-bench/src/diffex_terminal_bench/pins.toml`.

[DeepSWE 1.1](https://github.com/datacurve-ai/deep-swe) grades committed changes in a separate pristine verifier sandbox.
The agent's original instruction asks it to create a new branch and commit its completed work.
Do not remove that instruction or replace the commit collector with an uncommitted working-tree diff.
Harbor executes the original `[[verifier.collect]]` command and transfers `model.patch` to the verifier.
The agent does not receive the held-out verifier files or reference solution.

The original task forbids network access during agent execution and verification.
This configuration adds a disclosed, agent-phase-only exception for `api.openai.com`, because Diffex calls the Responses API from inside the sandbox.
All other destinations remain blocked during agent execution, and the verifier remains offline.
Environment startup and agent installation use the task's default public baseline before the restricted execution phase, allowing Node and npm installation.
Use this as an internal custom-harness evaluation; it does not establish acceptance under DeepSWE's leaderboard policy.

The adapter uses the checked-in evaluation system prompt and `--no-context-files`, and appends the existing anti-cheating sentence to the user message.
It writes fresh settings with `evolution.enabled=false` and exposes no subagent tools.
The model remains `gpt-6-luna`; `max` is its reasoning-effort setting, not a separate model ID.

`ResourceCheckedE2B` checks actual capacity after each agent/verifier sandbox starts.
It requires exactly the declared CPU and memory allocation and at least 20480 MiB of reported disk capacity.
It records both checks under each trial's `artifacts/e2b-resources/` directory and rejects an undersized allocation.
Harbor's E2B backend cannot request an exact disk capacity, so this is a minimum-capacity check, not an exact 20 GiB allocation or a free-space check.
The agent and verifier are distinct sandboxes, so allow quota for both within a single trial.

This E2B workflow does not mount Daytona volumes or activate the Daytona volume-cleanup plugin.
It retains local logs before deleting sandboxes through Harbor's normal lifecycle.
The existing adapter's 30-second bulk log-download limit and connection recovery behavior are unchanged.
Previously observed connection, artifact collection, and shutdown-evidence errors can recur.

## Run one smoke trial

1. Open zsh and select the repository:

    ```zsh
    cd /Users/jialeyu/Projects/diffex-new
    ```

2. Load both API keys without echoing them:

    ```zsh
    if [[ -z "${E2B_API_KEY:-}" ]]; then
      read -rs 'E2B_API_KEY?E2B API key: '
      printf '\n'
    fi
    export E2B_API_KEY

    if [[ -z "${OPENAI_API_KEY:-}" ]]; then
      read -rs 'OPENAI_API_KEY?OpenAI API key: '
      printf '\n'
    fi
    export OPENAI_API_KEY

    [[ -n "$E2B_API_KEY" && -n "$OPENAI_API_KEY" ]] && printf 'Both keys are set.\n'
    ```

    Key presence is checked locally; successful provisioning and model execution verify actual access.
    Never paste keys into YAML or saved commands.

3. Inspect the configuration without starting a trial:

    ```zsh
    zsh evals/deepswe/run-smoke.zsh --print-config
    ```

    Confirm one attempt, concurrency 1, `openai/gpt-6-luna`, `thinking: max`, disabled subagents, and only `api.openai.com` in the agent allowlist.
    Confirm the environment import is `deepswe_e2b:ResourceCheckedE2B` and the dataset contains the exact pinned smoke selection.

4. Optionally repeat preparation without provisioning a sandbox or calling the model:

    ```zsh
    zsh evals/deepswe/run-smoke.zsh --prepare
    ```

    Preparation resolves the pinned dataset, downloads the smoke task definition, checks separate verification, and resolves the agent/verifier network policies.
    Harbor may warn that the original task's explicit `model.patch` artifact overlaps its standard `/logs/artifacts` collection directory.
    The task is preserved unchanged; the post-run checker requires the patch to be retained.
    It writes `.artifacts/deepswe/prepared-runtime-v3/manifest.json`.
    The launcher repeats these checks automatically before starting the trial.

5. Start the smoke trial:

    ```zsh
    zsh /Users/jialeyu/Projects/diffex-new/evals/deepswe/run-smoke.zsh
    ```

    Keep the terminal running until Harbor and the post-run evidence checker finish.
    The launcher creates a unique output directory beneath `evals/terminal-bench/results/deepswe-1-1-luna-max-smoke-*`.
    The job is the `smoke/` subdirectory inside that output directory.
    It saves the planned configuration, task manifest, setup scripts, adapter commit, adapter working-tree diff, release pins, and native agent launcher.
    The maximum agent work period is 90 minutes, with additional provisioning, installation, collection, and verification time.

## Inspect and qualify the smoke

1. Use the exact job path printed by the launcher:

    ```zsh
    DS_JOB='/Users/jialeyu/Projects/diffex-new/evals/terminal-bench/results/ACTUAL-OUTPUT/smoke'
    open "$DS_JOB"
    python3 -m json.tool "$DS_JOB/result.json"
    ```

2. Inspect `smoke-check.json` for `status: passed`.
   The launcher checks one completed trial, no execution exception, confirmed shutdown, complete token accounting, a valid ATIF trajectory, model and reasoning settings, disabled evolution/subagents, two distinct resource-checked sandboxes, separate verification, and retained `model.patch`.
   A zero reward means the task solution failed verification, even if smoke qualification passed.
   The checker does not independently certify firewall behavior or leaderboard compliance.

3. To repeat the evidence check manually:

    ```zsh
    cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
    uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
      python ../deepswe/verify-smoke.py "$DS_JOB"
    ```

4. Inspect the trial's `result.json`, `trial.log`, `agent/trajectory.json`, native `agent/run-*/sessions/`, `requested.json`, `effective.json`, and `cleanup.json`.
   Inspect `verifier/test-stdout.txt`, `verifier/reward.json`, the collected `model.patch`, and both `artifacts/e2b-resources/*.json` records.
   Keep the complete local directory, including failures.

## Upload privately under Diffex

1. From the existing uv project, log in if needed:

    ```zsh
    cd /Users/jialeyu/Projects/diffex-new/evals/terminal-bench
    uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
      harbor auth login
    ```

2. Upload the entire native smoke job:

    ```zsh
    uv --cache-dir /tmp/diffex-e2b-uv-cache run --locked \
      harbor upload "$DS_JOB" --org diffex --private
    ```

    `--org diffex` assigns ownership to Diffex; `--share-org diffex` alone does not.
    Do not add `--share-org diffex` when Diffex already owns the job.
    Retry the same upload command and directory after a partial upload.
    Save the printed link and confirm the owner, visibility, trial count, and available traces.

## If the trial fails or is interrupted

1. Preserve the output and read `job.log`, the trial's exception, and its retained artifacts.
2. If provisioning fails, inspect the E2B build error before changing the original task image.
3. If model calls fail, inspect the restricted `api.openai.com` allowlist and provider errors.
4. If the patch is empty or absent, check whether the agent committed its work as instructed.
5. If shutdown is unverified, keep verification blocked and inspect the E2B dashboard for sandboxes left by this job.
6. If trace collection fails, retain partial usage as incomplete rather than reporting it as a complete total.
7. Upload the original result for diagnosis, then use a fresh output directory for another smoke trial.

## Before a full evaluation

Qualify the smoke environment and evidence before scaling.
Prepare a separate full-run configuration that removes `task_names`, preserves the dataset digest and task deadlines, and records the chosen trial count and concurrency.
The pinned dataset has 113 tasks, so five attempts would schedule 565 trials.
Preserve the separate offline verifier and the disclosed agent-only model endpoint exception.
Account for agent and verifier sandbox resources when sizing E2B concurrency.
A full-run launcher is not included here; the final kickoff command above starts only the single smoke trial.
