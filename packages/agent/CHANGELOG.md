# Changelog

## [0.3.3] - 2026-10-26

### Added

- Added explicit runtime telemetry contexts and nested run, turn, request, and tool spans ([#95](https://github.com/diffexai/diffex/pull/95)).

### Changed

- Updated runtime dependencies, including file-ignore matching, schema handling, YAML parsing, and diff generation ([#272](https://github.com/diffexai/diffex/pull/272), [#274](https://github.com/diffexai/diffex/pull/274)).
- Changed package licensing to MIT ([#280](https://github.com/diffexai/diffex/pull/280)).

## [0.3.2] - 2026-09-29

### Added

- Added ordered tool execution phases that run consecutive parallel-capable calls concurrently around individual sequential tool barriers ([#250](https://github.com/diffexai/diffex/pull/250)).

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

- Renamed the package to `@diffexai/diffex-agent-core`; update dependencies and imports to the Diffex namespace.

### Added

- Added private per-turn continuation context for automatic evolution, keeping its internal prompts out of the user conversation ([#196](https://github.com/diffexai/diffex/pull/196)).

### Changed

- Scoped automatic evolution state, evidence, and accounting to the current workspace so sessions in the same workspace can share the same evolution context.
