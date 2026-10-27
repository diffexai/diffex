# Radius removal

Radius must not be used in development, testing, evaluation, or production.
The removal supersedes the older candidate handoff and rehearsal approvals.
Historical JSON evidence remains a record of the original bytes, not an approved release candidate or permission to use Radius.

## Configuration behavior

The common rejection explains that Radius support was removed and requires selecting another provider.
The runtime rejects Radius registrations before changing provider or credential state.
It does not migrate Radius traffic to another provider automatically.

| Existing state or request | Result |
| --- | --- |
| Saved API key, OAuth credential, environment key, or model cache | Remains inactive; no refresh, discovery, authentication, or inference request |
| `providers.radius` in `models.json` | Configuration error naming the entry and file, including configurations without OAuth |
| `oauth: "radius"` under another provider ID | Same configuration error before schema validation or provider composition |
| CLI provider/model selection or Radius model scope | Explicit removal error before inference |
| Saved default provider | Startup fails with instructions to update `defaultProvider` and `defaultModel` in `settings.json` |
| Resumed Radius session | Startup fails with instructions to choose a replacement using `--model provider/model` |
| Auth check or credential printing | Explicit removal error; no Radius credential is exported |
| Extension or SDK provider registration | Rejected, including case variants of the removed provider ID |
| `/login` | Radius absent from both subscription and API-key selectors |
| `/logout` with a saved Radius credential | Local credential deletion remains available without contacting the former service |

Invalid Radius entries invalidate the custom configuration file; built-in providers remain registered.
Unselected stale credentials and caches do not prevent use of supported providers.
See the [user migration steps](../../packages/coding-agent/docs/providers.md#removed-providers).

## Source and artifact review

The built-in provider factory, OAuth implementation and loader, environment-key mapping, provider type, and default-model integration were removed in `3cd84966f`.
`f1a3608e1` closes custom-configuration and registration paths and adds actionable selection errors.
`19d038f8b` adds the archive gate and checks legacy CLI and session behavior.
`27b844ad3` presents expected startup rejections without a Node stack trace.
The generic `diffex-messages` transport remains available for other backends, with neutral local test fixtures.

The remaining source references identify the removed provider for rejection or assert that access is unavailable.
Documentation records migration policy or explicitly superseded historical evidence.
CSS `border-radius` properties are unrelated.
The evaluation configuration and workflows contain no Radius integration.

The distribution checker rejects former provider/OAuth module paths and service, environment-key, or client-registration markers in executable payloads and declarations.
The same inspection applies to bundled internal workspaces and nested archives.
The removal explanation itself is permitted.
Old ignored local build outputs were cleaned and regenerated offline rather than edited manually.

## Validation

Validation uses synthetic credentials, local fixtures, and isolated configuration directories.
No Radius service, real provider credential, paid inference, or live Radius compatibility test is used.

- `npm run check` passes, including identity, dependency, lockfile, TypeScript, and browser checks.
- `./test.sh` passes with provider credentials removed and live E2E tests disabled.
- Focused AI tests cover provider discovery, environment-key removal, registration rejection, and the generic message transport.
- Focused coding-agent tests cover stale credentials/caches, configuration, registration, selection, defaults, resumption, auth commands, both login methods, and local logout cleanup.
- The distribution payload suite passes all 47 tests, including stale modules and markers in renamed or bundled payloads.
- Fresh offline compilation and reviewed packing produce a local tarball that passes payload inspection.
- A clean npm consumer installs that tarball with lifecycle scripts disabled and verifies every runtime hash against the reviewed archive.
- The installed executable passes help, version, model listing, controlled print and terminal prompt/reply, Radius search exclusion in both login methods, and clean exit.
- Installed legacy configuration, defaults, resumed sessions, and auth commands produce the removal explanation.

The terminal fixture answers the logical Diffex version request locally and rejects unexpected provider requests and socket connections.
This establishes removal and local package behavior; it does not publish a release or establish unrelated live-provider compatibility.

The tested runtime source is `27b844ad3` on macOS arm64 with Node 22.19.0 and npm 10.9.3.
The local `0.3.3` tarball contains 1,243 payload files and has SHA-256 `7bacd1bf5fdebb4a0097ad683cf6cf26fc497b0a469df0e72231f318be5bfb71`.
This checksum identifies validation bytes only, not a published replacement for an existing version.
