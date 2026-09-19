# Changelog

## [Unreleased]

### Added

- Added optional `prepareRequest` hooks for prompt and continuation requests, with persistent context replacement, public state synchronization, and cancellation before provider streaming.

## [0.2.7] - 2026-09-18

## [0.2.6] - 2026-09-18

## [0.2.5] - 2026-09-17

### Fixed

- Fixed bugs and improved reliability.

## [0.2.4] - 2026-09-15

## [0.2.3] - 2026-09-14

## [0.2.2] - 2026-09-14

### Breaking Changes

- Renamed the package to `@diffexai/diffex-agent-core`; update dependencies and imports to the Diffex namespace.

### Added

- Added private per-turn continuation context for automatic evolution, keeping its internal prompts out of the user conversation ([#196](https://github.com/diffexai/diffex/pull/196)).

### Changed

- Scoped automatic evolution state, evidence, and accounting to the current workspace so sessions in the same workspace can share the same evolution context.
