# @diffexai/diffex-coding-agent-server

Production service adapter between the Diffex coding-agent runtime and `@diffexai/diffex-server`.

The hosted control plane allocates one cloud session per sandbox and passes its stable session ID to this service.
Protocol clients attach to that existing session rather than creating an unrelated runtime identity.

This package owns coding-agent snapshot projection and runtime lifecycle integration.
It does not own WorkOS authentication, billing, cloud policy, sandbox allocation, or public attachment credentials.

## Runtime process

The `diffex-runtime-server` executable starts the service with an authenticated WebSocket listener.
The cloud bootstrap supplies `DIFFEX_SESSION_ID`, `DIFFEX_WORKSPACE`, and an internal `DIFFEX_RUNTIME_SHARED_SECRET` of at least 32 bytes.
It also supplies `DIFFEX_MODEL_PROVIDER`, `DIFFEX_MODEL_ID`, and `DIFFEX_MODEL_API_KEY` through the sandbox provider's secret-injection mechanism.
The environment value is an opaque Daytona placeholder, the real provider key never enters the sandbox, and the placeholder is removed from the runtime process environment after the in-memory model client is configured.
Completed model usage is written to a durable sandbox outbox before it is reported to `DIFFEX_USAGE_ENDPOINT`.
Public WorkOS tokens and cloud attachment tickets are consumed by the control plane and are never passed to this process.
