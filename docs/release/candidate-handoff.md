# Release candidate identity and backend acceptance

This handoff reconciles the identity migration and backend exposure plans with the candidate on 2026-09-11.
The implementation is based on CLI `b45656e880071eaa5c4792951c44fee19e3e493a`, PR #207.
The accepted implementation is [`33704b32c5d17b849c013834fd1c56d65de843fd`](https://github.com/diffexai/diffex/commit/33704b32c5d17b849c013834fd1c56d65de843fd).
The follow-up evidence commit changes only documents; [the artifact manifest](candidate-artifacts.json) pins the tested implementation and bytes.
The companion cloud change is stacked on PR #147.

## Reconciled decisions

The canonical private source, package map, executable, hosted image identity, and Luntraa, Inc. copyright are recorded in [the identity handoff](../identity-handoff.md).
The release audit approves Pi-supported catalogs, Radius gateway/OAuth, and provider attribution.
The owner additionally instructed this implementation to retain OpenAI Codex and xAI OAuth.
The earlier backend plan's proposed replacement catalogs, Diffex Radius service, and replacement provider registrations are therefore not prerequisites for this candidate.
No Diffex ownership of those external services or registrations is asserted.

The obsolete security/staff exceptions are removed.
Issue analysis authorizes against repository write/admin permission and fails closed on insufficient permission or GitHub errors.
The inherited organization token, staff endpoint, security mailbox, and ownership wording are absent.
Gondolin and its native runners are removed from the example payload, workspace graph, and generated lockfile.
Legacy extension-package aliases, the old theme symbol, and upstream session-sharing guidance are removed.
Extensions must import canonical `@diffexai` packages; wrappers embedding exported HTML must use the new Diffex metadata keys.
Previously saved sidebar widths under the old local-storage key are not migrated.
Export HTML metadata uses Diffex names.
Historical changelog links now retain their original upstream destination instead of being attributed to Diffex issues.
Released changelog files and upstream legal notices are unchanged.

Install reporting remains removed.
The updater still accepts only canonical stable versions for `@diffexai/diffex`, pins installation to the verified version, and treats the no-release response as no update.
The [exact residual inventory](../../identity-residual-allowlist.md) replaces the obsolete exceptions and is enforced by `npm run check:identities`.

## Endpoint ownership and allowed egress

| Operation                             | Endpoint or authority                                                                                                   | Policy                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Release discovery                     | `https://api.diffex.ai/api/latest-version`                                                                              | Diffex Cloud public Worker; anonymous; fixed canonical package identity; no redirects                                   |
| Diffex account login and product APIs | `https://api.diffex.ai`, existing Render/WorkOS routes                                                                  | Separate account credentials; never implicitly reused as Radius credentials                                             |
| Built-in catalog refresh              | `https://pi.dev/api/models/providers/<provider>`                                                                        | Explicitly retained external catalogs for configured providers                                                          |
| Radius config and inference           | `https://radius.pi.dev/v1/config`, gateway-selected message base URL                                                    | Explicitly retained Radius trust boundary; provider credentials only                                                    |
| Radius OAuth                          | Gateway `/v1/oauth` discovery and discovered authorization/device/token URLs; client `pi-gateway`                       | Retained registration; the earlier audit observed issuer `https://radius.earendil.com`; live discovery was not repeated |
| OpenAI Codex                          | `https://auth.openai.com`, `https://chatgpt.com/backend-api`; client `app_EMoamEEZ73f0CkXaXp7hrann`                     | Explicit owner retention of OAuth and provider attribution                                                              |
| xAI subscription                      | `https://auth.x.ai/oauth2/device/code`, `https://auth.x.ai/oauth2/token`; client `b1a00492-073a-47ea-816f-4c329264a828` | Explicit owner retention of OAuth and provider attribution                                                              |
| Other model providers                 | Selected built-in provider endpoints or explicitly configured custom endpoints                                          | Provider-specific credentials and model traffic                                                                         |
| Optional attribution                  | OpenRouter, NVIDIA NIM, Cloudflare                                                                                      | Existing optional provider headers; default off; separate from removed install reporting                                |
| OpenCode attribution                  | Selected OpenCode endpoint                                                                                              | Existing client/session headers retained independently of optional attribution                                          |

Radius discovery and model configurations remain trusted inputs that can supply endpoint URLs.
Retaining them accepts that existing trust boundary; this change does not implement the older plan's endpoint allowlisting or cache-origin migration proposal.
Custom gateways remain explicit user configuration.
No runtime egress permission extends to install-report routes, upstream update discovery, security reporting to upstream contacts, or external organization authorization.
GitHub access remains available for explicitly requested extension/package operations and source-host operations.

## Catalog and provider policy

The frozen built-in catalog was generated at `2026-08-25T03:02:44.635Z` with structure hash `888155e376e18c5eb02a88c79c374edaa9a517730bfe17f82f76ca51c96cca12`.
The local build validates and uses that checked-in snapshot without refreshing model metadata.
`packages/ai/src/providers/data/.manifest.json` records every provider shard digest.
The static provider IDs in that manifest, plus dynamic `radius`, remain supported by the source adapters.
The installed artifact manifest lists all 40 provider IDs and display names; listing a provider does not claim live authentication or inference acceptance.

Configured built-in providers retain the external overlay and its four-hour refresh interval.
Newer remote models override same-ID built-ins; cached bodies support ETag `304` responses.
Older or undated overlays do not override the frozen built-in generation timestamp.
Unavailable `404`/`501` overlays and transient errors preserve the documented built-in/cache fallback.
Offline mode suppresses startup management traffic; it is not a network sandbox for explicit user-requested inference or arbitrary extensions.

## Cloud revision and routing evidence

The companion [cloud handoff](https://github.com/diffexai/diffex-cloud/blob/chore/release-candidate-handoff/docs/release-candidate-handoff.md) retains deployment provenance and an anonymous production probe.
Production activation source is `d6232aee52f8056d9a72c93e56313b298521780a`, Worker version `51b928ad-08c5-4523-a9f5-96bc85c49d29`, deployment `4b1a02e9-03d8-41ff-a2c5-cb054db3e162`, workflow run `34551833957`.
The last recorded restored staging version is `1055f9cc-c142-452c-9fd2-500849b43c6d`, deployment `2f3ea9c7-cd09-4e89-9ef9-5104d83c5505`, from source `a88c1ba3fc17eea90d2dfe7adee066ea0353d681`.
These are existing deployment records, not a new authenticated inventory.
The fresh public probe returned exact `404 no_published_release`, `200` Render readiness, and `401` anonymous auth rejection.
No deployment or production metadata mutation was needed.

## Validation and explicit exclusions

The full `./test.sh` suite passed without provider credentials.
This includes the retained Radius, OpenAI Codex, xAI, remote catalog, provider-attribution, install-report removal, and updater regressions.
The new issue-workflow tests first reproduced rejection of Diffex maintainers because an inherited token was absent, then passed after repository-scoped authorization replaced it.
The CLI quality gate and exact identity scan passed.
The cloud/CLI contract checker passed with no public contract changes.

All eleven local workspace tarballs installed together outside the repository using local file overrides and lifecycle scripts disabled.
Node and macOS arm64 Bun artifacts passed help, version, model listing, controlled print inference, interactive prompt/reply, account-menu display, and clean exit.
The controlled startup request log contains only `https://api.diffex.ai/api/latest-version`, returning the no-release response.
No network connections or real provider calls are permitted by the artifact fixture once loaded.
The fixture is a test extension and is not shipped or activated in production.

Prepare fresh artifacts after the offline build, then repeat the terminal acceptance and scan:

```sh
npm run build:offline
node scripts/prepare-candidate-artifacts.mjs /tmp/diffex-candidate-handoff
./scripts/build-binaries.sh --skip-install --skip-deps --skip-build --platform darwin-arm64 --out /tmp/diffex-candidate-handoff/binaries
python3 scripts/verify-candidate-artifacts.py /tmp/diffex-candidate-handoff
node scripts/scan-candidate-artifacts.mjs /tmp/diffex-candidate-handoff
```

Use a fresh output directory for another run; the preparation script rejects an existing Node consumer to prevent reuse of cached same-version tarballs.
This was run on macOS 26.1 arm64 with Node 22.19.0, npm 10.9.3, Bun 1.3.11, and Python 3.13.
The complete offline workspace build passed, and the final CLI package was rebuilt after comment-only cleanup before packing.
All eleven local tarballs use version `0.2.0` and are fixture candidates, not public releases.
Their SHA-256 values, the standalone executable/archive hashes, provider inventory, exact commands, exit codes, and smoke results are retained in [candidate-artifacts.json](candidate-artifacts.json).

The [artifact identity review](candidate-identity-review.json) binds every match to an unpacked file hash, byte offset and context, or decoded source-map line.
It records 49 raw approved-integration/legal matches and 28 approved matches from decoded source maps.
Five additional lexical hits are identified separately: an XML processing-instruction error, three syntax-highlighting mathematical constants, and Jiti's bundled detection of an external Pi agent from PATH.
The detector neither names Diffex as Pi nor uses a Pi package, service, credential, or organization; it is third-party interoperability vocabulary rather than an inherited Diffex identity.
These contexts do not expand the runtime identity allowlist or authorize any new egress.
Immutable changelog files are hashed and counted separately under the instruction to preserve released history.
The scan covers the installed contents of all eleven Diffex packages and the complete unpacked native payload, including source maps, examples, and bundled code.
It is an explicit candidate review, not a distribution-notice or all-dependency supply-chain approval.

Repeat only the terminal acceptance against prepared artifacts with:

```sh
python3 scripts/verify-candidate-artifacts.py /tmp/diffex-candidate-handoff
```

Each run creates isolated home, configuration, project, cache, and event directories, then removes them and checks process exit.
The evidence directory retains only local artifacts and sanitized results.
No hosted session, sandbox, login, or remote fixture was created.

The owner explicitly requested skipping live login and inference acceptance.
Provider-boundary tests and the local controlled provider do not establish live provider acceptance.
Public package installation/update, public binary distribution, other native targets, signing, notice completeness, hosted image promotion, and scheduled monitoring remain separate release work.
No bootstrap package, general release, source archive, or hosted image was published.
