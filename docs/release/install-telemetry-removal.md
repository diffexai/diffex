# Install telemetry removal

The CLI no longer reports installations or changelog-detected updates to Pi.
This change is based on CLI PR #205 (`feat/staging-version-canaries`).
Inspection of `diffex-cloud` and `diffex-landing` found no install-report ingest implementation to remove.

## Reproduction and regression boundary

Run from `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/install-telemetry-e2e.test.ts
```

The test starts the real source CLI with `--no-session --no-extensions --no-skills` in an isolated 100x30 PTY.
It supplies no provider credentials and intercepts every fetch before network access, with a socket guard for alternate HTTP clients.
Before removal, first install, upgrade, legacy opt-in, provider attribution opt-in, and normal startup attempted an anonymous `GET https://pi.dev/api/report-install?version=0.2.0` with a platform/runtime User-Agent.
Those five regression cases failed on the attempted request before the implementation changed.

After removal, all eight cases pass: first install, upgrade, current checkpoint, legacy opt-in, legacy opt-out, provider attribution opt-in, offline, and startup with version checks enabled.
Only the last case attempts a request, to the canonical Diffex latest-version endpoint.
Changelog acknowledgement still persists the current changelog checkpoint.
Each process exits through `/exit`, and the harness verifies removal of its temporary home, project, settings, and event record.

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
