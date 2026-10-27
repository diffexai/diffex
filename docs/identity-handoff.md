# Product identity handoff

The current Diffex identities and package map are recorded below.
The [candidate handoff](release/candidate-handoff.md) preserves historical acceptance evidence; its service and attribution approvals are superseded by current policy.
The canonical source remains private.
No package, image, release asset, or source archive is published by this change.

| Identity                    | Accepted value                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Source repository           | `diffexai/diffex`                                                                                              |
| npm scope and canonical CLI | `@diffexai`, `@diffexai/diffex`                                                                                |
| Executable                  | `diffex`                                                                                                       |
| Hosted runtime image        | `ghcr.io/diffexai/diffex-runtime`                                                                              |
| Product author and website  | DiffexAI, `https://diffex.ai/`                                                                                 |
| Legal copyright owner       | Luntraa, Inc.                                                                                                  |
| Release API                 | `https://api.diffex.ai/api/latest-version`, owned by `diffex-cloud`                                            |
| Model catalog API | `https://api.diffex.ai/api/models/providers/{providerId}`, owned by `diffex-cloud` |
| Radius services | Removed; prohibited in development, testing, evaluation, and production |
| Security contact            | Existing private access to a Diffex repository owner; no dedicated mailbox or public reporting channel claimed |
| Issue authorization         | Write/admin permission on the current Diffex repository                                                        |

Diffex and Luntraa, Inc. are unrelated to Earendil.
The former staff-team authorization, security mailbox reference, announcement, and product affiliation wording have been removed.
Provider attribution now identifies Diffex; see [provider validation](release/provider-branding-validation.md).
ChatGPT now registers Diffex and uses public model and inference APIs; existing inherited registrations require a new sign-in as described in [provider setup](../packages/coding-agent/docs/providers.md#chatgpt).
The xAI subscription integration remains available with Diffex attribution.
Radius is removed; the older release audit does not authorize its use.
See [migration and validation](release/radius-removal.md).
The catalog authority is now Diffex; see [the catalog contract](model-catalog.md).
The exact residual inventory is [identity-residual-allowlist.md](../identity-residual-allowlist.md).

| Workspace                               | Final package                                  | Publication                  |
| --------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `packages/agent`                        | `@diffexai/diffex-agent-core`                  | Private internal workspace |
| `packages/ai`                           | `@diffexai/diffex-ai`                          | Private internal workspace |
| `packages/client`                       | `@diffexai/diffex-client`                      | Private internal workspace |
| `packages/coding-agent`                 | `@diffexai/diffex`                             | Public CLI |
| `packages/coding-agent-server`          | `@diffexai/diffex-coding-agent-server`         | Private internal workspace |
| `packages/harness-state`                | `@diffexai/diffex-harness-state`               | Private internal workspace |
| `packages/protocol`                     | `@diffexai/diffex-protocol`                    | Private internal workspace |
| `packages/server`                       | `@diffexai/diffex-server`                      | Private internal workspace |
| `packages/session-backends/sqlite-node` | `@diffexai/diffex-session-backend-sqlite-node` | Private internal workspace |
| `packages/telemetry`                    | `@diffexai/diffex-telemetry`                   | Private internal workspace |
| `packages/tui`                          | `@diffexai/diffex-tui`                         | Private internal workspace |
| `packages/evals`                        | `@diffexai/diffex-evals`                       | Private                      |
| `packages/evolution`                    | `@diffexai/diffex-evolution`                   | Private                      |
| `packages/harness-trace`                | `@diffexai/diffex-harness-trace`               | Private                      |
| `packages/coding-agent/install-lock`    | `@diffexai/diffex-coding-agent-install`        | Generated private installer  |

The public package inventory is derived from `scripts/release-packages.mjs`.
Only `@diffexai/diffex` is public; required internal runtime modules are bundled into its tarball under the [distribution policy](release/distribution-policy.json).
The generated installer package remains private and is not an additional publication target.
`@diffexai/diffex-coding-agent` is not a supported package identity.

Runtime image publication remains disabled pending separate deployment-consumer acceptance.
Public bootstrap, trusted publishing, distribution notices, asset hosting, and installed-client release acceptance remain separate work.
The owner previously verified npm account prerequisites; this implementation does not repeat npm login or ownership checks.
