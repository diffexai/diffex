# Homebrew distribution

## Scope and current gate

The Homebrew implementation uses self-contained Node archives, not Bun compilation, `npm install` in a formula, or a direct installer. There is no `install.sh`, standalone installation root, direct uninstall command, or standalone self-updater. Windows, musl, older OS baselines, Homebrew core and a separate bottle pipeline remain out of scope.

**Publication is not enabled by this implementation.** `distribution-policy.json` keeps `channels.homebrew` and `channels.standalone` at `defer`. `homebrew-signers.json` intentionally contains no release key. Do not present the tap as available until the owner completes the prerequisites below. The existing npm release/discovery schema and npm trusted-publisher workflow identity remain unchanged.

After the first separately authorized release and tap merge:

```sh
brew install diffexai/tap/diffex
brew upgrade diffexai/tap/diffex
brew uninstall diffexai/tap/diffex
```

Use the explicit three-part formula name to avoid ambiguous tap shorthand. These commands consume `diffexai/homebrew-tap`.

## Archive and runtime authority

Native runners prepare `diffex-<version>-<darwin|linux>-<arm64|x64>.tar.gz` from the exact retained, inspected CLI npm tarball. No independent dependency resolution is allowed. Preparation copies the generated installation lock and substitutes only the retained CLI archive's local resolved path and SHA-512 integrity. Bundled npm runs `ci --omit=dev --include=optional --ignore-scripts`; installed package identities must match the reviewed lock. The public payload restores registry identities rather than disclosing temporary local paths.

`node-runtime.json` pins Node 22.23.4, private npm 10.9.9, all four official archive digests, the checksum list and detached signature, and the authorized Node release-key bytes/fingerprint. Preparation verifies the signed official checksum list with an isolated GPG keyring and rejects a different signer, changed input, redirected authority download or unsupported target. The runtime proof is retained inside the archive. The Node executable is copied unchanged and separately hashed; this preserves its upstream embedded signature, but does not replace macOS quarantine acceptance.

Node 22's maintenance end is an explicit release blocker. Runtime updates require reviewing the official security release, signer authority, exact four-platform hashes, bundled npm and its dependencies, redistribution materials and acceptance again. Do not update a version string without changing and reviewing the complete pin set.

Each archive contains:

```text
diffex/
  bin/diffex
  runtime/bin/node
  runtime/lib/node_modules/npm/
  runtime/LICENSE
  runtime/SHASUMS256.txt
  runtime/SHASUMS256.txt.sig
  runtime/release-key.asc
  app/package.json
  app/package-lock.json
  app/node_modules/@diffexai/diffex/
  app/node_modules/...
  distribution.json
  distribution-files.json
  distribution-components.json
  LICENSE
  THIRD-PARTY-NOTICES.txt
```

The physical-path launcher handles relocation, spaces and symlink chains and executes bundled Node by absolute path. No global `node`, `npm` or `npx` executable is installed. Private npm is selected for extension operations unless the user explicitly configures `npmCommand`; extension subprocesses receive bundled Node on PATH. User/project package directories, project trust and lifecycle policy remain unchanged. Native extension builds may still need Git, shell tools, compilers and OS development libraries; credential services and desktop clipboard services remain OS prerequisites.

The original npm disclosure checker still checks all Diffex-owned bytes. The separate Homebrew checker permits third-party upstream source, licenses and notices instead of applying Diffex's `src`/`NOTICE` exclusion to dependencies. It rejects credentials/configuration files, development records, workspace links, escaping/cyclic links, special files, duplicate/case-colliding paths and excessive expansion. Safe internal dependency executable links are inventoried. Ordering, permissions and timestamps are normalized. Every public payload file/link and installed component is inventoried; the retained final compressed bytes are the authority, not a claim that arbitrary future rebuilds reproduce them.

The official npm runtime contains an empty `.npmrc` placeholder. Preparation accepts only exactly empty bytes and omits that file; nonempty configuration fails. No `.npmrc`, `.netrc`, `.env` or `auth.json` is allowed in a public archive.

## Formula and ownership

