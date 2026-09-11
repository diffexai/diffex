# Reviewed runtime identity residuals

Review date: 2026-09-11.
This replaces the obsolete source and artifact inventory from the earlier identity migration.
No security/staff, Gondolin, disabled-code, or legacy package alias exceptions remain.

`scripts/runtime-identity-allowlist.json` is the executable review record.
It binds every occurrence to an exact file and full source line, including duplicate occurrences on the same line.
The checker rejects new occurrences, altered contexts, stale entries, and categories other than approved integrations or legal notices.
Run `npm run check:identities`; the root quality gate runs it automatically.
Paths below are descriptive coordinates; the full source context is authoritative when line numbers move.

| Exact source location                                                 | Identity matches   | Category             | Reviewed reason                                                                                      |
| --------------------------------------------------------------------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `README.md:29`                                                        | `earendil-works`   | legal notice         | Preserves upstream source attribution alongside the unchanged MIT notice in LICENSE.                 |
| `packages/ai/src/api/openai-codex-responses.ts:1608`                  | `pi`               | approved integration | OpenAI Codex OAuth and required provider attribution explicitly retained by the owner on 2026-09-11. |
| `packages/ai/src/api/openai-codex-responses.ts:1609`                  | `pi, pi`           | approved integration | OpenAI Codex OAuth and required provider attribution explicitly retained by the owner on 2026-09-11. |
| `packages/ai/src/auth/oauth/openai-codex.ts:294`                      | `pi`               | approved integration | OpenAI Codex OAuth explicitly retained by the owner on 2026-09-11.                                   |
| `packages/ai/src/auth/oauth/radius.ts:33`                             | `pi-gateway`       | approved integration | Radius gateway OAuth client retained by the release audit.                                           |
| `packages/ai/src/auth/oauth/xai.ts:151`                               | `pi`               | approved integration | xAI OAuth explicitly retained by the owner on 2026-09-11.                                            |
| `packages/ai/src/providers/radius-config.ts:4`                        | `radius.pi.dev`    | approved integration | Default Radius gateway retained by the release audit.                                                |
| `packages/coding-agent/examples/extensions/doom-overlay/README.md:46` | `pi-doom, pi-doom` | legal notice         | Preserves the original integration credit for the redistributed DOOM overlay source.                 |
| `packages/coding-agent/src/core/provider-attribution.ts:50`           | `pi.dev`           | approved integration | Provider attribution retained by the release audit; optional headers default off.                    |
| `packages/coding-agent/src/core/provider-attribution.ts:51`           | `pi`               | approved integration | Provider attribution retained by the release audit; optional headers default off.                    |
| `packages/coding-agent/src/core/provider-attribution.ts:58`           | `Pi`               | approved integration | Provider attribution retained by the release audit; optional headers default off.                    |
| `packages/coding-agent/src/core/provider-attribution.ts:64`           | `pi-coding-agent`  | approved integration | Provider attribution retained by the release audit; optional headers default off.                    |
| `packages/coding-agent/src/core/provider-attribution.ts:80`           | `pi`               | approved integration | OpenCode session/client attribution retained independently of the optional attribution toggle.       |
| `packages/coding-agent/src/core/remote-catalog-provider.ts:6`         | `pi.dev`           | approved integration | Pi-supported model catalogs retained by the release audit.                                           |
| `packages/coding-agent/src/core/remote-catalog-provider.ts:44`        | `pi.dev`           | approved integration | Pi-supported model catalogs retained by the release audit.                                           |

The owner explicitly approved retention of OpenAI Codex and xAI OAuth during this implementation.
The release audit approves Radius gateway/OAuth, Pi-supported model catalogs, and provider attribution.
These entries permit those integrations only; they do not authorize install reporting, update authority, arbitrary traffic to the same host, or new dependencies.
The source check covers tracked and unignored package source, examples, configuration, workflow files, operational extensions, dependency metadata, and root identity documents.
Tests and their fixtures describe rejected historical inputs and are not shipped runtime configuration.
Released `CHANGELOG.md` records remain untouched under repository policy; their historical package and upstream issue references are not current product identities or runtime permissions.
The handoff and review documents discuss historical names without authorizing them in executable code.

`LICENSE` retains the Pi Agent Harness MIT notice, Mario Zechner copyright, and Luntraa, Inc. copyright.
The root README and DOOM overlay credit preserve source attribution for redistributed upstream code.
No license or copyright ownership was changed.
Distribution-specific notice completeness is separate release work.

The candidate handoff records artifact checksums, retained integration behavior, validation commands, deployment records, and the owner-requested live-provider skip.
