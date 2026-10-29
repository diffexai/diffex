# Changelog

## [Unreleased]

### Breaking Changes

- Previously released: renamed `PI_CACHE_RETENTION` and `PI_OAUTH_CALLBACK_HOST` to `DIFFEX_CACHE_RETENTION` and `DIFFEX_OAUTH_CALLBACK_HOST`. Update provider configuration and OAuth callback-host overrides ([#2](https://github.com/diffexai/diffex/pull/2)).

### Fixed

- Previously released: preserved Workers AI models in Cloudflare AI Gateway catalog generation when the upstream catalog omits duplicate gateway entries ([#111](https://github.com/diffexai/diffex/pull/111)).
- Fixed ChatGPT compaction failures by omitting unsupported explicit prompt-cache options from both freshly discovered and cached account models ([#302](https://github.com/diffexai/diffex/pull/302)).

## [0.4.0] - 2026-10-27

### Breaking Changes

- Migrated ChatGPT authentication to Diffex app registration; existing users must sign in again. The provider ID remains `openai-codex`.
  See [ChatGPT setup](../coding-agent/docs/providers.md#chatgpt) ([#291](https://github.com/diffexai/diffex/pull/291)).
- Removed Radius from supported provider types and rejected Radius provider registrations and model requests. Replace existing Radius integrations with a supported provider.
  See [Removed providers](../coding-agent/docs/providers.md#removed-providers) ([#290](https://github.com/diffexai/diffex/pull/290), [#292](https://github.com/diffexai/diffex/pull/292)).

### Added

- Added `parseModelCatalog` for validating complete provider catalogs and cache provenance fields on `ModelsStoreEntry` ([#287](https://github.com/diffexai/diffex/pull/287)).
- Added an optional OAuth logout hook for remote session revocation before local credential deletion ([#291](https://github.com/diffexai/diffex/pull/291)).

### Changed

- Migrated model catalog publication to validated, immutable Diffex-hosted revisions.
  See [Model catalog contract](../../docs/model-catalog.md) ([#287](https://github.com/diffexai/diffex/pull/287)).
- Branded OAuth callback pages and default provider request attribution as Diffex while preserving configured attribution overrides ([#288](https://github.com/diffexai/diffex/pull/288)).
- ChatGPT now discovers account-specific models and streams through the public Responses API, with isolated account caches and subscription usage reported without API-key token prices. Saved registrations support later sign-ins; logout attempts remote revocation and clears active tokens.
  See [ChatGPT setup](../coding-agent/docs/providers.md#chatgpt) ([#291](https://github.com/diffexai/diffex/pull/291)).

### Removed

- Removed Radius OAuth, API-key authentication, environment-key resolution, and inference access; saved credentials and cached models cannot restore support ([#290](https://github.com/diffexai/diffex/pull/290), [#292](https://github.com/diffexai/diffex/pull/292)).

## [0.3.3] - 2026-10-26

### Added

- Added GPT-6 Astra, Luna, Sol, and GPT-6.1 Sol to the Codex catalog for ChatGPT authentication.
- Added `isRetryableProviderErrorMessage` for classifying transient provider and transport failures ([#161](https://github.com/diffexai/diffex/pull/161)).

### Changed

- Updated provider SDKs and runtime dependencies ([#272](https://github.com/diffexai/diffex/pull/272), [#273](https://github.com/diffexai/diffex/pull/273), [#274](https://github.com/diffexai/diffex/pull/274)).
- Anthropic requests now omit unsupported sampling parameters, including the unified `temperature` option. Google Gemini and Vertex AI disable automatic SDK continuations; Anthropic context-window limits and Google continuation limits map to `length`.
  See [Provider SDK migration notes](README.md#provider-sdk-migration-notes) ([#273](https://github.com/diffexai/diffex/pull/273)).
- Changed package licensing to MIT ([#280](https://github.com/diffexai/diffex/pull/280)).

### Fixed

- Fixed cancelled authentication and lazy provider setup being reported as errors instead of `aborted` responses.
- Preserved Kimi Coding catalog generation after the upstream source key changed.
- Fixed Google model streaming through OpenCode Go by registering its Google API implementation ([#265](https://github.com/diffexai/diffex/pull/265)).

## [0.3.2] - 2026-09-29

## [0.3.1] - 2026-09-20

## [0.3.0] - 2026-09-20

## [0.2.7] - 2026-09-18

## [0.2.6] - 2026-09-18

## [0.2.5] - 2026-09-17

### Fixed

- Fixed bugs and improved reliability.

## [0.2.4] - 2026-09-15

## [0.2.3] - 2026-09-14

## [0.2.2] - 2026-09-14

### Breaking Changes

- Renamed the package to `@diffexai/diffex-ai`; update dependencies, imports, and Diffex-specific API module references to the new namespace.
