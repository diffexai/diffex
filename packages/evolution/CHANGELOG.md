# Changelog

## [Unreleased]

### Added

- Added a versioned, scope-local lesson score ledger with active revision catalogs, zero-default point reads, validated atomic writes, and compare-and-swap updates.
- Added a workspace-isolated evolved-skill score ledger with validated revision catalogs, atomic compare-and-swap writes, and zero-default scores for new package versions while retaining superseded totals.
- Added atomic sparse skill-report scoring with neutral inference, durable output replay protection, and exclusion of retired or superseded packages.

### Changed

- Reduced the automatic evolution cooldown from 20 minutes to 10 minutes.
- Automatic evolution batches now include the complete invocation that reaches or crosses the token trigger threshold, leaving later evidence for subsequent runs instead of stopping below the threshold.
