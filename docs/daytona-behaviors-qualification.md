# Daytona behavior qualification — 2026-10-27

## Status

**Real-service CLI qualification passed. GitHub Actions qualification remains pending.**

The snapshot, installed package scenarios, live OpenAI transport, intentional assertion failure, overlapping CLI runs, active cancellation and runner-loss recovery were exercised against Daytona. This is not evidence that the GitHub workflow or its 30-day artifact retention has executed successfully.

At qualification time, remote `main` was `c79aa4ccf251507c39cbc132353231cc08ca01fe` and did not contain `daytona-behaviors.yml`. The user's no-push restriction was retained. `DAYTONA_BEHAVIORS_QUALIFIED` remains `false`; automatic spending has not been enabled.

## Inputs

| Input | Identity |
| --- | --- |
| Frozen candidate source | `d025b29e554c13c4835a2d592adf47c39d49b752` |
| Package | `@diffexai/diffex@0.4.0` |
| Reviewed tarball SHA-256 | `da75c4042adbc0146b213682cb2a2477a5f1c97c6853b7179557648b70b47b92` |
| Corrected scenario harness | `6efd24323c7d14bb85e2dfe62a774f85c7643a4a` |
| Corrected harness bundle SHA-256 | `d5b57d1e15f1b39e1c0734747b7080a4c590a8dea6e34461816f02415a4df29e` |
| Publication guard | `805454eb6` |
| Snapshot | `diffex-behaviors-v1-e94e1af7cbc7` |
| Snapshot ID | `2a851315-6915-40e8-9b38-0446b7d329f5` |
| Dockerfile SHA-256 | `e94e1af7cbc73ce2b1a9b85e79974f73a39d69f9187f58daeb885bed90fa5f3a` |

The candidate was frozen, built offline, packaged and verified once. Corrected harness bundles reused those retained candidate bytes rather than silently rebuilding or replacing a failed candidate. Candidate and harness commits are recorded separately; the corrected harness is not represented as part of the older frozen source commit.

The real sandbox reported Node `22.23.2`, npm `11.16.0`, Bun `1.3.11`, Python `3.11.2`, tmux `3.3a`, ripgrep `13.0.0` and fd `8.6.0`. Snapshot and sandbox resources were checked as 2 vCPU, 4 GiB RAM and 8 GiB disk. Creation requests used the 45-minute wall-clock TTL.

## Successful installed-package runs

Both modes used the same retained tarball and corrected harness bundle.

| Run directory | Result | Evidence |
| --- | --- | --- |
| `deterministic-v4/` | All 13 scenarios passed | npm and Bun installation/inventory checks; help/version/models/resolution; print; built-in OpenAI API-key transport fixture; real read/write/edit/bash; cancellation/recovery; clean exit; persisted-session resume; 80×24, 120×40 and resize baselines; existing artifact login/terminal acceptance |
| `live-v3/` | All 3 scenarios passed | Retained artifact/toolchain integrity, npm installation integrity, real OpenAI print and interactive read/write task |

The live run used `openai/gpt-4.1-mini`, made **4 provider requests**, produced **98 output tokens** total (maximum **38** in one request), and reported approximately **$0.00205** provider usage. The harness capped every request at 512 output tokens and the smoke at three minutes after installation. It observed 41 streamed text events, successful real `read` and `write` tools, exact input/output file bytes and application exit code 0.

The reported cost is for the final passing live run, not an account billing total. Earlier failed or superseded harness runs remain retained separately.

## Failure and lifecycle rehearsals

