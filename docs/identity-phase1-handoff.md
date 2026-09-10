# Phase 1 identity handoff

Status: phase 1 complete within the owner-approved scope below.
Distribution and backend cutover remain later-phase work.
The source migration is based on `4d5859e71143d3c1ba29fa7df4e2068087ba2322`.

## Confirmed identities

| Identity | Final value |
|---|---|
| GitHub repository | `diffexai/diffex` |
| Repository URL | `https://github.com/diffexai/diffex` |
| npm scope | `@diffexai` |
| CLI package | `@diffexai/diffex` |
| CLI executable | `diffex` |
| Runtime image | `ghcr.io/diffexai/diffex-runtime` |
| Product author | DiffexAI |
| Legal copyright owner | Luntraa, Inc. |
| Website | `https://diffex.ai/`, verified in GitHub organization metadata |
| Diffex API/Radius hostnames | None, confirmed by owner |
| OAuth application names | None, confirmed by owner |

Diffex and Luntraa, Inc. are unrelated to Earendil.
The incorrect affiliation announcement, hidden command, component, and exclusive image were removed.

The package migration changes only the scope except for the coding-agent CLI.
The CLI uses the short package name shown below.
Private packages retain their existing suffixes under the new scope.

| Workspace | Final package | Publication |
|---|---|---|
| `packages/agent` | `@diffexai/diffex-agent-core` | Public, phase 3 |
| `packages/ai` | `@diffexai/diffex-ai` | Public, phase 3 |
| `packages/client` | `@diffexai/diffex-client` | Public, phase 3 |
| `packages/coding-agent` | `@diffexai/diffex` | Public, phase 3 |
| `packages/coding-agent-server` | `@diffexai/diffex-coding-agent-server` | Public, phase 3 |
| `packages/harness-state` | `@diffexai/diffex-harness-state` | Public, phase 3 |
| `packages/protocol` | `@diffexai/diffex-protocol` | Public, phase 3 |
| `packages/server` | `@diffexai/diffex-server` | Public, phase 3 |
| `packages/session-backends/sqlite-node` | `@diffexai/diffex-session-backend-sqlite-node` | Public, phase 3 |
| `packages/telemetry` | `@diffexai/diffex-telemetry` | Public, phase 3 |
| `packages/tui` | `@diffexai/diffex-tui` | Public, phase 3 |
| `packages/evals` | `@diffexai/diffex-evals` | Private |
| `packages/evolution` | `@diffexai/diffex-evolution` | Private |
| `packages/harness-trace` | `@diffexai/diffex-harness-trace` | Private |
| `packages/coding-agent/install-lock` | `@diffexai/diffex-coding-agent-install` | Generated private installer |

## Operational evidence

Read-only checks on 2026-09-10 UTC established the following state.
The authenticated GitHub principal is `Pepps233`, with active organization-admin membership and repository-admin permission.
Both local origin URLs use `https://github.com/diffexai/diffex.git`.
The default branch is `main`; no repository transfer is needed.
Pages is disabled, and the repository has no webhooks or deploy keys.
The organization has no staff teams, and organization-wide two-factor authentication is not required.
The API lists no members or outside collaborators with two-factor authentication disabled.
The only repository environment is `diffex-model-upload`; it contains no secrets.
There are no repository Actions secrets.
Organization-secret inventory returned HTTP 403 and was subsequently skipped by owner instruction.
Ruleset inspection returned HTTP 403 because this private repository's plan does not support the feature.
The organization-installation API lists `chatgpt-codex-connector` and `render`, both with selected-repository access.
Their selected repository lists and downstream deployment configuration were not verified; production inventory is an owner-approved skip.
The `main` branch is unprotected.
The private-vulnerability-reporting endpoint returned HTTP 404, so that reporting channel is not verified.
The organization lists `hello@diffex.ai` as its public email, but this does not verify a security mailbox or delivery.
All eleven public package names returned HTTP 404 from the npm registry.
The initial local npm authentication check returned HTTP 401.
The owner subsequently confirmed all npm requirements are verified and instructed us to skip npm login and further ownership/2FA checks.
This is owner-provided verification, not a successful local account check.

