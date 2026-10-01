# @diffexai/diffex-coding-agent-server

Production service adapter between the Diffex coding-agent runtime and `@diffexai/diffex-server`.

The hosted control plane allocates one cloud session per sandbox and passes its stable session ID to this service.
Protocol clients attach to that existing session rather than creating an unrelated runtime identity.

This package owns coding-agent snapshot projection and runtime lifecycle integration.
It does not own WorkOS authentication, billing, cloud policy, sandbox allocation, or public attachment credentials.

## Runtime process

The `diffex-runtime-server` executable starts the service with an authenticated WebSocket listener.
The cloud bootstrap supplies `DIFFEX_SESSION_ID`, `DIFFEX_WORKSPACE`, and an internal `DIFFEX_RUNTIME_SHARED_SECRET` of at least 32 bytes.
It also supplies `DIFFEX_MODEL_PROVIDER`, `DIFFEX_MODEL_ID`, `DIFFEX_MODEL_MAX_OUTPUT_TOKENS`, `DIFFEX_MODEL_GATEWAY_URL`, and `DIFFEX_MODEL_GATEWAY_CREDENTIAL`.
The gateway credential authorizes only this cloud session's model calls and is removed from the process environment after the in-memory transport is configured.
The process rejects a direct provider API key and uses a single configured Anthropic model.
Before each model request, the transport persists its operation UUID and request digest in a private directory under `DIFFEX_RUNTIME_STATE_DIR`.
Provider and agent retries are disabled for gateway failures, including timeouts and dropped streams, because automatically starting another generation could duplicate an already dispatched operation.
Pending operation metadata survives restart for diagnostics without replaying the original request.
Completed model usage is written to a durable sandbox outbox before it is reported to `DIFFEX_USAGE_ENDPOINT`.
These sandbox usage reports are telemetry; the cloud gateway owns authoritative token measurements.
Public WorkOS tokens and cloud attachment tickets are consumed by the control plane and are never passed to this process.
