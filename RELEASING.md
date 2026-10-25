# Releasing Diffex

Diffex publishes only `@diffexai/diffex` and uses GitHub Actions trusted publishing for normal npm releases.
The release tag publishes the approved npm packages and then announces the verified npm release.
Standalone archives and other installation channels are deferred by the [approved distribution policy](docs/release/distribution-policy.json).

## Prerequisites

- Use a clean `main` branch with all intended changes merged.
- Confirm GitHub Actions can start jobs and the repository billing or spending limit is not blocking runners.
- Confirm the `@diffexai` npm organization exists and your npm account has package publishing permission with account-level two-factor authentication enabled.
- Use npm 11.15.0 or newer when configuring trusted publishers.
- Confirm every public package has repository metadata pointing to `diffexai/diffex`.

## Approved payloads

The single public CLI package is derived from `scripts/release-packages.mjs`.
Internal workspaces remain private and required runtime modules are included inside the CLI tarball.
The generated publication manifest and installation locks contain no registry dependencies on separate Diffex packages.
Every package declares MIT and ships the full root license, including the complete MIT notice for Pi-derived portions.
The generated `NOTICE`, `THIRD-PARTY-NOTICES.txt`, and `distribution-components.json` identify applicable portions and bundled components.
Readable runtime JavaScript, declarations, runtime JSON/SQL data, HTML/CSS templates, and documentation are approved.
Examples and native source build files are excluded; evolution and harness-trace runtime code is explicitly public when vendored in the CLI.
Source maps move into ignored private debug storage, and final tarball inspection rejects embedded maps and prohibited files.
The publisher checks every exact tarball before registry access and publishes those checked bytes.
The same disclosure gate applies to bootstrap publication.

All nine authorized project changelogs must be regenerated through the owner's `/cl` audit after the one-time reset.
Empty or structurally invalid changelogs block packing.
The pre-reset contents are retained at `ae811d134dd63b0a688aea10ea0368c0935e7e48`; never repeat that reset for later releases.

The full source archive remains a private build input and is never a public release asset.
The distribution manifest identifies the private source by its full commit string.
The CLI tarball carries `release/distribution-manifest.json`, `release/install-package.json`, and `release/install-package-lock.json`.
Each package carries `distribution-files.json` with SHA-256 hashes for its approved runtime files.
The complete tarball's npm `dist.integrity` is the registry verification value.
Versioned anonymous downloads use `https://registry.npmjs.org/<PACKAGE>/-/<UNSCOPED_NAME>-<VERSION>.tgz`.
For the CLI at version 0.2.1, that URL is `https://registry.npmjs.org/@diffexai/diffex/-/diffex-0.2.1.tgz`; it becomes available only after separately authorized publication.
No GitHub release publication or separate asset-repository credential is used.
Npm trust remains bound to the private source repository and the existing workflow filename.

## First npm publication

The owner has already verified npm account and organization prerequisites; do not repeat login or ownership checks unless authentication fails.
Use the approved interactive npm session for bootstrap and trust configuration.
npm requires a package to exist before a trusted publisher can be configured.
Use this bootstrap process only once, before the first normal release.

1. Confirm the current candidate has the owner's `/cl` refresh, approved payload review, and local/native artifact acceptance.
   Configure the reviewed `npm-publish` GitHub environment before public bootstrap publication.
   See [publication trust and bootstrap evidence](docs/release/publication-trust.md) for the exact settings and outstanding owner decisions.

2. Build and validate every package without publishing anything.

   ```bash
   npm run release:bootstrap-npm:dry
   ```

   For frozen candidate inputs, use the same offline build path as normal CI from a clean committed checkout:

   ```bash
   npm run hydrate:model-data
   node scripts/release-artifacts.mjs freeze /tmp/diffex-bootstrap-candidate
   npm run build:offline
   node scripts/release-artifacts.mjs prepare /tmp/diffex-bootstrap-candidate
   node scripts/publish.mjs --bootstrap --dry-run --artifacts /tmp/diffex-bootstrap-candidate
   ```

   Retain the entire private directory, including `manifest.json` and frozen source inputs.
   Publish or retry these exact reviewed bytes with `node scripts/publish.mjs --bootstrap --artifacts /tmp/diffex-bootstrap-candidate`; do not rebuild them.
   A new source commit requires a new reviewed candidate directory before any publication.

3. Publish the current lockstep version under the non-default `bootstrap` dist-tag.

   ```bash
   npm run release:bootstrap-npm
   ```

   Both bootstrap and normal publication explicitly disable provenance because npm does not support it for the private source repository.
   Normal CI still authenticates through the exact OIDC trusted publisher; it needs no npm token secret.
   npm can create `latest` on first registration despite `--tag bootstrap`.
   Bootstrap verifies each newly uploaded artifact and removes only an automatically created `latest` pointing at that exact version, then checks that only the intended bootstrap tag remains.
   There can be a registry exposure window between first publication and successful tag removal; retain actual read-back evidence rather than assuming the tag flag prevented it.
   An existing `latest` tag blocks bootstrap before uploads.
   Failed tag cleanup stops the batch and requires operator inspection of the retained manifest, exact published bytes, and tags before removing the unintended tag with `npm dist-tag rm <package> latest --registry=https://registry.npmjs.org`.
   Never remove an established release tag or a tag pointing at another version.
   After cleanup or a propagation failure, rerun against the same retained artifact directory without rebuilding.
   The command is resumable after a partial failure: it downloads and hashes packages already published at the exact workspace version against the retained approved artifacts and refuses packages that already exist only at other versions.

4. Run every `npm trust github` command printed by the bootstrap command.
   The trusted publisher values must remain:

   - Repository: `diffexai/diffex`
   - Workflow file: `build-binaries.yml`
   - Environment: `npm-publish`
   - Allowed action: `npm publish`; npm also automatically grants `npm stage publish` on relationships created after 2026-09-03.

5. Verify each package has the expected trusted publisher.

   ```bash
   node scripts/npm-publication-trust.mjs --verify
   ```

6. Restrict traditional token publishing after trusted publishing is verified.
   In every package's npm access settings, require two-factor authentication and disallow tokens, then retain the reviewed settings alongside the trust evidence.
   Do not revoke unrelated account tokens or claim enforcement from an OIDC configuration alone.

## Normal release

Run the appropriate release command only after local checks pass and the release workflow is operational.

```bash
npm run release:patch
npm run release:minor
```

The release command updates versions and generated artifacts, runs checks and tests, creates the release commits and tag, and requires interactive review of generated diffs, and pushes `main` plus the tag atomically.
Only `patch` (fixes and additions) and `minor` (breaking changes) are supported.
Major and explicit-version release commands are rejected.
It is not a dry-run command.
Review the target version and obtain approval for the remote push before running it.

The pushed tag triggers `.github/workflows/build-binaries.yml`.
Do not announce the release until the workflow verifies npm publication and writes the release announcement successfully.

See [release promotion and recovery](docs/release/promotion.md) for immutable source selection, retained artifact recovery, and exact failure procedures.
