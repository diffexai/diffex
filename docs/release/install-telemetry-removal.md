# Install telemetry removal

The CLI no longer reports installations or changelog-detected updates to Pi.
This change is based on CLI PR #205 (`feat/staging-version-canaries`).
Inspection of `diffex-cloud` and `diffex-landing` found no install-report ingest implementation to remove.

## Reproduction and regression boundary

Run from `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/version-update-e2e.test.ts --maxWorkers=1
```

The test starts the real source CLI with `--no-session --no-extensions --no-skills` in an isolated 100x30 PTY.
It supplies no provider credentials and intercepts every fetch before network access, with a socket guard for alternate HTTP clients.
Before removal, first install, upgrade, legacy opt-in, provider attribution opt-in, and normal startup attempted an anonymous `GET https://pi.dev/api/report-install?version=0.2.0` with a platform/runtime User-Agent.
Those five regression cases failed on the attempted request before the implementation changed.

The initial removal passed eight cases: first install, upgrade, current checkpoint, legacy opt-in, legacy opt-out, provider attribution opt-in, offline, and startup with version checks enabled.
The retained coverage now combines these into four terminal journeys in `version-update-e2e.test.ts`: fresh install with a valid newer release, upgrade with legacy telemetry enabled and delayed network failure, current install with automatic checks disabled and provider attribution enabled, and fresh offline install.
The first two journeys contact only the canonical Diffex latest-version endpoint; the others make no requests.
The upgrade journey uses a temporary two-release changelog so it still exercises a real upgrade when the repository contains only one release entry.
Changelog acknowledgement still persists the current changelog checkpoint.
Each process renders confirmations for `/name ci-ready` and `/name ci-settled` before exiting through `/exit`.
The delayed response is released only after the first confirmation, and the second interaction follows response processing.
The harness verifies removal of each temporary home, project, settings, and event record while retaining only the compilation cache until suite completion.

## Settings behavior

The old install-telemetry setting, environment-variable reader, settings callbacks, and reporting helper are removed.
Optional provider headers now use `enableProviderAttribution` and `DIFFEX_PROVIDER_ATTRIBUTION`.
The independent setting defaults off, so removing the old shared opt-out cannot re-enable optional headers.
Explicit provider attribution opt-in never triggers an install report.
Provider identity strings, OpenCode session headers, runtime tracing, and experimental analytics are separate functionality.

A real terminal smoke run opened `/settings`, searched for `attribution`, toggled **Provider attribution** from false to true, closed the selector, and exited.
The setting persisted and the recorded request list remained empty.
The settings selector tests also verify its compact layouts.

## Release checks

The staging client canary now rejects every unexpected startup request, including the former install-report exception.
The earlier [staging acceptance record](client-canaries.md) describes historical behavior before this removal.
This validation uses source clients with controlled HTTP responses; it does not deploy services or publish rebuilt CLI artifacts.
