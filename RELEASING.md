# Releasing Diffex

Diffex publishes its public workspaces in lockstep and uses GitHub Actions trusted publishing for normal npm releases.
The release tag publishes the approved npm packages and then announces the verified npm release.
Standalone archives and other installation channels are deferred by the [approved distribution policy](docs/release/distribution-policy.json).

## Prerequisites

- Use a clean `main` branch with all intended changes merged.
- Confirm GitHub Actions can start jobs and the repository billing or spending limit is not blocking runners.
- Confirm the `@diffexai` npm organization exists and your npm account has package publishing permission with account-level two-factor authentication enabled.
- Use npm 11.15.0 or newer when configuring trusted publishers.
- Confirm every public package has repository metadata pointing to `diffexai/diffex`.

## Approved payloads

The eleven public packages are derived from `scripts/release-packages.mjs`.
Every package declares Apache-2.0 and ships the full root license, including the complete MIT notice for Pi-derived portions.
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
For the CLI at version 0.2.0, that URL is `https://registry.npmjs.org/@diffexai/diffex/-/diffex-0.2.0.tgz`; it becomes available only after separately authorized publication.
No GitHub release publication or separate asset-repository credential is used.
Npm trust remains bound to the private source repository and the existing workflow filename.

## First npm publication

npm requires a package to exist before a trusted publisher can be configured.
Use this bootstrap process only once, before the first normal release.

1. Sign in with an npm account that can publish public packages under `@diffexai`.

   ```bash
   npm login
   ```

2. Build and validate every package without publishing anything.

   ```bash
   npm run release:bootstrap-npm:dry
   ```

3. Publish the current lockstep version under the non-default `bootstrap` dist-tag.

   ```bash
   npm run release:bootstrap-npm
   ```

   Bootstrap publication deliberately omits provenance because it runs interactively outside the trusted CI environment.
   It does not assign the `latest` dist-tag.
   The command is resumable after a partial failure: it downloads and hashes packages already published at the exact workspace version against the retained approved artifacts and refuses packages that already exist only at other versions.

4. Run every `npm trust github` command printed by the bootstrap command.
   The trusted publisher values must remain:

   - Repository: `diffexai/diffex`
   - Workflow file: `build-binaries.yml`
   - Environment: `npm-publish`
   - Allowed action: `npm publish`

5. Verify each package has the expected trusted publisher.

   ```bash
   npm trust list @diffexai/diffex
   ```

6. Restrict traditional token publishing after trusted publishing is verified.

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
