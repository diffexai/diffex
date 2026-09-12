# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the package to `@diffexai/diffex-agent-core`; update dependencies and imports to the Diffex namespace.

### Added

- Added private per-turn continuation context for automatic evolution, keeping its internal prompts out of the user conversation ([#196](https://github.com/diffexai/diffex/pull/196)).

### Changed

- Scoped automatic evolution state, evidence, and accounting to the current workspace so sessions in the same workspace can share the same evolution context.
