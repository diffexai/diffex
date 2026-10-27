# Candidate release rehearsal

This is historical evidence for the pinned revision below.
Its Radius-containing artifacts are superseded and must not be reused; see [Radius removal](radius-removal.md).

The rehearsal validates the approved npm-only distribution without publishing a release.
The current public inventory is `@diffexai/diffex`, with internal runtime modules bundled inside its tarball.
The older eleven-package and standalone acceptance requirements are superseded by the owner-approved [distribution policy](distribution-policy.json).
Standalone binaries, Windows npm acceptance, additional package managers, and hosted deployment remain deferred.
Real provider login and inference remain unavailable under the environment limits recorded in [artifact acceptance](artifact-acceptance.md).
Mock-provider prompt/reply and login-menu checks do not establish live provider acceptance.

## Candidate identity and retained evidence

The tested CLI source is `af5e64d09f95f5db28883421599769dbdf8bc796` and the coordinated cloud source is `4a87c4492804f68fea380debc43cafa86d0d1fa5`.
The subsequent workflow-only commit `16f94e40a8d6e73414c226e216891da62eed8332` restricts production credential checks to `main`; it changes no application, packaging, or fixture code.
Documentation commits retain these identities rather than relabeling previously tested artifacts.
The rehearsal version is `0.2.1`; these local bytes must never replace an existing npm version.
A production release requires its own reviewed version, immutable candidate, and publication acceptance.

