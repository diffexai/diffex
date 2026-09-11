# Staging release client acceptance

Verified on 2026-09-10 with Node 22.19.0 and AWS CLI 1.46.1.
All 21 source CLI canaries passed against real R2 and the deployed staging Worker.
The CLI source is based on `9b6f2dcab` from PR #204, with the reusable canary harness added on `feat/staging-version-canaries`.
The cloud source and regression checks use `01c1205` from Diffex Cloud PR #145.
The [cloud staging record](https://github.com/diffexai/diffex-cloud/blob/feat/serve-verified-releases/docs/public-api-staging.md) documents the existing deployment; this run made no Worker deployment.

## Executed command and boundary

From the CLI repository root, with the dedicated staging credentials supplied through the environment:

```sh
node scripts/verify-release-publication.mjs --staging --client-canaries
```

The real publisher verifies controlled npm responses for all 11 public workspace packages and writes only the private `diffex-artifacts-staging` bucket in account `6b24afa849f8254ab5e6e2d1956239cc`.
It created synthetic versions `0.1789086098745.0` and `0.1789086098745.1`; these are test fixtures, not published npm releases.
Every client requested `GET https://api.diffex.ai/api/latest-version` with manual redirect handling.
Only the test preload remapped that exact URL to `https://diffex-public-api-staging.yibai14651.workers.dev/api/latest-version`.
Actual sockets were restricted to that hostname on port 443.
Requests were anonymous, with no cookies or R2 credentials supplied to the clients.
Every response had a JSON content type and `Cache-Control: no-store`.

Manual commands ran the source CLI with `update --self`, adding `--force` where listed.
Separate temporary manifests modeled installed versions below, equal to, and above the staging record.
Interactive clients ran with `--no-session --no-extensions --no-skills` in a real 100x30 PTY, waited for the staging response and welcome screen, and exited through `/exit` without submitting a model prompt.
The harness removed every temporary home, project, credential directory, event record, and simulated installation prefix.

## Observed behavior

| Canary | Version requests | HTTP | Exit | Install attempts |
| --- | --- | --- | --- | --- |
| missing release | 1 | 404 | 1 | 0 |
| forced missing release | 1 | 404 | 1 | 0 |
| interactive missing release | 1 | 404 | 0 | 0 |
| newer release | 1 | 200 | 0 | 1 |
| equal release | 1 | 200 | 0 | 0 |
| older release | 1 | 200 | 0 | 0 |
| forced equal release | 1 | 200 | 0 | 1 |
| forced older release | 1 | 200 | 0 | 1 |
| manual automatic opt-out | 1 | 200 | 0 | 1 |
| manual offline | 0 | none | 1 | 0 |
| interactive newer release | 1 | 200 | 0 | 0 |
| interactive offline | 0 | none | 0 | 0 |
| interactive automatic opt-out | 0 | none | 0 | 0 |
| forced invalid JSON | 3 | 503 | 1 | 0 |
| interactive unavailable | 1 | 503 | 0 | 0 |
| forced wrong schema | 3 | 503 | 1 | 0 |
| forced prerelease semver | 3 | 503 | 1 | 0 |
| forced missing canonical package | 3 | 503 | 1 | 0 |
| forced duplicate canonical package | 3 | 503 | 1 | 0 |
| forced package version mismatch | 3 | 503 | 1 | 0 |
| forced foreign package | 3 | 503 | 1 | 0 |

Missing releases printed `No published Diffex release is available yet.` and exited 1 after one request.
Invalid stored records produced HTTP 503 and `Diffex update service is unavailable. Try again later.`, with three manual requests and no package commands even under force.
Interactive failures stayed quiet and made at most one version request.
Equal and older releases printed `already up to date` unless forced.
Offline mode suppressed all version requests, while automatic opt-out still allowed manual update.

All four intercepted install attempts matched:

```sh
npm --prefix <isolated-prefix> install -g --ignore-scripts --min-release-age=0 @diffexai/diffex@0.1789086098745.0
```

No package-manager process executed, no uninstall was attempted, and no installed software changed.
The preload intercepted the separate `https://pi.dev/api/report-install` call during non-offline startup and returned a controlled failure without forwarding it.
There was no Pi version-check traffic or any Pi socket connection.
Install telemetry, model catalogs, and Radius remain separate migration work.

## Regression and artifact checks

The focused checker, source CLI, package-command, and consumer-contract suites passed all 155 tests before the harness extraction.
The changed source CLI test file passed all 32 cases after extraction, and the final full isolated `./test.sh` run passed.
That full run includes the publisher and shared contract corpus, all changed tests, and default tests with live E2E disabled.
The checker tests cover invalid HTTP JSON, unsupported semver, exact identity validation, timeouts, HTTP errors, all supported redirect statuses without forwarding, retry limits, offline mode, and automatic opt-out.
The stored-record corpus covers wrong schemas, missing and duplicate packages, and identity/version mismatches.

The CLI `npm run check`, workflow validation with actionlint 1.7.12, and Cloud-to-CLI contract document and fixture comparisons passed.
Cloud root `npm run check` passed 546 unit and 23 integration tests and its typecheck, lint, formatting, database, build, and audit checks.
The isolated Worker `npm run check` passed 335 tests, typecheck, lint, formatting, staging deployment dry run, and audit.

The initial local artifact scan found the historical Pi endpoint in `packages/coding-agent/dist/utils/version-check.js`.
With explicit owner approval, `npm run build` from `packages/coding-agent` refreshed the local artifact without publishing or modifying generated files manually.
The final scan returned no matches:

```sh
rg -n 'pi\.(dev|codes)/api/latest-version' packages/coding-agent/src packages/coding-agent/dist --glob '!*.map'
```

Both `src/utils/version-check.ts` and rebuilt `dist/utils/version-check.js` contain the canonical Diffex URL.
Generated build output remains untracked and is not included in the PR.

## Cleanup and limits

The run verified byte-preserving repeated publication, failed npm verification before and after publication, conditional advancement, older-announcement rejection, and interrupted-publication recovery.
Cleanup verified these exact keys absent before releasing the lock:

- `releases/v1/latest.json`
- `releases/v1/releases/0.1789086098745.0.json`
- `releases/v1/releases/0.1789086098745.1.json`
- `verification/release-publication.lock`

The final staging latest response was HTTP 404 `no_published_release`, and readiness was HTTP 200 with `release: "missing"`.
No production object, route, DNS record, Worker, Render service, landing application, npm package, or GitHub Release was changed.
The opt-in workflow input becomes dispatchable after the workflow reaches the default branch; this evidence comes from running the checked-in command locally.
These are source CLI canaries with intercepted installation, not acceptance of an installed published client or public binary distribution.
Production activation and real installation remain separately authorized release work.
