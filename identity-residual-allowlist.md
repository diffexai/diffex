# Reviewed runtime identity residuals

Review date: 2026-10-27.
This inventory reflects the current Diffex source, superseding the 2026-09-11 integration approvals.
No service, OAuth registration, application attribution, security/staff, Gondolin, disabled-code, or legacy package alias exceptions remain.

`scripts/runtime-identity-allowlist.json` is the executable review record.
It binds every occurrence to an exact file and full source line, including duplicate occurrences on the same line.
The checker rejects new occurrences, altered contexts, stale entries, and categories other than approved integrations or legal notices.
Run `npm run check:identities`; the root quality gate runs it automatically.
The full source context in the JSON record is authoritative when line numbers move.

| Source location | Identity matches | Category | Reviewed reason |
| --- | --- | --- | --- |
| `packages/coding-agent/examples/extensions/doom-overlay/README.md` | `pi-doom, pi-doom` | legal notice | Preserves the original integration credit for the redistributed DOOM overlay source. |

The only executable allowlist entry is the source credit above, with two matches on one line.
Provider attribution uses Diffex defaults; see [provider validation](docs/release/provider-branding-validation.md).
ChatGPT uses Diffex account registration and the public model and inference APIs; see [provider setup](packages/coding-agent/docs/providers.md#chatgpt).
The inherited ChatGPT registration requires a new sign-in.
Radius is removed and prohibited in every environment; see [migration and validation](docs/release/radius-removal.md).
Model catalogs use the Diffex-owned API described in [the catalog contract](docs/model-catalog.md); the former catalog exceptions are removed.
No historical approval authorizes install reporting, upstream update authority, or service traffic.
The source check covers tracked and unignored package source, examples, configuration, workflow files, operational extensions, dependency metadata, and root identity documents.
Tests and their fixtures describe rejected historical inputs and are not shipped runtime configuration.
Released `CHANGELOG.md` records remain untouched under repository policy; their historical package and upstream issue references are not current product identities or runtime permissions.
The handoff and review documents discuss historical names without authorizing them in executable code.

## Historical evidence and external references

The release records [candidate-artifacts.json](docs/release/candidate-artifacts.json), [candidate-identity-review.json](docs/release/candidate-identity-review.json), and [candidate-rehearsal.json](docs/release/candidate-rehearsal.json) preserve the exact artifacts, source contexts, URLs, and headers reviewed at their pinned revisions.
Their approval labels describe those historical reviews, not current permissions or acceptance of those bytes as a release candidate.
Do not rewrite their recorded identities or checksums to match current source.
The [candidate handoff](docs/release/candidate-handoff.md) and [rehearsal](docs/release/candidate-rehearsal.md) distinguish that evidence from current policy.

The coding-agent README's MCP article and Anthropic implementation comments' research links are external technical references.
They do not name the application or configure service defaults.
Historical package names and URLs in fixtures and security rejection patterns remain necessary to verify that removed identities cannot return.
`@mariozechner/clipboard` is an external dependency whose accurate package name remains in dependency metadata, imports, and build scripts.
None of these references adds an executable allowlist exception.

`LICENSE` retains the Pi Agent Harness MIT notice, Mario Zechner copyright, and Luntraa, Inc. copyright.
The root README and DOOM overlay credit preserve source attribution for redistributed upstream code.
No license or copyright ownership was changed.
Distribution-specific notice completeness is separate release work.

The candidate handoff records historical artifact checksums, validation commands, deployment records, and the owner-requested live-provider skip.
