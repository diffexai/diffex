# Releasing Diffex

Diffex publishes its public workspaces in lockstep and uses GitHub Actions trusted publishing for normal npm releases.
The release tag also builds binaries, stages the GitHub release, announces the verified release, and publishes the staged GitHub release.

## Prerequisites

- Use a clean `main` branch with all intended changes merged.
- Confirm GitHub Actions can start jobs and the repository billing or spending limit is not blocking runners.
- Confirm the `@earendil-works` npm organization exists and your npm account has package publishing permission with account-level two-factor authentication enabled.
- Use npm 11.15.0 or newer when configuring trusted publishers.
- Confirm every public package has repository metadata pointing to `diffexai/diffex`.

## First npm publication

npm requires a package to exist before a trusted publisher can be configured.
Use this bootstrap process only once, before the first normal release.

1. Sign in with an npm account that can publish public packages under `@earendil-works`.

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
   The command is resumable after a partial failure: it skips packages already published at the exact workspace version and refuses packages that already exist only at other versions.

4. Run every `npm trust github` command printed by the bootstrap command.
   The trusted publisher values must remain:

   - Repository: `diffexai/diffex`
   - Workflow file: `build-binaries.yml`
   - Environment: `npm-publish`
   - Allowed action: `npm publish`

5. Verify each package has the expected trusted publisher.

   ```bash
   npm trust list @earendil-works/diffex-coding-agent
   ```

6. Restrict traditional token publishing after trusted publishing is verified.

## Normal release

Run the appropriate release command only after local checks pass and the release workflow is operational.

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

The release command updates versions and generated artifacts, runs checks and tests, creates the release commits and tag, and pushes `main` plus the tag directly.
It is not a dry-run command.
Review the target version and obtain approval for the remote push before running it.

The pushed tag triggers `.github/workflows/build-binaries.yml`.
Do not announce the release until that workflow publishes npm packages, the verified release announcement, and the GitHub release successfully.
