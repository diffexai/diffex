# Phase 1 identity handoff

Status: incomplete pending operational provisioning, final contact/backend identities, and announcement approval.
Do not begin distribution cutover from this document until the open gates below are closed.
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
Organization-secret inventory requires an additional `admin:org` token scope and returned HTTP 403.
Ruleset inspection returned HTTP 403 because this private repository's plan does not support the feature.
The organization-installation API lists `chatgpt-codex-connector` and `render`, both with selected-repository access.
Their selected repository lists and downstream deployment configuration remain unverified.
The `main` branch is unprotected.
The private-vulnerability-reporting endpoint returned HTTP 404, so that reporting channel is not verified.
The organization lists `hello@diffex.ai` as its public email, but this does not verify a security mailbox or delivery.
All eleven public package names returned HTTP 404 from the npm registry.
The local npm authentication check returned HTTP 401, so npm organization ownership and two-factor authentication remain unverified.
Browser discovery returned no connected browsers, so an existing npm web session could not be checked.

## Publication hold and consumer inventory

`.github/workflows/runtime-image.yml` has an unconditional false job condition that also blocks manual dispatch.
Keep it disabled through phase 1 and phase 2.
`Dockerfile.runtime` already labels the canonical repository and uses Node 24 for both stages.
`docs/cloud-runtime.md` identifies the target image and the `DAYTONA_SANDBOX_SNAPSHOT` consumer setting.
No production image digest or snapshot value is stored in this repository.
Daytona registry credentials, snapshot inventory, deployment allowlists, and the currently tested production digest require operator evidence.
Do not change those consumers in phase 1.

Phase 3 configures the trusted publisher for every public package with repository `diffexai/diffex`, workflow `build-binaries.yml`, environment `npm-publish`, and action `npm publish`.
Do not bootstrap packages, configure publication credentials, publish npm packages, create release assets, publish GHCR images, or activate self-update in this phase.

## Open gates

| Step | Required evidence or decision |
|---|---|
| 1, 15 | Final security mailbox, staff team/token name, support identity, API/Radius hostnames, and OAuth identity names |
| 2 | npm organization control, owners and 2FA; provisioned security mailbox and staff team; organization 2FA policy |
| 3 | Organization-secret names and owners, App repository selections, security-reporting configuration, and remaining integrations |
| 4 | Approved staff authorization endpoint and token, provisioned non-publication integrations, positive and negative authorization tests |
| 11 | Operator inventory of the current production image, Daytona snapshot, credentials, and deployment allowlists |
| 12 | Approval to replace or remove the intentional company announcement; verified security contact |
| 13 | Resolve the active findings in `identity-residual-allowlist.md` and repeat final source/artifact scans |
| 15 | Close all open gates and provide the final operational identifiers to phase 2 |

## Local verification

`npm run check` and `npm run build:offline` passed after the package migration.
All eleven public workspaces passed `npm pack --dry-run --ignore-scripts`, local packing, and scans for stale active package identities in tarballs.
Historical changelogs were excluded from the active-package scan and are individually recorded in `identity-residual-allowlist.md`.
Lockfiles were regenerated with Node 24.13.0 and npm 11.15.0, followed by the repository shrinkwrap and installer-lock generators.
Using npm 10 would drop libc metadata, so use the documented newer npm toolchain for regeneration.
The initial non-E2E run encountered sandbox denials for loopback and Unix sockets.
The complete `./test.sh` run passed after granting the local socket access required by its mock servers.
The source archive was created from commit `76eef7af0` and passed its embedded model-data validation.
Generated declarations, the source archive, and the macOS standalone archive passed stale active-package identity scans.
The standalone binary returned version `0.2.0` and displayed help when launched from `/tmp` with an isolated agent directory and offline mode.
Exact artifact residuals and their byte offsets are recorded in `identity-residual-allowlist.md`.
The local Docker daemon is not running, so no container build or effective-image-label inspection was performed.