| Evidence | Result and identity |
| --- | --- |
| Native package matrix | [Artifact Acceptance](https://github.com/diffexai/diffex/actions/runs/34784995881), with the same tarball on Linux x64/arm64 and Darwin x64/arm64. |
| Runtime process and image layers | [Runtime Image](https://github.com/diffexai/diffex/actions/runs/34784999538), Linux amd64, Node 24.16.0, external networking disabled. |
| Staging storage and Worker recovery | [Verify Release Publication](https://github.com/diffexai/diffex/actions/runs/34785182715), using the unchanged publisher and Worker contract from main. |
| Reproduced source-client failure | [Initial staging canary](https://github.com/diffexai/diffex/actions/runs/34784741853), with fixture cleanup verified after failure. |
| Branch environment rejection | [Blocked branch run](https://github.com/diffexai/diffex/actions/runs/34784991684), rejected before jobs could access either environment. |

The [machine-readable evidence](candidate-rehearsal.json) binds tarball and source-archive checksums, runtime image identity, native reports, local commands, identity review, and cleanup.
Private Actions artifacts retain the original commands, exit codes, terminal transcripts, smoke events, and manifests.
Native acceptance reports have ninety-day retention; candidate tarballs, frozen source, and runtime archives have fourteen-day retention.
Retain the original private bytes before that expiry when longer recovery evidence is required.
The local evidence bundle is `/tmp/diffex-candidate-rehearsal`; it includes the downloaded artifacts and complete local gate output.
No source archive, internal report, or runtime archive was uploaded to a public distribution surface.

## Installed package and runtime boundaries

Every advertised native target installs the reviewed CLI through npm 11.16.0 and Bun 1.3.11 with Node 22.19.0.
The local Darwin arm64 run additionally covers npm 10.9.3 and Bun 1.3.11 on macOS 26.1.
Both managers use fresh isolated consumers outside the repository and disable lifecycle scripts.
Diffex-scoped registry access cannot silently substitute an older public package for the local tarball.
The harness verifies installed runtime hashes, package exports, native clipboard loading, image WASM, HTML export resources, and controlled `fd`/`rg` helpers.
Version, help, models, a printed prompt/reply, a terminal prompt/reply, the supported account menu, and clean terminal exit are checked through the installed executable.

Real npm and Bun subprocesses install, upgrade, and uninstall the package.
The upgrade predecessor changes only isolated installed version metadata to `0.0.0`, with discovery and the canonical scoped registry supplied by controlled fixtures.
Malformed and foreign metadata, prereleases, redirects, outages, missing releases, and corrupted npm downloads are rejected under force.
An interrupted npm download is repaired using the exact pinned candidate, including recovery of a stale installation backup when required.
Uninstall removes the executable while retaining global and project user data.
The runtime fixture starts the actual hosted server, rejects anonymous, wrong-credential, and foreign-session connections, exchanges a mock prompt/reply, reports mock usage, restarts with persisted session state, and shuts down.
The runtime image is local acceptance evidence, not a GHCR release digest, attested registry artifact, Daytona snapshot, or deployed rollback baseline.

## Promotion and recovery boundaries

The isolated `./test.sh` run passes 248 release/script tests and 4,948 Vitest tests.
Its 893 skipped tests remain explicitly unaccepted; configured-provider and unsupported-platform cases are not converted into passing evidence.
Command-level publication fixtures exercise missing packages, unavailable tarballs, integrity and byte mismatches, partial publication, conflicting immutable identity, actual pointer-write failure, retries, non-regression, and repeated completion.
Source-selection and artifact-recovery tests reject dirty or divergent sources, unapproved channels, missing retained evidence, and tampered artifacts before remote writes.
Partial publication retains a deliberately synthetic multi-package inventory to exercise generic publisher recovery even though the public release now contains one package.
Those controlled npm/Git/storage commands are not real registry publication.

The staging run invokes `node scripts/verify-release-publication.mjs --staging --public-api` through the existing `diffex-release-staging` environment.
It exercises real conditional R2 writes and anonymous Worker reads for creation, repeated completion, invalid records, unavailable prerequisites, newer advancement, older non-regression, and recovery from a retained version record with a missing pointer.
The fixture versions are `0.1789336470229.0` and `0.1789336470229.1`.
Cleanup verifies both version keys, `releases/v1/latest.json`, and `verification/release-publication.lock` absent.
The final anonymous latest-version response is HTTP 404 `no_published_release`; readiness is HTTP 200 with `release: "missing"`.
The production credential check is read-only and confirms bucket isolation.

## Source-client startup repair and remaining gate

The initial full staging canary failed before its first HTTP request because a clean checkout lacks `packages/ai/src/providers/data/.manifest.json`.
A clean source archive reproduced `ERR_MODULE_NOT_FOUND` with exit code 1 and an empty request log.
Restoring the validated model snapshot made the same source executable report `0.2.1` and reach staging normally.
The workflow now hydrates and validates model data, checks offline source startup before acquiring the staging fixture lock, and pins Node 22.19.0.
Its connection assertion includes captured startup output so an expected negative update exit cannot hide an import failure.
The source CLI regression suite passes all 32 cases after this repair.
An anonymous clean-source check observes the staging no-release response with one request, no installation command, and verified local cleanup.

Both GitHub release environments currently allow only `main`.
The corrected full source-client matrix on the branch requires explicit temporary staging branch access or execution after merge.
That full credentialed matrix remains pending and is not represented as passed.
Production environment protections remain unchanged, and branch workflows skip production credential access.
When access is authorized, run the exact branch revision, verify all client cases and fixture cleanup, then remove the temporary staging branch rule.
The source-client canary always substitutes npm responses and intercepts installation; real installed-package acceptance is established separately above.

## Network destinations and privacy

The source-client guard permits only `diffex-public-api-staging.yibai14651.workers.dev:443` after remapping the canonical latest-version URL.
The retained read-only client result records anonymous GET, redirects disabled, JSON, `Cache-Control: no-store`, and the actual staging response.
Storage rehearsal contacts the configured Cloudflare R2 account endpoint using staging-scoped credentials and the `diffex-artifacts-staging` bucket.
Installed terminal fixtures record the logical `https://api.diffex.ai/api/latest-version` request but answer locally and reject unexpected socket attempts.
Lifecycle tests use loopback discovery/registry fixtures, with third-party dependency downloads through `registry.npmjs.org`.
These application-level guards and event logs are not a whole-host packet capture or proof of live provider egress.
Catalog preparation contacts its approved catalog inputs; the local refresh encountered a transport failure, so the existing validated local snapshot was used for source gates while the native build retained its freshly hydrated snapshot.

The historical source identity gate accepted seventeen reviewed occurrences across 915 files.
Inspection of that historical tarball found sixteen identity matches in nine files, then approved as Radius, catalog, OAuth, and provider-attribution entries.
Radius approval has since been revoked for every environment.
Catalogs, ChatGPT registration, and application attribution have also migrated to the current Diffex defaults described in [the residual inventory](../../identity-residual-allowlist.md).
The JSON evidence preserves its original URLs, headers, and review labels; it does not define current service permissions.
The final payload gate verifies required notices, runtime-file hashes, the documentation allowlist, and absence of prohibited source and embedded maps.
Image inspection accepts 1,414 project files across twelve runtime workspaces and thirty approved documentation assets.
All isolated installation prefixes, caches, homes, mock sessions, fixture servers, and runtime containers are removed by their harnesses.
No provider sandbox, hosted deployment, production metadata record, registry package, or release tag is created by this rehearsal.