## Publication hold and consumer inventory

`.github/workflows/runtime-image.yml` has an unconditional false job condition that also blocks manual dispatch.
Keep it disabled through phase 1 and phase 2.
`Dockerfile.runtime` already labels the canonical repository and uses Node 24 for both stages.
`docs/cloud-runtime.md` identifies the target image and the `DAYTONA_SANDBOX_SNAPSHOT` consumer setting.
No production image digest or snapshot value is stored in this repository.
The owner instructed us to skip production image, Daytona snapshot, credential, and deployment-allowlist inventory.
Do not change those consumers in phase 1.

Phase 3 configures the trusted publisher for every public package with repository `diffexai/diffex`, workflow `build-binaries.yml`, environment `npm-publish`, and action `npm publish`.
Do not bootstrap packages, configure publication credentials, publish npm packages, create release assets, publish GHCR images, or activate self-update in this phase.

## Owner-approved scope adjustments

These decisions were recorded in `/Users/jialeyu/Projects/temp/release/earendil-works-to-diffexai-diffex.md` on 2026-09-09 local time.
Diffex will not be an open source project.
The following exceptions supersede the original plan's operational gates.

| Step | Final disposition |
|---|---|
| 1, 15 | No API/Radius hostnames or OAuth application names exist; security/support identities skipped |
| 2 | npm requirements verified by owner; no npm login; security mailbox and staff team/member provisioning skipped |
| 3 | Organization-secret inventory skipped; security-reporting and production integration checks deferred |
| 4 | Staff authorization/team/token migration and its tests skipped; existing workflow unchanged |
| 11 | Production inventory skipped; image publication remains disabled |
| 12 | Announcement removal approved and implemented; security/support contact work skipped |
| 13 | Exact retained security/staff references classified as owner-approved skips; other residuals reviewed separately |
| 15 | Confirmed names and explicit absent/skipped identities recorded in this handoff |

`SECURITY.md` and `.github/workflows/issue-analysis.yml` retain inherited operational references under these explicit skips.
Those references do not establish a relationship between Diffex or Luntraa and Earendil.
Their exact occurrences and retirement conditions appear in `identity-residual-allowlist.md`.

## Local verification

`npm run check` and `npm run build:offline` passed after the package migration.
All eleven public workspaces passed `npm pack --dry-run --ignore-scripts`, local packing, and scans for stale active package identities in tarballs.
Historical changelogs were excluded from the active-package scan and are individually recorded in `identity-residual-allowlist.md`.
Lockfiles were regenerated with Node 24.13.0 and npm 11.15.0, followed by the repository shrinkwrap and installer-lock generators.
Using npm 10 would drop libc metadata, so use the documented newer npm toolchain for regeneration.
The initial non-E2E run encountered sandbox denials for loopback and Unix sockets.
The complete `./test.sh` run passed after granting the local socket access required by its mock servers.
The source archive passed its embedded model-data validation.
The exact verified source revision and archive checksums are recorded in `identity-residual-allowlist.md`.
Generated declarations, the source archive, and the macOS standalone archive passed stale active-package identity scans.
The standalone binary returned version `0.2.0` and displayed help when launched from `/tmp` with an isolated agent directory and offline mode.
Exact artifact residuals and their byte offsets are recorded in `identity-residual-allowlist.md`.
The local Docker daemon is not running, so no container build or effective-image-label inspection was performed.
After announcement removal, `npm run check`, all five remaining secondary-dialog tests, and a clean offline build passed.
An isolated offline TUI reproduced the announcement before removal and verified that the old command no longer displays it afterward.
All eleven npm packs, generated declarations, the source archive, and the standalone archive were regenerated and rescanned after removal.
