# Daytona installed-artifact behaviors

## Status and scope

The workflow and harness are implementation, not remote qualification evidence.
A maintainer must provision Daytona access, prepare a snapshot, supply an approved live-provider credential and run the qualification below before enabling automatic runs.
Local fixture tests, SDK mocks and workflow validation do not establish that Daytona creation, upload, PTY execution, live inference or deletion works against the real service.
Do not mark the integration qualified until those operations and their failure paths have retained evidence.

This is a standalone acceptance gate for the packaged Diffex CLI, not the hosted product's runtime image, a release publisher or a replacement for native artifact acceptance.
It installs the exact reviewed candidate tarballs into isolated consumers outside the repository.
The deterministic mode controls inference while exercising installed behavior; the live mode uses a bounded real OpenAI request path.
A passing deterministic run is not live-provider evidence.
The snapshot is toolchain-only; each run uploads its candidate artifacts and checked harness rather than baking repository source or credentials into a snapshot.
Version 1 covers the Linux installed CLI only; hosted-runtime behavior and subscription/OAuth login qualification are out of scope.
The workflow performs no automatic reverts and changes no release or publication gates.

## Workflow contract

`.github/workflows/daytona-behaviors.yml` listens to every push to `main` and to manual dispatch.
There are no path filters or concurrency cancellation: overlapping pushes retain independent run IDs and sandboxes.
Every checkout explicitly uses `github.sha`, including a manually dispatched run's selected commit.
A later movement of `main` must not change the source under test.

Automatic pushes are gated by the **repository variable** `DAYTONA_BEHAVIORS_QUALIFIED` being exactly `true`.
Leave it unset or `false` until qualification passes; unqualified pushes skip the gated jobs rather than reporting remote success.
Manual dispatch bypasses this variable so qualification and repair remain possible.
The workflow never sets its own qualification variable.

1. **Prepare, once, with a 35-minute timeout.** Install locked dependencies with lifecycle scripts disabled, hydrate model data once, then run the existing artifact pipeline:

   ```sh
   npm run hydrate:model-data
   node scripts/release-artifacts.mjs freeze .artifacts/release
   npm run build:offline
   node scripts/release-artifacts.mjs prepare .artifacts/release
   node scripts/release-artifacts.mjs verify .artifacts/release
   git diff --exit-code HEAD
   ```

   This preserves the frozen source/model inputs, manifests and exact reviewed npm tarballs.
   There is no second candidate build or repack in either behavior job.
   Preparation also runs the targeted Node fixture/workflow tests and Python fake-client/report tests without credentials.
   The separate harness bundle contains only:

   ```text
   scripts/artifact-installation.mjs
   scripts/verify-candidate-artifacts.py
   scripts/fixtures/artifact-handoff.mjs
   scripts/daytona-behaviors/installed.py
   scripts/daytona-behaviors/install.mjs
   scripts/daytona-behaviors/fixture.mjs
   scripts/daytona-behaviors/live-guard.mjs
   scripts/daytona-behaviors/baselines/
   ```

   Bundle paths start at `scripts/`; no package source tree is needed.
   The workflow retains a `SHA256SUMS` sidecar and verifies the downloaded bundle before execution.

2. **Deterministic and live, in separate jobs.** Both depend only on prepare and use the GitHub environment `daytona-behaviors`.
   Each downloads the same retained release and bundle, re-verifies them and creates its own sandbox.
   Each job has a 35-minute timeout, a 25-minute execution step, a 1,200-second runner deadline and a separate bounded recovery step.
   A run ID includes the workflow run ID, attempt and mode, so retry evidence cannot be confused with an earlier attempt.

3. **Recovery and evidence, including failure.** Once execution starts, the always-run recovery step invokes `recover --output DIR`.
   Recovery retrieves available evidence and confirms cleanup; it does not launch or retry behavior execution.
   The workflow records execution and recovery outcomes separately in `workflow-job.json` and uploads evidence even after a failure.
   A recovered transcript does not turn a failed run into a pass.