`scripts/homebrew-formula.mjs` validates a strict four-target `homebrew-manifest.json` and renders `homebrew/diffex.rb.template`. URLs are constructed from the fixed repository, stable version and canonical filenames. The formula pins each SHA-256, installs the complete payload at `libexec/diffex`, and exposes only `bin/diffex`. Required external formulas are `fd`, `git` and `ripgrep`.

Initial qualification targets are macOS 15+ and Ubuntu 24.04-class glibc Linux (glibc 2.39+), each arm64/x64. The formula rejects unsupported CPUs, musl and older glibc. These baselines must not be broadened without native evidence.

Homebrew writes `libexec/.diffex-homebrew.json` outside the archive:

```json
{"schemaVersion":1,"package":"@diffexai/diffex","formula":"diffexai/tap/diffex"}
```

Runtime detection validates that marker and the physical bundled layout before npm path heuristics. Plain `diffex update`, self-update aliases and `--force` print `brew upgrade diffexai/tap/diffex` before settings/resource/version-discovery bootstrap. They do not invoke Brew/npm or modify files. Explicit `--extensions` and `--all` retain extension-management behavior; the self-update part of `--all` remains instruction-only.

Brew owns application replacement and removal. No application self-update, global npm prefix operation or direct installer is involved. Removing the formula retains `~/.diffex/agent`, project `.diffex` data, credentials, sessions and any configured session directory. Repair with `brew reinstall diffexai/tap/diffex`; inspect `command -v diffex` before modifying another installation. A manually extracted archive is not adopted as Homebrew-owned.

## Release ordering and exact-byte recovery

`.github/workflows/build-binaries.yml` retains its filename and `npm-publish` OIDC identity. The optional Homebrew sequence is:

1. Resolve the immutable release source and retain the reviewed npm tarball using the existing path.
2. Prepare/inspect each native archive and execute acceptance outside the repository without system Node/npm/Bun.
3. Retain `homebrew-<platform>-<commit>` with only the approved archive and its record.
4. Aggregate and re-inspect all four records against the retained npm source/version. Sign the checksum list and retain the complete `homebrew-release-<commit>` bundle before either publication job.
5. Publish npm and GitHub assets. Create the GitHub release with `latest=false`. Verify every existing public asset before uploading a missing one; never clobber a conflict.
6. Anonymously download all seven retained public files and compare their exact bytes. GitHub-to-asset-CDN redirects are bounded and restricted; no credential is sent to the downloads.
7. Reverify npm and Homebrew before writing the unchanged npm discovery record. Only then promote GitHub latest under the serialized announcement gate, without displacing a newer stable version.
8. Issue a short-lived, single-repository GitHub App token and open a narrow tap update PR. Tap CI tests before a human merges it.

Public files are the four archives, `homebrew-manifest.json`, `SHA256SUMS` and `SHA256SUMS.sig`. The checksum list covers the archives and manifest. There is deliberately no installer asset. The manifest binds product, stable version, full source commit, Node/npm versions, per-target filename/size/SHA-256, OS baseline and payload inventory hash.

The protected `homebrew-release` environment provides `HOMEBREW_SIGNING_KEY`. The RSA-3072/SHA-256 signer must match a reviewed SPKI SHA-256 fingerprint/public PEM in `homebrew-signers.json`. The private key is never written into the repository, archive or evidence. Homebrew consumers trust the reviewed tap/formula and its pinned archive hash; downloaded signatures or checksums are not independent trust anchors. Release tooling verifies signatures against committed keys, never a key downloaded beside the assets.

For key rotation, add and review the new public key/fingerprint before switching the protected private credential; retain both public keys during the recovery overlap. Verify the new signer on a candidate, switch credentials, and retire the old key only after accounting for retained recovery artifacts. For revocation, disable publication, remove the compromised public key in reviewed source, revoke/replace the protected credential, and assess already published formulas/artifacts. Never accept a replacement key just because a download supplies it, and never overwrite a published version to repair signer history.

