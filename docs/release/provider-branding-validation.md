# Provider branding validation

Diffex controls the local callback presentation and default application attribution.
Registered OAuth client IDs, provider consent pages, authentication protocols, stored credentials, inference endpoints, and payloads remain unchanged.
The separate Diffex account feature and Radius implementation are excluded.

## Implemented defaults

| Integration | Branding |
| --- | --- |
| OpenAI Codex | Authorization and inference `originator=diffex`; native `diffex (<platform> <release>; <arch>)` and browser `diffex (browser)` User-Agent |
| xAI | Device authorization `referrer=diffex` |
| OpenRouter | `HTTP-Referer: https://diffex.ai`, `X-OpenRouter-Title: Diffex` |
| NVIDIA NIM | `X-BILLING-INVOKE-ORIGIN: Diffex` |
| Cloudflare Workers AI / AI Gateway | `User-Agent: diffex-coding-agent` |
| OpenCode / OpenCode Go | `x-opencode-client: diffex` with the existing session header |

Optional attribution still defaults off and honors `DIFFEX_PROVIDER_ATTRIBUTION`.
OpenCode session attribution remains independent of that setting and requires a session ID.
Explicit header overrides and `null` removal take precedence over branding defaults, including Codex originator and User-Agent.

Codex, Anthropic, and OpenRouter callbacks use the Diffex four-loop mark and an inline pixel-art background based on the entrance animation's boat.
Success pages ask users to close the tab and return to Diffex without claiming credential persistence.
Handled errors use safe explanations instead of displaying raw provider responses.
Callback routes, validation, HTTP status codes, and response timing are preserved.

## Offline verification

A controlled Node capture used the actual login implementations and loopback callback servers with synthetic authorization codes and mocked token endpoints before changing presentation.
The baseline exposed provider-specific success claims on all three callbacks.
The updated pages were inspected in a browser at 375px and 1280px widths for success and error states, including spacing, contrast, wrapping, and horizontal overflow.
No real credentials or provider calls were used.

Focused Vitest checks pass for callback presentation, Codex authorization and SSE/WebSocket streaming, Anthropic and OpenRouter OAuth, xAI polling and refresh, shared device polling, Copilot and Kimi OAuth, attribution merging, SDK attribution dispatch, and the provider selector.
The callback tests verify unchanged client IDs, scopes, redirect URIs, endpoints, PKCE, validation, and exchange timing.
Attribution tests cover enabled and disabled settings, environment overrides, configured and caller headers, explicit `null` removal, custom providers, and requests with and without session IDs.
A browser-bundled Codex stream also completed against a mock with `process` absent and the expected `diffex (browser)` User-Agent.

`npm run check` passes, including the runtime identity inventory and browser bundle smoke check.
The inventory retains four occurrences across three documented exceptions: the Radius client ID, the Radius gateway, and two occurrences in the original DOOM integration credit.
The audit found no inherited Pi application labels in other built-in provider login implementations or shared login UI.
Provider protocol labels such as GitHub Copilot and Claude CLI headers remain unchanged.

## Pending live compatibility checks

No authorized provider accounts were used for live validation in this implementation session.
Mock results do not establish provider compatibility.
No exact provider rejection was observed; the following checks remain pending before release.

| Integration | Required live checks | Status |
| --- | --- | --- |
| OpenAI Codex | Browser and device login, stored credential reuse and refresh, SSE and WebSocket inference | Pending |
| xAI | Device authorization with the new referrer, polling, stored credential reuse and refresh, inference | Pending |
| OpenRouter | Login, stored API-key reuse, inference with optional attribution enabled | Pending |
| NVIDIA NIM | Authenticated inference with `X-BILLING-INVOKE-ORIGIN: Diffex` and existing credentials | Pending; acceptance of the new value is unresolved |
| Cloudflare Workers AI / AI Gateway | Inference with each integration's existing credentials and optional attribution enabled | Pending |
| OpenCode / OpenCode Go | Inference with existing credentials and session/client attribution | Pending |

Any rejection must be recorded with its exact incompatibility before claiming provider compatibility.
Do not resolve a branding incompatibility by changing OAuth registration, authentication protocols, or inference routing.