4. **Aggregate, including missing results.** The final job runs even when dependencies fail or skip on an enabled run.
   It requires successful prepare, deterministic and live jobs; exact commit/mode/run-ID markers; successful execution and recovery; passing orchestration JSON with confirmed deletion; the complete expected installed scenario inventory; matching candidate tarball hashes in both modes; and nonempty orchestration and installed-suite XML reports.
   Missing artifacts, incomplete results, execution failure or cleanup failure fail the aggregate.
   Evidence-upload failure also leaves the producing job failed.

GitHub artifacts retain the release, bundle, per-mode evidence and aggregate evidence for **30 days**.
Download evidence before expiry if a longer-lived qualification record is required.
Artifacts remain private repository evidence; they are not npm or public release assets.

## Configure access and a snapshot

A repository administrator and a Daytona account owner must perform this setup.
Do not put API keys in the Dockerfile, bundle, checked files, command-line arguments or repository variables.

Create the GitHub environment `daytona-behaviors` and configure:

| Setting | Location | Purpose |
| --- | --- | --- |
| `DAYTONA_API_KEY` | Environment secret | Local orchestration calls to Daytona; never passed as the sandbox's model credential. |
| `OPENAI_API_KEY` | Environment secret | Approved, restricted live-provider key; injected only into the live execution step. |
| `DAYTONA_BEHAVIORS_SNAPSHOT` | Environment variable | Prepared toolchain snapshot name passed explicitly as `--snapshot`. |
| `DAYTONA_BEHAVIORS_QUALIFIED` | Repository variable | Set to `true` only after reviewing a successful qualification. |

The deterministic job and recovery steps do not receive `OPENAI_API_KEY`.
The prepare and aggregate jobs receive neither credential.
Provider credentials must be test-only, revocable and covered by a spending limit; do not use personal login state or production agent configuration.
Review the current model, request/token/time limits and allowed provider destination in the checked live harness before approval.
Its application-level guard is not a claim of an account-wide network firewall.

Install the pinned orchestration SDK in a local virtual environment:

```sh
python3 -m venv /tmp/diffex-daytona-venv
/tmp/diffex-daytona-venv/bin/python -m pip install -r scripts/daytona-behaviors/requirements.txt
```

`requirements.txt` pins `daytona==0.226.1`.
Supply `DAYTONA_API_KEY` through an approved local secret mechanism, then prepare the snapshot from the checked `scripts/daytona-behaviors/Dockerfile`:

```sh
/tmp/diffex-daytona-venv/bin/python scripts/daytona-behaviors/daytona_runner.py prepare-snapshot \
  --name diffex-behaviors-toolchain-v1 \
  --output .artifacts/daytona-snapshot
```

