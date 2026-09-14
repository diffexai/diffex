# Diffex version discovery and canonical self-update

Interactive startup and manual self-update share `https://api.diffex.ai/api/latest-version` as their only version authority.
The request uses a Diffex user agent, JSON accept header, omitted credentials, and disabled caching.
There is no endpoint setting or environment override in production code.
There is no Pi, npm latest-tag, or alternate-source fallback.
All redirects are rejected without following their location, including same-origin redirects.
This keeps request forwarding restricted to the exact reviewed endpoint.

The shared checker validates the untrusted JSON with `isLatestVersion` from the [release contract](contract.md).
Only HTTP 200 JSON containing exactly a canonical stable `version` and `packageName: "@diffexai/diffex"` is accepted.
Missing or foreign identities, arrays, null, unknown fields, URLs, npm aliases, prereleases, build metadata, leading zeroes, leading `v`, whitespace, and trailing newlines are rejected before comparison.
The checker also rejects numeric components outside npm semver's supported range instead of rounding them.
The manual planner independently checks the stable version and identity before the force decision, installation detection, Windows dependency preparation, and process dispatch.
It constructs the installation specification from the local `RELEASE_PACKAGE_NAME` constant and the validated version.
Normal and forced valid updates attempt only `@diffexai/diffex@<version>` without a package-migration uninstall.
Equal or older releases do not install unless force is requested.

## Failure and opt-out behavior

Automatic checks make at most one request and remain silent on failure.
Manual checks retain at most two additional attempts for transient HTTP or transport failures.
All attempts share a ten-second deadline, which also bounds consumption of the response body.
Redirects, invalid payloads, and absent releases do not trigger retries.
`DIFFEX_OFFLINE` disables both automatic and manual discovery, including forced updates.
`DIFFEX_SKIP_VERSION_CHECK` disables only automatic discovery; explicit manual checks still run.

| Condition | Manual result |
| --- | --- |
| Exact HTTP 404 JSON `{"error":"no_published_release"}` | `No published Diffex release is available yet.` |
| Other HTTP errors, redirects, wrong content type, invalid JSON, or body failure | `Diffex update service is unavailable. Try again later.` |
| Invalid success schema, identity, or version | `Refusing self-update: expected a stable @diffexai/diffex release.` |
| Transport failure or request timeout | `Diffex update service is unavailable: <transport diagnostic>` |
| Offline | `Could not determine latest diffex version.` |

Each failure exits manual update with status 1 before package mutation.
An unrelated 404, HTML error page, or unavailable service cannot be presented as an intentionally absent first release.
Server response bodies and redirect destinations are not copied into errors.

## Update notes

The former checker accepted an optional remote `note` field, and both manual and interactive code contain intentional note rendering.
The current stored record and HTTP projection have no note field.
The consumer therefore rejects responses containing notes as unsupported contract extensions.
The `LatestDiffexRelease.note` display capability, manual Markdown renderer, and interactive notification renderer remain intact for a future coordinated contract extension.
This migration does not invent an unverified note source or enable the currently disabled automatic update notification.

## Reproduction and verification

On 2026-09-10, the existing 18-case controlled source-CLI suite passed on the parent branch `feat/pin-self-update-package` before the authority change.
New CLI regressions then reproduced the Pi URL, default redirect handling, and identical generic errors for no release and service failure.
They also captured acceptance and rendering of an unsupported note before intercepted installation.
The earlier unsafe foreign-package reproduction remains documented in the [historical reproduction record](version-update-reproduction.md).

Run focused validation from `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/version-check.test.ts test/version-update-e2e.test.ts test/package-command-paths.test.ts test/release-contract.test.ts --reporter=verbose
```

The checker suite applies the shared HTTP corpus through the production consumer and covers strict JSON content types, unsupported semver ranges, exact no-release classification, retries, timeout cancellation, offline mode, and automatic opt-out.
Redirect tests run the real Undici fetch implementation against an isolated `MockAgent` with external network access disabled and assert zero requests to the redirected host.
The source CLI suite retains four terminal journeys and three manual update scenarios for canonical installation, forced foreign-package rejection, and offline suppression.
The command integration suite exercises the real handler and validation with isolated settings, controlled HTTP responses, and a recording installer for detailed response permutations, retry exhaustion, equal and older versions, forced reinstall, and manual checks after automatic opt-out.
Interactive cases use a real 100-column, 30-row PTY, verify rendered `/name` confirmations around discovery completion, and exit through `/exit` without submitting model prompts.
The harness isolates home, credentials, project resources, and package prefix, blocks alternate network paths, intercepts package-manager execution, and removes every temporary directory.
All accepted installation attempts are pinned to the canonical package and explicit validated version; no install or uninstall executes.

The original migration's final checker and source-CLI run passed 101 cases: 69 checker cases and 32 source-CLI cases.
The package-command integration and consumer fixture suites also passed all 31 and 23 cases respectively.
`npm run check` and the complete isolated `./test.sh` suite passed.
The Cloud-to-CLI contract document and fixture comparison passed, and the executable consumer paths contain no Pi version endpoint.
Publisher and Worker contract fixtures remain unchanged.
The source consumer and test harness need no Cloud or landing application changes.
Controlled fixtures are supplied only by the test preload or isolated fetch dispatcher, never through a production authority override.
These checks establish source-CLI behavior, not a deployed R2-to-Worker-to-CLI canary or acceptance of a published client.
Live staging client canaries, production routing activation, and release publication remain separate work before distributing the migrated client.
