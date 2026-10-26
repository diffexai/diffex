# Changelog

## [Unreleased]

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