Inspect the preparation evidence and the resulting snapshot's readiness in Daytona before setting `DAYTONA_BEHAVIORS_SNAPSHOT`.
Record the checked Dockerfile commit, snapshot name/identity, architecture, actual Node/npm/Bun and helper versions, preparation outcome and owner.
An existing production snapshot must not be assumed suitable.
If the toolchain changes, prepare and qualify a new snapshot rather than silently changing an approved baseline.
Snapshot preparation is an explicit operator action, not part of each push.
The versioned definition pins Node **22.23.2**, npm **11.16.0** and Bun **1.3.11**, and installs Python, tmux, ripgrep and fd.
Each sandbox uses **2 vCPU, 4 GiB RAM and 8 GiB disk**; the runner checks snapshot and sandbox resources and verifies installed toolchain versions.
A **45-minute wall-clock TTL** (`ttl_minutes=45`) destroys the sandbox independently of activity or state; stopped-time auto-delete is not a substitute.
See [Daytona wall-clock TTL](https://www.daytona.io/docs/en/sandboxes/#wall-clock-ttl).
The live scenario defaults to `openai/gpt-4.1-mini`, with a shared six-request budget across print/TUI processes, 512 output tokens per request and a three-minute smoke deadline after installation.
Assertions are never automatically rerun.

Restrict the `daytona-behaviors` environment's deployment branch policy to **branch `main` only**; do not allow other branches or tags to access these secrets.
Qualification dispatches must therefore run from `main` after the reviewed workflow lands there through the normal review process.
The implementation does not push or merge itself.
After qualification, protection rules must permit trusted `main` pushes without required manual approval if fully automatic execution is intended.
Do not broaden the deployment branch policy or remove security controls without administrator review; a workflow waiting for environment approval has not executed remotely.

## Runner interface and local reproduction

Use retained verified artifacts rather than rebuilding a failing candidate.
Extract the release artifact and behavior-bundle artifact into the same directory layout used by the workflow, then verify:

```sh
node scripts/release-artifacts.mjs verify .artifacts/release
sha256sum -c .artifacts/daytona-bundle/SHA256SUMS
```

Artifact verification requires a checkout of the matching source commit and its unchanged lockfile and distribution policy.
`DIFFEX_SOURCE_COMMIT` may be set to enforce the expected commit explicitly.

Run one mode with a fresh output directory and unique run ID:

```sh
/tmp/diffex-daytona-venv/bin/python scripts/daytona-behaviors/daytona_runner.py run \
  --artifacts .artifacts/release \
  --bundle .artifacts/daytona-bundle/bundle.tar.gz \
  --snapshot diffex-behaviors-toolchain-v1 \
  --output .artifacts/daytona-deterministic \
  --mode deterministic \
  --commit "$(git rev-parse HEAD)" \
  --run-id "manual-$(date +%s)-$$-deterministic"
```

`--bundle` accepts a bundle directory or a tar.gz archive.
For a live run use `--mode live`, a separate output directory/run ID and the approved `OPENAI_API_KEY` environment secret.
The Daytona API key belongs only on the orchestration machine; it must not be supplied as an in-sandbox environment variable.

Expected local output:

- `state.json`: durable identity written before sandbox creation, used for recovery.
- `orchestration.json` and `orchestration.xml`: orchestration outcomes and cleanup evidence.
- `evidence/results.json` and `evidence/results.xml`: incremental installed-suite results.
- Available per-scenario transcripts, events, terminal captures/baseline comparisons and other diagnostic files produced by the harness.
- `workflow-job.json`: CI-only record of exact source, run identity, execution and recovery outcomes.

Do not delete or hand-edit `state.json` while a sandbox may exist.
For interrupted execution, retained output or cleanup failure:

```sh
/tmp/diffex-daytona-venv/bin/python scripts/daytona-behaviors/daytona_runner.py recover \
  --output .artifacts/daytona-deterministic
```

Recovery must not create a replacement sandbox or re-execute tests.
It must preserve failure evidence and positively confirm deletion; an attempted delete is not enough.
If credentials, runner termination or service failure prevent confirmation, treat cleanup as failed and use the saved sandbox/run identity with the Daytona owner to reconcile resources.
CI's always-run step is best effort under cancellation or runner loss, not a guarantee that GitHub will execute cleanup.
Recover manually and confirm no run-owned sandboxes remain before closing the incident.

## Local executable checks and baseline review

To exercise an already installed executable without creating a Daytona sandbox:

```sh
python3 scripts/daytona-behaviors/installed.py \
  --executable /path/to/installed/node_modules/.bin/diffex \
  --output /tmp/diffex-local-behaviors \
  --mode deterministic \
  --commit "$(git rev-parse HEAD)"
```

Use a fresh output directory and the required local Node, tmux and search-helper toolchain.
This executable-only mode does not establish reviewed-tarball installation integrity, both package-manager paths or remote qualification.
For an intentional local baseline refresh, append `--update-baselines` to that command.
Only a local reviewer may regenerate baselines, inspect the raw and normalized terminal captures, review the baseline diff and submit intentional changes through normal review.
CI never passes `--update-baselines` and must fail rather than automatically accepting a changed layout.

## Qualification and enabling automatic runs

Qualification requires a user with Daytona access and approved provider spending authority.
The implementation must remain **unqualified** until that user supplies and reviews real evidence.

1. Leave `DAYTONA_BEHAVIORS_QUALIFIED` unset or `false`; configure the main-only environment and prepare the toolchain snapshot.
   Wait until the reviewed workflow and harness land on `main`; these instructions do not authorize a push or merge.
2. Dispatch a passing qualification run from `main`:

   ```sh
   gh workflow run daytona-behaviors.yml --ref main
   ```

   Record the resolved 40-character commit and workflow run URL; the workflow checks out that event's SHA, not a later branch tip.
   Require successful deterministic **and** live results against the same retained candidate hashes, the complete expected behavior inventory and reviewed terminal baselines.
   Confirm the live path actually reached the approved provider rather than a fixture.
   Verify provider request/token/time limits and that neither evidence nor logs contain credentials or unrelated user state.
3. Require an **intentional product-assertion failure**, not just a missing credential or transport error.
   An operator can copy the retained harness into a separate local bundle, deliberately corrupt one expected terminal baseline and run the deterministic remote CLI against the unchanged retained candidate:

   ```sh
   bad_bundle="$(mktemp -d /tmp/diffex-daytona-bad-baseline.XXXXXX)"
   tar -xzf .artifacts/daytona-bundle/bundle.tar.gz -C "$bad_bundle"
   printf 'intentional qualification mismatch\n' > "$bad_bundle/scripts/daytona-behaviors/baselines/startup-80x24.txt"
   /tmp/diffex-daytona-venv/bin/python scripts/daytona-behaviors/daytona_runner.py run \
     --artifacts .artifacts/release --bundle "$bad_bundle" \
     --snapshot diffex-behaviors-toolchain-v1 \
     --output .artifacts/daytona-intentional-failure --mode deterministic \
     --commit "$(git rev-parse HEAD)" --run-id "failure-$(date +%s)-$$"
   ```

   Expect a nonzero exit and a recorded baseline assertion failure, retained JSON/XML and captures, and confirmed sandbox deletion.
   Run `recover --output .artifacts/daytona-intentional-failure` if needed; it must not relaunch or turn the failed execution into a pass.
   Record the deliberately altered bundle identity separately; never replace the original retained bundle, regenerate its approved checksum or commit the bad baseline.
   Retain the local CLI output directory with the qualification record; this rehearsal needs no new workflow inputs.
4. Require a **cancellation rehearsal**: dispatch another run from `main`, wait until a sandbox and behavior execution exist, then cancel that workflow run.
   Retain the run URL, sandbox/run identities and whatever incremental artifacts were uploaded.
   Recover available saved output without relaunching; if cancellation prevented artifact upload, use the recorded run labels and the Daytona owner to reconcile resources.
   Confirm deletion of every sandbox created by that run; missing evidence or an attempted delete alone does not satisfy qualification.
5. Require **two overlapping workflow runs**: dispatch twice from `main` without waiting for the first to finish, and verify that both actually execute concurrently rather than queue behind environment approvals.
   For each run separately, verify the resolved source commit, unique run/attempt/mode identities, release and bundle artifacts, deterministic/live results, aggregate evidence and confirmed deletion of every owned sandbox.
   Confirm that neither run cancels the other, overwrites the other's artifacts, mixes evidence or deletes the other's active sandbox.
6. Also exercise creation/upload/execution/download failures, missing/incomplete result evidence and cleanup failure through operator-controlled remote rehearsals.
   Retain proof that failures stay failed, recovery does not relaunch and deletion is positively confirmed.
   Local mock tests are supplementary, not substitutes for these remote rehearsals.
7. Review all passing, intentional-failure, cancellation and overlapping-run evidence, snapshot/toolchain identities, sandbox IDs and cleanup confirmations.
   Keep a qualification record with owner, date, commits, workflow run URLs, snapshot, artifact/bundle hashes, provider/model, bounded cost and failure-path evidence.
   Ensure no orphaned run-owned sandboxes remain.
8. Only after those checks pass, an administrator enables subsequent pushes:

   ```sh
   gh variable set DAYTONA_BEHAVIORS_QUALIFIED --body true
   ```

   Observe the next `main` push and require both modes plus aggregate to execute automatically.
   Setting the variable does not retroactively execute skipped pushes.

To suspend automatic spending without removing dispatch or evidence:

```sh
gh variable set DAYTONA_BEHAVIORS_QUALIFIED --body false
```

Requalify after material snapshot, SDK, credential policy or harness changes.
Neither a static workflow test nor setting the variable proves remote qualification.