Recovery reuses the original platform archives, manifest, checksum list and signature. `restore-release-artifacts.mjs` refuses a rebuild when either npm or Homebrew publication has started. Recovery copies the original retained artifact once and retries that copy; missing/expired/ambiguous evidence blocks recovery. Use the existing recovery dispatch with the original tag/run ID, and retain **all** `homebrew-*` artifacts as well as the npm source artifact. Do not recreate signatures or rebuild a published version. Public bytes that differ from retained bytes are an immutable-asset conflict, not permission to use `--clobber`.

Actions artifacts are not a confidentiality mechanism. The new Homebrew uploads contain reviewed payloads or fixed-schema sanitized summaries only. Existing source/debug retention belongs to the private source workflow; do not change source repository visibility to make release downloads public without separately reviewing that history and retention. The owner must authorize anonymous release hosting at `diffexai/diffex` without exposing private source/build inputs, or approve a revised fixed public asset-repository contract before enabling publication.

## Qualification and operational prerequisites

Before setting `HOMEBREW_DISTRIBUTION_ENABLED=true` or approving `channels.homebrew=enable`:

- Approve the complete Node/npm/native/production-dependency redistribution inventory and required legal/source materials. Third-party retention is not itself a legal approval.
- Review the authorized Node release key against the first-party Node release-key list and the pin-change evidence.
- Configure the protected release signing credential and commit its reviewed public key/fingerprint. The empty key list must not be filled with an ad-hoc development key.
- Authorize public release hosting and create `diffexai/homebrew-tap` separately. Seed its reviewed CI from `homebrew/tap/`; this implementation never creates or pushes that repository.
- Configure the protected `homebrew-tap` environment, `HOMEBREW_TAP_APP_ID` and `HOMEBREW_TAP_APP_PRIVATE_KEY`. Install the App only on the tap, with contents/pull_requests write and metadata read. No PAT or broad installation token is accepted.
- Retain four-target native archive/formula lifecycle evidence, native keyring/clipboard/WASM/image/HTML-export evidence, macOS browser quarantine and `codesign` checks. Missing desktop/manual checks are blockers, not passes. Never recommend disabling Gatekeeper.
- Run the Daytona Homebrew candidate job using an approved, non-root preprovisioned snapshot and retain successful execution **and** cleanup evidence.
- Complete anonymous public exact-byte verification and tap CI for the first release.

Record the review date, four target names and accepted evidence in `homebrewApproval`. Publication scripts enforce the approval gate. `HOMEBREW_CANDIDATES_ENABLED=true` enables native candidate preparation while publication remains deferred. Daytona has a separate `homebrew_candidate` dispatch input or `HOMEBREW_QUALIFIED=true` switch and uses `DAYTONA_HOMEBREW_SNAPSHOT`; see its workflow and behavior harness. A trusted local-file formula/revision upgrade tests real Brew mechanics against retained candidate bytes, not a second published release or live tap behavior.

For local native candidate preparation after the usual reviewed build:

```sh
node scripts/prepare-homebrew-archive.mjs .artifacts/release /tmp/diffex-homebrew-candidate
node scripts/homebrew-acceptance.mjs /tmp/diffex-homebrew-candidate/diffex-VERSION-PLATFORM.tar.gz /tmp/diffex-homebrew-candidate/diffex-VERSION-PLATFORM.json /tmp/diffex-homebrew-evidence
```

`npm run release:local -- --homebrew --out /tmp/diffex-local-release` adds a native archive to the existing local release path. It builds and checks the candidate; it does not publish. Do not run release publication commands merely to test the formula.

## Local implementation verification

The full credential-isolated `./test.sh` non-E2E suite passed after fixing GPG's Unix-socket path limit under long macOS test temporary directories. `npm run check`, focused archive/formula/signature/publication/recovery/workflow/runtime tests, and the Daytona harness's 80 Python unit tests passed. The signature verifier now uses a private short-lived keyring and disables agent auto-start. Ruby fixture syntax and the local-release help entrypoint were also checked.

These tests use local cryptographic, registry, archive and GitHub fixtures. They do not establish a full retained-application archive build, successful public hosting, production credentials, paid-provider behavior, real native Homebrew lifecycle, desktop services, quarantine acceptance or an actual Daytona run. No tap repository was created or pushed, no release was published, and no workflow was dispatched. Those remain separate observable release evidence and are not marked accepted by the policy.
