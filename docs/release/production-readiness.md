# Production release readiness

Status: blocked, verified on 2026-09-11 UTC.
No production release was published during this inspection.
This record supports the requested release activation and does not certify release or installation acceptance.

## Candidate and public state

The candidate is `c18b433f7c2e4993f711001defa1361b1cd835d2` from [PR #205](https://github.com/diffexai/diffex/pull/205).
It is 14 commits ahead of, and zero commits behind, `main` at `4d5859e71143d3c1ba29fa7df4e2068087ba2322`.
All 11 public workspace manifests declare `0.2.0`; this is a source version, not a published release.

Anonymous registry GETs returned HTTP 404 for every public package:

- `@diffexai/diffex`
- `@diffexai/diffex-agent-core`
- `@diffexai/diffex-ai`
- `@diffexai/diffex-client`
- `@diffexai/diffex-coding-agent-server`
- `@diffexai/diffex-harness-state`
- `@diffexai/diffex-protocol`
- `@diffexai/diffex-server`
- `@diffexai/diffex-session-backend-sqlite-node`
- `@diffexai/diffex-telemetry`
- `@diffexai/diffex-tui`

The inventory came from `getPublicWorkspacePackages()` in `scripts/release-packages.mjs`, using `https://registry.npmjs.org/<encoded-package-name>` without credentials, with redirects rejected and a 15-second request timeout.
`npm view @diffexai/diffex version dist.tarball --json` independently returned E404.
GitHub reported no tags, no releases, and no Build Binaries runs.
Its environment inventory contained `diffex-model-upload`, `diffex-release-staging`, and `diffex-release-upload`, but no `npm-publish` environment.
No npm publisher relationship could be verified for these absent public packages.

The anonymous production request returned HTTP 404 with exactly `{"error":"no_published_release"}`, JSON content type, `Cache-Control: no-store`, and request ID `356c6077-b2c6-497e-8768-a1e3ef664066`.
The cloud production probe also verified Render readiness at HTTP 200 and anonymous `/v1/auth/session` rejection at HTTP 401.
No production R2 credentials were read and neither production record was downloaded; the missing-release observation is from HTTP, not an independent storage inventory.

## Release blockers

The release process requires a clean `main` containing the intended changes, a completed changelog audit, local Node and Bun smoke acceptance, registered packages, and configured trusted publishers.
The current candidate remains on the stacked PR branch.
The owner confirmed that the changelog audit has not been completed.
The existing release script does not itself enforce `main` or equality with `origin/main`, so invoking it on this branch would not satisfy those requirements.

The backend migration prerequisites remain unmet in this candidate:

- `packages/coding-agent/src/core/remote-catalog-provider.ts` still defaults to `https://pi.dev` and restores stored overlays without recording their source authority.
- `packages/ai/src/providers/radius-config.ts` still defaults to `https://radius.pi.dev`.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` still sends the install report to `https://pi.dev/api/report-install`; `SettingsManager.getEnableInstallTelemetry()` defaults to `true`.
- The OpenAI Codex and xAI OAuth modules retain Pi attribution; approval of replacement application identities has not been established.

The migration analysis requires replacements or deliberate disablement before general publication.
The owner deferred those dependency changes to later work, so publication remains blocked on their completion.
Changing only release discovery does not satisfy that prerequisite.
The [staging canaries](client-canaries.md) intercepted installation and unrelated network traffic; they do not substitute for clean installed-artifact acceptance.
The local release helper also lists only ten packages and omits the public coding-agent server, while CI publishes all eleven.
The inherited release audit's legal payload, public binary distribution, and artifact identity requirements need closure before claiming broader distribution acceptance.

## Publication handoff

Resolve the backend and artifact prerequisites and review the resulting candidate before any public npm bootstrap.
Bootstrap is public publication even when its dist-tag is not `latest`.
Follow [RELEASING.md](../../RELEASING.md) to register the reviewed package set and configure each trusted publisher with repository `diffexai/diffex`, workflow `build-binaries.yml`, and environment `npm-publish`.
Verify the publisher relationships and environment protection without copying npm or R2 credentials into source, clients, or evidence.

After the reviewed changes reach `main`, confirm its remote identity, the changelog audit, the complete local smoke results, and the chosen lockstep release version.
Run the normal release command once.
After the tag push, inspect the Build Binaries workflow and recover failed jobs using the [publication runbook](publication.md); do not rerun the release script for the same release.
No Worker, Render, or landing deployment is needed to advance the endpoint.

Retain the following evidence before declaring activation complete:

| Evidence | Required comparison |
| --- | --- |
| Release source | Tag commit, reviewed candidate, and actual checkout commits used by build, npm publication, and announcement agree. |
| Workflow | All required publication jobs succeed; retain the run URL and conclusion. |
| npm | Every public workspace resolves at the release version with matching package identity, tarball URL, and integrity metadata; verify each tarball is available. |
| R2 | Read `releases/v1/releases/<version>.json` and `releases/v1/latest.json` through approved operator access; validate the contract and compare their bytes for this activation. |
| Record provenance | `sourceCommit` equals the release source and the complete package set matches the source inventory and npm metadata. |
| Public endpoint | Anonymous GET returns HTTP 200, exact version and canonical package, JSON, and `Cache-Control: no-store`, without redirects or challenges. |
| Existing API | The cloud production probe continues to pass Render readiness and auth rejection. |

A later concurrent release can legitimately advance `latest`; record that race and compare the endpoint with the actual current latest record rather than lowering the pointer.
The release marker establishes npm verification, not public availability of binary assets.

## Installation handoff for existing users

There is currently no published migrated package to install.
After the evidence above identifies a real published release, provide its exact version in Diffex-owned release instructions.
Users whose installed client still targets Pi must install the canonical package directly rather than use that client's self-updater.
For an existing npm installation, use the verified version in place of the placeholder:

```sh
npm install --global --ignore-scripts @diffexai/diffex@<verified-version>
npm ls --global @diffexai/diffex --depth=0
diffex --version
```

The placeholder is intentionally not an executable release claim.
Do not replace it with the unverified source version or npm's `latest` tag.
Ensure the executable on `PATH` belongs to the installation being checked.
Do not uninstall another package automatically as part of this bootstrap instruction.
The migrated client's subsequent self-update path uses only Diffex release discovery and the canonical local package identity.

Standalone binary users need independently verified public assets and upgrade instructions before binary acceptance can be claimed.
Real installation, already-current behavior, and a subsequent published older-to-newer update remain outstanding.
No npm install, package publication, release tag, production storage mutation, or deployment occurred during this inspection.
