# Changelog

## [Unreleased]

### Breaking Changes

- Renamed the package to `@diffexai/diffex-tui`; update dependencies and imports to the Diffex namespace.

### Added

- Added Diffex visual foundations for editor framing, loaders, Markdown, and settings lists ([#165](https://github.com/diffexai/diffex/pull/165) by [@jefft72](https://github.com/jefft72)).
- Added conversation structure and response-path components for interactive transcripts ([#171](https://github.com/diffexai/diffex/pull/171) by [@jefft72](https://github.com/jefft72), [#172](https://github.com/diffexai/diffex/pull/172) by [@jefft72](https://github.com/jefft72)).
- Added an animated working-status indicator.

### Changed

- Simplified the startup intro and added a startup changelog preview ([#10](https://github.com/diffexai/diffex/pull/10), [#11](https://github.com/diffexai/diffex/pull/11)).
- Updated Diffex font and Markdown color palettes.

### Fixed

- Fixed Markdown rendering that exposed source delimiters.
- Fixed cursor blinking while the terminal is unfocused and panel flicker while streaming.
- Fixed live response-path state, compact selectors, redraws, and slash-command completion ([#173](https://github.com/diffexai/diffex/pull/173) by [@jefft72](https://github.com/jefft72), [#174](https://github.com/diffexai/diffex/pull/174) by [@jefft72](https://github.com/jefft72), [#175](https://github.com/diffexai/diffex/pull/175) by [@jefft72](https://github.com/jefft72)).