- **Intentional assertion failure:** `intentional-failure/` used a separately identified bundle with a deliberately wrong 80×24 baseline. Both package-manager terminal scenarios failed with `Layout differs: startup-80x24.txt`; the runner exited nonzero, retained JSON/JUnit/captures, and confirmed deletion. The approved bundle was not modified.
- **Two overlapping runs:** `overlap-a/` and `overlap-b/` had simultaneous sandbox lifetimes, distinct sandbox IDs and ownership labels, successful complete deterministic results, separate evidence and confirmed deletion. These were overlapping CLI invocations, not GitHub workflow runs.
- **Active cancellation:** `cancel-active/` received SIGTERM after remote execution began and before completion. It remained failed, explicitly reported incomplete final results, and confirmed deletion. Missing results did not become a pass.
- **Runner loss and recovery:** the initial `live-v1/` and `deterministic-v2/` supervisors were killed after an evidence-transport incompatibility was diagnosed. `recover` retrieved completed remote reports without relaunching tests, preserved their failed assertions and confirmed deletion.
- **Independent final audit:** fresh lookups by sandbox ID and name, plus ownership-label queries, confirmed that **all 10 sandboxes created during this qualification were deleted**. The reusable toolchain snapshot is intentionally retained.

Fake-client tests additionally cover ambiguous creation, unavailable lookups, upload/input failures, ownership mismatch, cleanup failures, corrupt or missing evidence, invalid JUnit and interruption. These tests are not represented as real Daytona service-outage rehearsals.

## Issues discovered and fixed

Failures were preserved; assertions were not automatically rerun.

1. The SDK returns a string-backed enum for snapshot state. Stringifying it produced `SnapshotState.ACTIVE` rather than `active`; readiness now compares the actual enum value correctly.
2. SDK `0.226.1` rejects streaming downloads of empty files. The runner now materializes an empty file locally only after verifying its declared zero size and SHA-256. Nonempty evidence still uses streaming downloads.
3. Polling tolerated changed log bytes but final collection did not previously require completeness. Final evidence now requires complete size/hash verification, matching JSON identity/evidence references, and parsed JUnit with matching scenarios and outcomes.
4. The sandbox's tmux could report a dead pane without a usable pane exit status. A PTY-preserving launcher now independently records the actual application child's return code; zero exit and a dead pane are both required. This does not replace the application's terminal, session or UI implementation.
5. The first live model copied the marker but omitted its trailing newline. The fixture now contains an unambiguous marker with no trailing newline; byte-for-byte output verification remains required.
6. Actions artifacts in this public repository are not confidential. A fail-closed publication guard now scans every evidence file, including launcher/install logs, before publishing a separate sanitized tree. Credential findings fail the producing job; unexpected guard failures block upload entirely. Authentication files and symlinks are excluded. Hidden evidence files are retained.

## Evidence and secret handling

Local evidence roots, relative to the repository:

```text
.artifacts/daytona-qualification/
.artifacts/daytona-qualification-final-sanitized/
```

Useful records include:

- `qualification-summary.json`
- `preparation-report.json`, `SHA256SUMS` and `logs/`
- `snapshot-v1/snapshot.json`
- `deterministic-v4/{state.json,orchestration.json,orchestration.xml,evidence/}`
- `live-v3/{state.json,orchestration.json,orchestration.xml,evidence/}`
- `rehearsals.json` and `interruption-rehearsal.json`
- `independent-deletion-audit.json`
- The sanitized root's `publication-safety.json`

The final publication guard scanned **955 files** and found **zero exact matches** for either real credential. Keys were loaded privately from the owner's external credential file, never placed in command arguments, printed or committed. The Daytona key stayed outside sandboxes; only live execution received the OpenAI key. GitHub stores both as encrypted, main-only environment secrets.

These ignored local directories are not a 30-day GitHub retention guarantee. No qualification evidence was uploaded through Actions because the workflow was not present on remote `main`. Treat any future Actions evidence as non-confidential sanitized data, not a secret store.

## Remaining GitHub boundary

After explicit authorization to push the reviewed commits, follow [the operator procedure](daytona-behaviors.md#qualification-and-enabling-automatic-runs):

1. Push through the repository's normal review/protection process; do not bypass branch protection.
2. Dispatch the workflow on its exact remote `main` commit and require both modes plus aggregate to pass with 30-day artifacts.
3. Rehearse workflow cancellation and two overlapping workflow runs; confirm per-run evidence retention and sandbox deletion.
4. Review the retained results before setting `DAYTONA_BEHAVIORS_QUALIFIED=true`.

A successful CLI qualification does not authorize skipping those GitHub checks or enabling the qualification variable early.
