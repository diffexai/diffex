# Diffex model catalog contract

The CLI repository owns generation, validation, publication, and persisted client overlays.
`diffex-cloud/services/public-api` owns anonymous serving through `https://api.diffex.ai/api/models/providers/{providerId}`.
No database is involved.
Upstream metadata sources and generator overrides remain unchanged.

## Storage and publication

Account `6b24afa849f8254ab5e6e2d1956239cc` hosts private buckets `diffex-artifacts-staging` and `diffex-artifacts`.
The Worker binds the matching bucket as `MODEL_CATALOGS`.
GitHub environments `diffex-model-upload-staging` and `diffex-model-upload-production` each contain bucket-scoped `DIFFEX_ARTIFACTS_R2_ACCESS_KEY_ID` and `DIFFEX_ARTIFACTS_R2_SECRET_ACCESS_KEY` secrets and permit only `main`.
Neither bucket needs public access.

The strict JSON export includes `models.json`, sorted `providers.json`, `providers/{providerId}.json`, and `generation.json` with `generatedAt` and the workflow's resolved `sourceCommit`.
All model fields pass the bundled-model validator before export.
Publication additionally requires matching provider shards, `anthropic`, `openai`, `openrouter`, and at least 500 models.

The revision is `sha256-` followed by the SHA-256 of the exact `models.json` bytes.
Immutable objects live under `models/v1/revisions/{revision}/`.
That directory contains the models, provider list, shards, and an immutable `publication.json`:

```json
{
  "schemaVersion": 1,
  "minimumDiffexVersion": "0.3.3",
  "revision": "sha256-<64 lowercase hexadecimal characters>",
  "sourceCommit": "<40 lowercase hexadecimal characters>",
  "generatedAt": "2026-10-26T10:00:00.000Z",
  "providerIds": ["anthropic", "openai", "openrouter"],
  "providerCount": 3,
  "modelCount": 510,
  "providers": {
    "openai": {
      "key": "models/v1/revisions/sha256-<digest>/providers/openai.json",
      "sha256": "<SHA-256 of the exact provider shard bytes>",
      "modelCount": 170
    }
  }
}
```

The example abbreviates the provider map; every listed provider must have an entry, and counts must sum exactly.
Identical-content retries preserve the first manifest's source and timestamp.
The initial compatibility floor is `0.3.3`; raise it only with metadata requiring newer client behavior.
Raising a floor requires a new content revision, since a published manifest cannot be edited.

The mutable `models/v1/index.json` contains `schemaVersion: 1`, `defaultRevision`, `catalogs`, `validatedAt`, and `validationSourceCommit`.
Each tier has `minimumDiffexVersion`, `revision`, `sourceCommit`, `generatedAt`, `providerCount`, and `modelCount`.
Publication replaces only the matching compatibility floor and retains other tiers.
Every successful publication, including unchanged content, advances validation evidence independently of generation age.

All revision objects use S3 `PutObject` with `If-None-Match: *` and are downloaded and verified before index advancement.
The publisher verifies an existing immutable manifest instead of replacing it.
The index is updated with `If-Match` against the ETag read before uploads, or `If-None-Match: *` for the initial write.
Conflicts fail the run; regenerate from current main and retry.
Interrupted uploads leave the previously selected revision intact.
R2's [consistency guarantees](https://developers.cloudflare.com/r2/reference/consistency/) allow verification directly through private storage without public caches.

## Serving and cache provenance

The only new production route is `https://api.diffex.ai/api/models/providers/*`.
Release discovery stays on its existing Worker route; auth, webhooks, `/v1/*`, and production health routes remain on Render.
Provider IDs must match `[a-z0-9][a-z0-9-]{0,99}` with no extra path segments or encoded separators.
Storage keys come exclusively from the selected, validated publication manifest.

Anonymous `GET` and `HEAD` select the highest compatibility floor supported by the `diffex/<version>` user-agent token.
A prerelease does not satisfy the same stable-version floor.
Unrecognized or absent Diffex versions select `defaultRevision`.
No compatible tier returns `501`; an unknown provider returns `404`; unsupported methods return `405` with `Allow: GET, HEAD`.
Missing, malformed, oversized, corrupt, or inaccessible storage returns `503` and never exposes internal storage errors.

