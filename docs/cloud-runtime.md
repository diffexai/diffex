# Cloud Runtime Boundary

## Purpose

The hosted Diffex product runs the same Pi-derived coding-agent runtime as local Diffex.
It does not use the archived Rust implementation or a cloud-specific prompt loop.

`@diffexai/diffex-server` binds the coding-agent runtime to `@diffexai/diffex-protocol` inside an isolated sandbox.
`@diffexai/diffex-client` connects to that server through a transport supplied by the product.

## Boundary

The cloud control plane authenticates users, allocates sandboxes, enforces policy and billing, and issues short-lived attachment URLs.
It authenticates the WebSocket upgrade before relaying any bytes.

Once connected, the client and in-sandbox server exchange the native length-prefixed CBOR protocol.
The cloud relay preserves byte order, applies backpressure and limits, and does not decode or reinterpret runtime messages.

The WorkOS access token stays at the control-plane boundary.
Provider credentials, sandbox identifiers, and internal runtime addresses never enter the Diffex wire protocol.

The production model credential is mounted through Daytona Secrets with a provider-host allowlist.
Only Daytona's opaque placeholder enters the sandbox environment, and the real provider credential is substituted into outbound HTTPS headers outside the sandbox.

## Runtime Image

`Dockerfile.runtime` produces a Linux amd64 candidate with a digest-pinned Node base image, compiled workspace outputs, user documentation, and legal notices.
The Runtime Image workflow now permits manual validation and retains the tested image privately.
Registry publication and automatic main-branch publication remain disabled.
The owner confirmed on 2026-09-13 that no staging deployment or Daytona consumer is configured, so no existing production digest or snapshot can be assumed.
See [runtime validation and promotion prerequisites](release/runtime-validation.md) for local commands and the pending hosted acceptance.

Before a cloud release, register GHCR with Daytona, create a Daytona snapshot from that exact immutable image tag or digest, and set `DAYTONA_SANDBOX_SNAPSHOT` to the resulting snapshot name.
Do not use a floating image tag for production.
The runtime image and the cloud control-plane release must be promoted as one tested release pair.

## Required Hosted Runtime

The production runtime service must:

- Implement `DiffexServerService` using the real coding-agent session APIs
- Persist and reopen durable sessions using stable cloud-provided session IDs
- Expose an authenticated WebSocket listener suitable for a sandbox
- Publish authoritative protocol snapshots from coding-agent state
- Convert runtime events through the existing protocol adapters
- Reject conflicting session mutations instead of silently queuing them
- Shut down cleanly when the sandbox receives a termination signal

## Compatibility

The REST control-plane API and the live Diffex protocol are independently versioned.
Changing WorkOS, billing, quota, or sandbox-provider implementation must not change the agent protocol.
Changing the agent protocol must use protocol negotiation rather than an implicit cloud API change.
