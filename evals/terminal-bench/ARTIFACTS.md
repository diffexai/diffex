# Artifact collection and shutdown verification

`full.yaml` and the staged benchmark runner use `RecordedDaytonaEnvironment` with the pinned Harbor 0.24.0 and Daytona 0.226.1 APIs.
The backend mounts the shared `diffex-terminal-bench-logs` volume at `/logs`, with a fresh `trials/<uuid>` subpath for each sandbox creation.
Override `environment.kwargs.artifact_volume` to select a different project volume.
The backend waits up to 120 seconds for volume readiness and records its name, ID, mount path, and subpath in the trial's `artifact-volume.json` before creating the sandbox.
The file retains a `mounts` list with session and environment names, so separate verifiers and restarted environments do not replace the agent's recovery location.
Harbor's Docker-in-Docker backend binds the corresponding `/logs` subdirectories from the sandbox host into the task container.

Sandbox creation allows an initial attempt plus three startup-timeout retries, with deadlines of 60, 60, 60, and 300 seconds.
There is no retry backoff; each timed-out attempt first receives up to 20 seconds for sandbox lookup and deletion before the next create starts.
The adapter uses one unique sandbox name across these attempts to recover accepted creates after lost responses and prevent duplicate allocation from late requests.
`sandbox-startup.json` records attempt deadlines, outcomes, sandbox names, and cleanup results.
Failed cleanup stops retries and retains any known sandbox reference for Harbor's final cleanup.
Cancellation and non-timeout provider errors do not trigger creation retries.
The fourth creation timeout raises `EnvironmentStartTimeoutError`; Harbor's overall environment deadline still applies, including volume preparation and cleanup overhead.
These retries occur before agent execution and do not rerun evaluation attempts or change `--max-retries 0`.

Agent home, installed task packages, caches, and mutable harness state live in a private `/tmp/diffex-tb-state-*` directory on sandbox disk.
They remain available to task services through verification and disappear with sandbox deletion.
The exported `state.json` records these paths without linking the state tree into the logs.
Logs, native sessions, transcripts, process identities, and ownership records live under `/logs/agent/run-*` on the volume.

After requesting cleanup, the adapter retrieves only `cleanup.json`, `stop-requested`, available launcher/CLI identities, `process.json`, and ownership records through a separate small JSON response.
It validates the report against the independent identity and ownership files before starting the bulk download.
Retrieval makes at most three attempts, with a 20-second request limit and a 90-second total budget including exponential backoff, jitter, and any server `Retry-After` delay.
A report that has not yet been published is retried; malformed or negative shutdown evidence is rejected.
Bulk extraction cannot change the independently validated shutdown decision.

Once shutdown is confirmed, bulk download, trajectory export, or local artifact persistence failures appear in `artifact_errors` and permit Harbor's verifier to run.
Such a trial is still recorded as an artifact collection failure unless another conclusive execution failure or interruption already explains its outcome.
Missing or invalid shutdown evidence raises `DiffexControlStopError` and continues to block verification.
Release qualification still requires valid retained execution evidence; permitting verification does not qualify an incomplete artifact set.

## Quotas and retention

Daytona recommends a shared volume with isolated subpaths and allows at most 100 volumes per organization, so a 445-trial run consumes one project volume rather than 445 volumes.
Volume data persists after sandbox deletion and does not count against sandbox disk quota.
Volumes use FUSE and are slower than sandbox disk, which is why package installation and caches remain local.
See the [Daytona volume documentation](https://www.daytona.io/docs/en/volumes/).

The documented Tier 4 pool is 500 vCPUs, 1,000 GiB RAM, and 5,000 GiB sandbox storage, with 50,000 general API requests and 600 sandbox creations per minute.
Keep job concurrency within the organization's remaining capacity, accounting for other running or stopped sandboxes and each task's resource requirements.
See the [Daytona limits documentation](https://www.daytona.io/docs/en/limits/).
This change does not increase job concurrency or sandbox resources.

The staged runner automatically prunes a completed Diffex trial's volume prefixes after qualification, before releasing its concurrency slot.
The native Harbor command in the README enables the same behavior with `--plugin diffex_terminal_bench.retention:VolumeCleanupPlugin`.
Pass this CLI option explicitly in other native run commands too; do not rely on YAML to activate the cleanup plugin.
Cleanup requires a completed trial and verifier result, matching local reward and verifier logs, valid native shutdown and execution evidence, a valid trajectory, and no artifact errors or native session gaps.
A zero reward is eligible; failed, interrupted, oracle-only, and incomplete trials retain their remote logs.
All recorded trial sandboxes must be absent before deletion, including separate verifiers and retained task services.
One short-lived Python sandbox mounts only that trial's exact prefixes, compares every remote file's SHA-256 against the local artifact copy, and empties the prefixes only if all files match.
Unknown files, symlinks, or mismatched files preserve remote data for recovery.
Local logs, transcripts, and results remain available.
`volume-cleanup.json` records the decision, prefix locations, deleted file count, and cleanup sandbox deletion status.
Cleanup failures do not change verifier results and retain recovery locations; transport operations use bounded retries.
Remote comparison and pruning allow three attempts within 210 seconds, with a 60-second execution limit per attempt.
The cleanup sandbox is deleted in a shielded finalizer, with a two-minute idle stop, immediate deletion after stopping, and a ten-minute maximum lifetime as fallbacks.
This uses one extra sandbox creation per eligible trial, within the existing worker slot; include that overhead in the Tier 4 creation-rate and compute budget.
The shared volume itself remains available to subsequent trials and concurrent jobs.

To recover artifacts, select the relevant session in `artifact-volume.json`, mount its volume ID and exact subpath on a temporary sandbox, and download `/logs`.
Delete that recovery sandbox afterward.
Remove only a trial's recorded subpath when its artifacts are no longer needed; do not delete the shared volume while any job uses it.
