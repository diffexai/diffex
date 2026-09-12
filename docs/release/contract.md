# Stable npm release contract

This contract governs `releases/v1/latest.json`, `releases/v1/releases/<version>.json`, and unauthenticated `GET https://api.diffex.ai/api/latest-version`.
The CLI monorepo publishes records only after downloading every public workspace package at its exact version and comparing the tarball bytes with the retained approved build manifest.
The public API Worker validates the stored record and projects the public response without querying npm per request.
The marker means npm-verified stable release availability at publication time.
The approved distribution policy currently enables npm and defers standalone binaries and other installation channels.
The publisher rejects additional enabled channels until their required public asset verification is implemented.
This schema remains an npm contract and does not describe binary assets, signatures, install locks, or a cross-channel release manifest.
The private build manifest binds the release commit, source tree, lockfile, disclosure policy, frozen model data, private source archive, and exact npm tarball sizes, SHA-256 digests, and SHA-512 integrity values.
Registry verification downloads each canonical npm tarball anonymously, rejects redirects, and recomputes both digests before accepting an existing npm version or advancing release storage.
The stronger publisher prerequisites add no stored or HTTP fields and require no installed-client update.

## Stored record

Records are JSON objects with exactly these required fields.
Unknown fields are rejected at the root and within packages; schema changes require coordinated publisher and consumer updates.
Records have no top-level `packageName`, `channel`, or `note`.

| Field           | Requirement                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | JSON number `1`.                                                                                                               |
| `version`       | Canonical stable `major.minor.patch` string, each component `0` or a nonzero decimal digit followed by decimal digits.         |
| `sourceCommit`  | Full Git SHA-1 as exactly 40 lowercase hexadecimal characters.                                                                 |
| `publishedAt`   | Real UTC calendar timestamp in the publisher's `YYYY-MM-DDTHH:mm:ss.sssZ` format, round-tripping through `Date.toISOString()`. |
| `packages`      | Nonempty array of package objects with unique names, including exactly one `@diffexai/diffex`.                                 |

Versions exclude prereleases, build metadata, leading `v`, leading zeroes, surrounding whitespace, and trailing newlines.
Components are decimal integers without a JavaScript safe-integer ceiling; the publisher compares them with `BigInt`.
Consumers must reject unsupported numeric ranges rather than rounding them or constructing a different installation target.

Each package has exactly `name`, `version`, `tarball`, and `integrity`.
Names use lowercase npm-style names, optionally scoped, matching `(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*` in full, with at most 214 characters.
Every package version equals the record version, including the canonical CLI package.
The Worker does not hardcode the workspace package inventory; verifying completeness against the source checkout belongs to release CI.
Package order has no meaning.

Tarballs are canonical absolute HTTPS URLs that round-trip through `URL.href`, without embedded username, password, or fragment.
Integrity is one `sha256`, `sha384`, or `sha512` SRI digest with canonical padded base64 encoding and the corresponding 32, 48, or 64 decoded bytes.
Empty values, malformed encodings, unsupported algorithms, and multiple digests are rejected.
Tarball URLs, integrity, commit, timestamp, and workspace inventory stay out of the public latest-version response.

The publisher validates new records before writing either key and validates existing records before using them for repeat publication or latest-pointer comparisons.
Existing malformed records fail closed and are not treated as missing.
Publication still requires npm verification, immutable versioned records, and conditional latest-pointer writes that cannot regress the version.

## HTTP behavior

| Condition                                                                | Status | JSON body                                                           | Additional header |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------- | ----------------- |
| Valid stored release                                                     | `200`  | `{"version":"<verified version>","packageName":"@diffexai/diffex"}` | None              |
| Latest object absent                                                     | `404`  | `{"error":"no_published_release"}`                                  | None              |
| Invalid JSON, invalid record, read/body failure, or inaccessible storage | `503`  | `{"error":"release_unavailable"}`                                   | None              |
| Method other than `GET`                                                  | `405`  | `{"error":"method_not_allowed"}`                                    | `Allow: GET`      |

All responses use `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`.
The HTTP runtime suppresses the body for `HEAD`, while preserving the `405` status and headers.
Method rejection takes precedence over release availability and should happen before storage access.
Only absence of the fixed latest object means no published release; JSON `null`, denied access, malformed content, and a missing binding mean unavailable.
Internal exception messages must never enter responses.
The endpoint has no caller-dependent version filtering, authentication, cookies, or credential selection and ignores query parameters.
Equal, older, and newer callers receive the same verified release.
There is no npm-tag, Pi, binary URL, or other fallback authority.
Unsupported paths, including trailing-slash and suffix variants, remain `404 {"error":"not_found"}` at the Worker routing boundary.

## Ownership and conformance

The cloud implementation lives in `services/public-api/src/release-contract.ts` and `latest-version-response.ts`.
The CLI counterpart lives in `packages/coding-agent/src/utils/release-contract.ts` and is used by the publisher.
The cloud fixture corpus is `services/public-api/fixtures/release-contract.json`; its CLI copy is `scripts/fixtures/release-contract.json`.
This document is mirrored as cloud `docs/release-contract.md` and CLI `docs/release/contract.md`.
The fixtures are synthetic examples, never proof of an actual published version.

When either side changes, update both copies of this document and the fixture corpus, run both repositories' contract tests and required quality gates, and include companion PR links.
From the cloud root, compare the two checkouts with:

```sh
node scripts/check-release-contract.mjs /path/to/diffex-new
```

Run cloud contract tests from `services/public-api`:

```sh
npm run test -- tests/unit/release-contract.test.ts
npm run check
```

Run publisher tests from the CLI root and consumer fixture tests from `packages/coding-agent`:

```sh
node --test scripts/release-contract.test.mjs scripts/publish-release-announcement.test.mjs
node ../../node_modules/vitest/dist/cli.js --run test/release-contract.test.ts
```

The contract corpus covers required fields and types, stable version exclusions, package identity and uniqueness, lockstep versions, timestamp, commit, URL, integrity, unknown fields, public projection, and all HTTP outcomes.
Command-level publisher tests validate actual emitted records against the corpus rules with controlled npm responses and intercepted storage operations.
All temporary publisher fixtures are removed after testing, and these checks need no staging or production credentials.

## Integration status

The public Worker serves the fixed R2 latest record, and the CLI consumes the exact canonical version endpoint with a pinned npm installation target.
The cloud production and staging operations records retain their deployment and route evidence.
This publisher hardening introduces no Worker deployment or live release publication.
Command-level publication regressions use controlled npm bytes and intercepted storage operations.
The unchanged cloud contract fixtures and Worker tests verify consumer compatibility.
Live publication against actual approved packages remains gated by the separate release authorization and packaging prerequisites.
The landing application and authenticated Render `/v1` contracts require no change.
