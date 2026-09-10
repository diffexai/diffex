# Verified release publication

## Ownership and release order

The CLI monorepo owns npm verification and release-record publication through `scripts/publish-release-announcement.mjs` and `.github/workflows/build-binaries.yml`.
The independent public API Worker in `diffex-cloud` consumes these records; Worker, Render, and landing deployments do not advance them.

The release workflow builds binaries, stages a draft GitHub Release, publishes npm packages, announces verified npm availability, and finally publishes the GitHub Release.
The R2 marker means that all public workspace packages resolved at their exact release version and their tarballs were available.
It does not independently guarantee that binary assets are already public.
This setup does not authorize running a release or bypass the repository's release requirements.

## Credentials and environment boundaries

Release storage belongs to account `6b24afa849f8254ab5e6e2d1956239cc`.
The publisher endpoint is `https://6b24afa849f8254ab5e6e2d1956239cc.r2.cloudflarestorage.com`.

| Environment | Bucket | Credential |
| --- | --- | --- |
| `diffex-release-upload` | `diffex-artifacts` | Dedicated production Object Read & Write token restricted to this bucket. |
| `diffex-release-staging` | `diffex-artifacts-staging` | Separate staging Object Read & Write token restricted to this bucket. |

Each environment stores `DIFFEX_ARTIFACTS_R2_ACCESS_KEY_ID` and `DIFFEX_ARTIFACTS_R2_SECRET_ACCESS_KEY` as GitHub environment secrets.
The workflow maps them to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` only in the corresponding job.
Production environment policies allow the `main` branch and `v*` tags; staging allows only `main`.
The repository's GitHub plan rejected required-reviewer protection with HTTP 422.
The owner approved branch/tag restrictions without required reviewers on 2026-09-10.
GitHub reports `can_admins_bypass: true`; there is no enforced human approval gate.
Review release tags and any manually selected recovery source before dispatching a workflow.
These restrictions apply to the workflow ref, so a recovery `source_ref` still needs maintainer review.
Missing credentials fail before npm verification or storage access.
Use an AWS CLI that supports `put-object --if-match` and `--if-none-match`.

The original `diffex-model-upload` environment had no secrets or protection rules when inspected on 2026-09-10.
Release publication now has a dedicated environment so configuring release credentials cannot redirect the model publisher.
The model-catalog workflow retains its existing environment and former account endpoint; model publication and any old-account data migration require their own setup.
Do not copy release credentials into that environment.

Bucket-scoped Object Read & Write credentials can mutate other objects within their own bucket, including any future model objects in the production bucket.
They do not enforce a `releases/v1/` prefix boundary and must never be distributed to clients.
The publisher itself uses fixed release-record keys.
See [Cloudflare R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) for the storage capability boundary.

Users call the public version endpoint without R2 credentials.
The planned Worker accesses private storage through a native binding, which supports both reads and writes.
If enforced read-only storage access is required, configure a separate read-only credential per Worker environment during endpoint implementation.

## Publication invariants

Before any write, the publisher inventories every non-private workspace package and requires its version to match the requested canonical stable semver.
It checks exact npm package identity and version, integrity metadata, and tarball availability for all packages.
Requests have a 30-second timeout, npm propagation retries have a ten-minute budget, and storage commands have a one-minute timeout.

`releases/v1/releases/<version>.json` is created with `If-None-Match: *`.
On a repeated announcement, the existing record must match the verified version, commit, and package metadata.
An interrupted announcement reuses that record's original bytes and timestamp for `releases/v1/latest.json`.
A conflicting immutable record fails without replacing it.

The latest-pointer update reads the body and ETag from one GET response and uses `If-Match` for replacement or `If-None-Match: *` for first publication.
Lost races retry at most five times, rereading the current version before each attempt.
Equal or older announcements cannot replace a newer pointer.
Malformed existing pointers and storage permission errors fail closed; they are not treated as an absent release.
Provider diagnostics are withheld from errors to avoid exposing credentials or signed request details.

If npm verification fails, neither record is written.
If the versioned write succeeds but the pointer update fails, rerun the announcement for the same source commit after correcting the failure.
Never delete a production immutable record to force a retry or lower the latest version as ordinary recovery.

## Controlled regression and staging verification

Run from the CLI repository root:

```sh
node --test scripts/publish-release-announcement.test.mjs
npm run check
./test.sh
```

The command-level regression launches the actual publisher with isolated manifests representing every public workspace package.
A test-only preload controls registry and tarball responses and rejects other Node network connections.
Default tests intercept the AWS executable as well, so they require no SaaS credentials and write no remote objects.
Before the fixes, this reproduction failed for missing credentials, interrupted-record consistency, and conflicting source commits.

To deliberately verify real storage, supply the staging key through the environment and run:

```sh
node scripts/verify-release-publication.mjs --staging
```

The staging command fixes the reviewed account and staging bucket in code, uses controlled npm responses, and executes the real AWS CLI for storage.
It never publishes npm packages or runs the release workflow.
The smoke test checks failed verification before first publication, matching record creation, safe repetition, failed verification after publication, conditional advancement, older announcements, and interrupted-announcement recovery.

The verifier acquires `verification/release-publication.lock` conditionally and refuses to start if the latest pointer or selected version keys already exist.
It uses synthetic versions only in staging, tracks exact keys, and deletes only objects bearing its unique run identity.
Cleanup verifies every fixture key is absent and removes the lock.
If cleanup fails, the lock remains for investigation; inspect its recorded keys and ownership before removing anything.
Do not empty the bucket or delete another run's records.

`.github/workflows/verify-release-publication.yml` exposes the same verification as a manual-only workflow using the staging environment.
It requires no dependency installation and is excluded from default PR CI.
Dispatch it from `main` once the workflow is merged; adding a workflow on a pull request does not make it dispatchable from the default branch.

## Verification evidence

On 2026-09-10, both newly supplied keys successfully listed release records in their own buckets and received `AccessDenied` for the other release bucket and the unrelated `image-converter` bucket.
Both release namespaces were empty before the staging check.
The previous shared key was not installed in GitHub; revoking it remains a separate Cloudflare owner action.
The 14 focused publisher regressions, `npm run check`, `./test.sh`, and actionlint 1.7.12 checks of both changed workflows passed.
No real release was run.

Live staging verification passed with AWS CLI 1.46.1 and Node 22.19.0 using the dedicated staging key.
The actual publisher ran with controlled npm metadata for all 11 public workspace packages and real R2 requests.
The fixture versions were `0.1789059755304.0` and `0.1789059755304.1`.
Both matching records, byte-preserving repeated publication, unchanged pointers after verification failures, conditional advancement, older-announcement rejection, and interrupted-record recovery passed.
The exact cleanup covered `releases/v1/latest.json`, `releases/v1/releases/0.1789059755304.0.json`, `releases/v1/releases/0.1789059755304.1.json`, and `verification/release-publication.lock`; each was confirmed absent afterward.

The GitHub environment secret names and timestamps were verified after secure installation on 2026-09-10 at 17:03 UTC.
No secret values were printed, committed, or copied into client or Worker configuration.
This verifies credential configuration and real publisher-to-R2 behavior; a GitHub-hosted staging run remains available after the new manual workflow reaches `main`.

A final credential-isolation check confirmed both release namespaces remained empty after staging cleanup.
