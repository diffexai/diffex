# Publication trust and bootstrap evidence

## Supported npm identity

The source repository remains private at `diffexai/diffex`.
Normal publication uses GitHub Actions OIDC with workflow `build-binaries.yml`, environment `npm-publish`, and direct `npm publish` permission.
Since 2026-09-03 npm automatically also grants `npm stage publish` on new trusted relationships.
The current inventory comes from `scripts/release-packages.mjs` and contains only `@diffexai/diffex`.
The owner approved replacing the initial eleven-package `0.2.0` bootstrap with CLI-only `0.2.1` and retiring the old versions after replacement validation.
No npm token secret belongs in the release workflow.

[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) supports private repositories, but does not generate provenance for them.
The publisher therefore sets `--provenance=false` explicitly, including when inherited npm configuration requests provenance.
It pins the public npm registry and publishes only retained, reviewed tarball bytes with lifecycle scripts disabled.
OIDC authentication does not supply public source provenance or make packaged implementation code confidential.
The supported verification path is the private source/input manifest, SHA-256 and SHA-512 tarball identities, downloaded registry bytes, and inspected npm trust relationships.
Source snapshots and debugging maps remain in private artifact storage.

The workflow pins Node 22.19.0 and npm 11.16.0.
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) requires npm 11.15.0 or newer and an existing package.
Its verified JSON output must contain GitHub type, the exact repository/file/environment, and exactly `createPackage` plus npm's automatically granted `createStagedPackage` permission.
Missing, foreign, or broader relationships fail verification.

```sh
node scripts/npm-publication-trust.mjs --plan
node scripts/npm-publication-trust.mjs --verify
```

The plan prints commands without registry writes.
Run the printed commands only after approved bootstrap bytes exist publicly.
The verifier queries every relationship and prints only configuration metadata.
Traditional publishing restrictions must be checked separately in every package's access settings after trust is confirmed.
An OIDC relationship alone does not disable token publishing.

## Environment and credential boundaries

The `npm-publish` environment was configured on 2026-09-13 and permits branch `main` and tags `v*` only.
The owner approved `Pepps233` reviewer protection with administrator bypass disabled, plus a ref-only fallback if the plan rejected reviewer protection.
GitHub returned HTTP 422 because the repository plan does not support required reviewers.
The approved fallback was applied and inspected; administrator bypass remains enabled and there is no enforced human review gate.

| Destination | Environment | Credential scope |
| --- | --- | --- |
| Public npm artifacts | `npm-publish` | Per-package OIDC tuple; no stored npm publication token |
| Production release records | `diffex-release-upload` | `DIFFEX_ARTIFACTS_R2_ACCESS_KEY_ID` and `DIFFEX_ARTIFACTS_R2_SECRET_ACCESS_KEY`, production bucket only |
| Staging release fixtures | `diffex-release-staging` | Separately installed secrets with the same names, staging bucket only |
| Model catalogs | `diffex-model-upload` | Independent configuration; no release credentials copied |
| Production Worker deployment | Cloud repository `public-api-production` | `CLOUDFLARE_PUBLIC_API_DEPLOY_TOKEN`; no R2 publisher keys |

The approved public asset host is npm.
Standalone and alternate-host assets are deferred, so the unused `diffex-distribution` environment requires no publisher credential.
Production release storage is `diffex-artifacts`; staging is `diffex-artifacts-staging` in the reviewed Cloudflare account.
Existing buckets and credentials must be reused.
Bucket scope grants access to the entire selected bucket; the release prefix remains a code boundary.

The manual verification workflow now checks each release credential independently using read-only bucket listings.
Each key must access its own bucket and receive explicit `AccessDenied` for the other release bucket and `image-converter`.
Timeouts, missing buckets, and invalid credentials cannot count as isolation evidence.
The production check makes no writes; staging fixture verification retains exact ownership checks and cleanup.
The new scope checks require a run after this workflow change reaches `main`, without relaxing the existing environment restrictions.

## Live evidence recorded 2026-09-13

CLI candidate `a25f52bc2` contains the merged distribution, promotion, and native acceptance work.
Anonymous registry inspection at 14:21 UTC returned 404 for all eleven package names at current lockstep version `0.2.0`.
No versions or dist-tags were present.
The owner previously verified npm account prerequisites; this inspection did not repeat login or ownership checks.

GitHub inspection confirmed private source visibility, existing release environments, production `main`/`v*` and staging `main` policies, and the separate secret entries installed on 2026-09-10.
The distribution and model-upload environments had no secret entries.
The cloud production environment had its separate Worker deployment secret.
Secret-name inspection does not prove credential values differ or establish current bucket capability.

[Staging run 34762316585](https://github.com/diffexai/diffex/actions/runs/34762316585) passed on `main` using the existing workflow with `check_public_api=true` and `check_client_canaries=false`.
It exercised controlled npm responses, real staging R2 writes/readback, repeated publication, conditional advancement, interrupted-pointer recovery, and anonymous HTTP projection and rejection behavior.
Fixture versions were `0.1789309179924.0` and `0.1789309179924.1`.
At 14:20:48 UTC it confirmed both version records, the latest fixture pointer, and `verification/release-publication.lock` were absent.
It made no production write and did not publish npm packages.
This run predates the additional credential scope checks and does not claim to validate them live.

## Outstanding acceptance

The owner confirmed the current `/cl` refresh and approved public bootstrap publication of `0.2.0` once validation passes.
The initial environment attempt was blocked by automatic approval review; the owner subsequently approved the exact settings and fallback, and configuration succeeded.
The historical shared-key sentence refers to R2, not Worker deployment.
It has no retained credential identifier, location, or current-state evidence and is not an actionable revocation requirement.
No credential was revoked or replaced on the strength of that note.
All eleven original `0.2.0` packages were uploaded from native-accepted source `e3f96b95ebc7fdad96220e315ec144f74383de22`.
Registry read-back unexpectedly showed both `bootstrap` and `latest` on all names despite explicit `--tag bootstrap`; a reviewed removal attempt returned HTTP 400.
This failed the no-latest acceptance gate and no production announcement was made.
The CLI trusted publisher was created and read back with the exact repository, file, environment, and current npm permission pair.
The owner then requested a CLI-only distribution and approved `0.2.1` with retirement of `0.2.0`.
The replacement tarball includes seven required workspace packages plus the existing evolution and harness-trace runtime modules.
Replacement publication, old-package removal, final dist-tags, and traditional-token restrictions remain pending until their live results are retained.
No R2 production pointer or generally available release may be created by bootstrap.
These pending items prevent publication-trust acceptance from being marked complete.
