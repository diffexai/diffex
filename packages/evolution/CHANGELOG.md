# Changelog

## [Unreleased]

### Added

- Added a versioned, scope-local lesson score ledger with active revision catalogs, zero-default point reads, validated atomic writes, and compare-and-swap updates.

### Changed

- Reduced the automatic evolution cooldown from 20 minutes to 10 minutes.
- Automatic evolution batches now include the complete invocation that reaches or crosses the token trigger threshold, leaving later evidence for subsequent runs instead of stopping below the threshold.