Successful responses retain the provider's model-ID-keyed JSON object and return `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, no-cache`, and `Vary: User-Agent`.
The quoted ETag is `"{revision}:{providerId}"`.
Cloudflare may add the weak `W/` prefix when compressing a response; clients retain the received validator and probes compare its opaque value.
`Last-Modified` is the immutable generation timestamp rounded to HTTP-date precision.
`If-None-Match` takes precedence over `If-Modified-Since`, supports weak tags and lists for GET/HEAD revalidation, and returns bodyless `304` on a match.
Every HEAD response is bodyless.
The mutable index is read directly from R2 on each request.

Client cache entries record the exact provider URL as `catalogUrl` and the selecting CLI version as `catalogClientVersion`.
Only entries matching both values may restore models, suppress refreshes for four hours, or send a cached ETag.
Legacy or mismatched entries fall back to bundled models and refresh unconditionally when network access is allowed.
Newer bundled metadata retains precedence.
Successful bodies are fully validated before persistence; failures and cancellation preserve the last valid matching cache.
`diffex update --models` forces refresh, including rollback discovery.

## Validation and rollout

Run focused publisher and client tests and `npm run check` in the CLI repository.
Run `npm run check` in `diffex-cloud/services/public-api`.
The opt-in local integration requires the companion checkout, AWS CLI with conditional-put support, and tmux:

```sh
DIFFEX_CLOUD_DIR=/path/to/diffex-cloud node scripts/catalog-local-e2e.mjs
```

It exercises the actual publisher through local R2's S3 API, the Worker runtime, CLI update and persisted cache, the interactive selector, and offline startup using an isolated agent directory.
It blocks unrelated outbound requests and performs no model inference.

Coordinate repository changes before enabling scheduled publication.
Rehearse against staging with staging-only credentials and verify fixture cleanup.
From the CLI repository, set `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_DEFAULT_REGION=auto` in an approved environment, then run:

```sh
node scripts/catalog-staging-rehearsal.mjs --staging
```

The rehearsal requires the catalog Worker to be deployed to staging first.
It creates an isolated synthetic revision, checks interrupted uploads and conditional conflicts, exercises the deployed endpoint and isolated CLI, restores the prior index conditionally, and deletes and verifies only its fixture objects.
It refuses to overwrite a concurrent index change and retains recovery evidence if cleanup fails.
Seed production with a validated real catalog, deploy the narrow Worker route, and verify real `200`/`304` responses and unchanged release/Render routes before shipping the client default.
Do not publish synthetic fixture models to production.

## Monitoring and rollback

Weekday publication candidates preserve 10:17, 12:17, and 14:17 Europe/Vienna and the existing successful-main-CI window of 10:00 through 14:59.
Manual publication bypasses the window; PRs only validate.
Generation and publishing code use one resolved SHA; the publisher checks current main before upload and immediately before index advancement.
Uploads serialize per environment without cancelling active uploads.

`monitor-model-catalog.yml` checks successful generation and actual production upload steps separately, with one hour of scheduling grace and weekend/DST handling.
`diffex-cloud`'s existing monitor probes availability, HEAD, ETag/date validators, release discovery, and Render routing.
Old generation timestamps are healthy when content is unchanged.
Both [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule) can be delayed or dropped, so configure an independent external heartbeat for the monitor and confirm failure notifications after merge.
Repository changes alone do not prove scheduled execution or notification delivery.

Retain immutable revisions for rollback.
Download and preserve the current index bytes and ETag, verify every object referenced by the desired historical index, then replace the index with `If-Match` against the captured current ETag.
Do not force an index update after a conditional conflict.
Alternatively, roll back to a verified Worker deployment while preserving catalog bindings and narrow routes.
Worker rollback does not roll back R2 objects.
Clients discover a catalog rollback on their next refresh or through `diffex update --models`.
