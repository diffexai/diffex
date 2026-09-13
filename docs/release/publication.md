# Verified release publication

## Ownership and release order

The CLI monorepo owns npm verification and release-record publication through `scripts/publish-release-announcement.mjs` and `.github/workflows/build-binaries.yml`.
The independent public API Worker in `diffex-cloud` consumes these records; Worker, Render, and landing deployments do not advance them.

The release workflow verifies one immutable source commit, freezes model data and source inputs, builds the approved npm packages, retains their exact bytes, publishes missing versions, and announces verified npm availability.
The R2 marker means all public workspace packages were downloaded at their exact release version and matched the retained approved artifact digests.
Standalone binaries remain deferred, and the npm record contains no binary manifest.
See [promotion and recovery](promotion.md) for the complete prerequisites, private artifact retention, and partial-failure procedures.
This setup does not authorize running a release or bypass the repository's release requirements.

See [publication trust and bootstrap evidence](publication-trust.md) for the private-source OIDC decision and the current live verification record.

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
These restrictions apply to the workflow ref; the resolver additionally rejects a recovery `source_ref` that differs from the immutable tag commit.
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
The deployed staging Worker accesses private storage through a native binding, which supports both reads and writes.
If enforced read-only storage access is required, configure a separate read-only credential per Worker environment during endpoint implementation.

## Publication invariants

The [stable release contract](contract.md) specifies the exact stored schema and public HTTP projection.
The publisher now enforces that schema for both new and existing records.
The unchanged consumer fixture suite verifies the deployed npm record shape and public response projection.

Before any write, the publisher inventories every non-private workspace package and requires its version to match the requested canonical stable semver.
It checks exact npm package identity and version, downloads every canonical tarball without redirects, and compares its size, SHA-256, and SHA-512 with the retained manifest.
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
Publisher-only verification requires no dependency installation and is excluded from default PR CI.
The optional client canaries install the locked dependencies with lifecycle scripts disabled.
Dispatch it from `main` once the workflow is merged; adding a workflow on a pull request does not make it dispatchable from the default branch.

## Verification evidence

On 2026-09-10, both newly supplied keys successfully listed release records in their own buckets and received `AccessDenied` for the other release bucket and the unrelated `image-converter` bucket.
Both release namespaces were empty before the staging check.
The original record referred to a previous shared R2 key that was not installed in GitHub.
That record retained no credential name, identifier, location, or confirmed scope, so it does not establish that an active credential exists or justify revocation.
Only an identified, verified superseded credential could be considered for owner-directed retirement; the current dedicated R2 keys and Worker deployment token are unaffected.
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

## Deployed public API verification

The optional `--public-api` flag adds actual unauthenticated HTTP checks against the fixed staging Worker:

```sh
node scripts/verify-release-publication.mjs --staging --public-api
```

The manual workflow exposes the same flag as `check_public_api`, disabled by default.
Only the CLI staging environment supplies publication credentials; the Worker deployment workflow never receives them.
The verifier tests canonical projection, missing releases, malformed JSON, unsupported schema, prereleases, ignored query selectors, rejected methods and suffixes, readiness, and unchanged storage after HTTP requests.
It restores malformed fixtures conditionally and removes only records owned by the run.
A final HTTP failure still releases the lock after successful object cleanup; actual storage cleanup failure retains the lock for investigation.

Live verification passed on 2026-09-10 using synthetic versions `0.1789069419298.0` and `0.1789069419298.1`.
The real publisher used controlled npm responses for all 11 packages, real staging R2, and the deployed Worker.
Both release keys, the latest pointer, and the shared lock were confirmed absent afterward.
The production latest record remained absent.
The [cloud staging acceptance record](https://github.com/diffexai/diffex-cloud/blob/feat/serve-verified-releases/docs/public-api-staging.md) records Worker deployment identities, the separate missing-binding failure and recovery test, and unchanged Render routing.
This proves publisher-to-R2-to-HTTP behavior; the installed CLI authority migration and canary remain separate work.

## Source CLI staging canaries

Use the staging-only publication credentials and an AWS CLI supporting conditional writes:

```sh
node scripts/verify-release-publication.mjs --staging --client-canaries
```

The manual workflow exposes this as `check_client_canaries`, disabled by default, and automatically includes the HTTP checks.
The command uses the same exclusive staging lock, ownership checks, conditional writes, and verified cleanup as publication verification.
It adds manual and interactive source CLI clients while each controlled record is present in real R2.
Each client gets an isolated home, project, credentials directory, and simulated npm prefix.
The test-only preload maps the exact production version URL to the fixed staging HTTPS endpoint and rejects redirects.
It permits sockets only to that staging hostname on port 443, intercepts every package-manager subprocess, and never passes storage credentials into the client.
The production client has no endpoint override.

Canaries cover missing releases, newer/equal/older releases, normal and forced updates, manual retries, offline mode, automatic opt-out, and quiet interactive startup and `/exit` in a real 100x30 terminal.
Malformed JSON, wrong schema, prerelease versions, missing or duplicate canonical packages, package-version mismatches, and foreign identities must produce an unavailable response and no install even with force.
Every successful install attempt must match the complete expected npm argument list, pinned to `@diffexai/diffex@<validated-version>` without uninstall.
The JSON evidence captures requested and actual URLs, response status and public body, socket destination, intercepted install command, and verified local cleanup.
Install telemetry is intercepted separately without network traffic; its Pi dependency remains separate migration work.
The source canary does not establish published-package installation or binary acceptance.
See [the client canary acceptance record](client-canaries.md) for executed results and remaining limits.
