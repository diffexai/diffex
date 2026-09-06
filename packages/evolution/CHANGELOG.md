# Changelog

## [Unreleased]

### Added

- Added versioned, workspace-isolated skill score storage with validated harness membership, zero-initialized package versions, and atomic compare-and-swap updates.
- Exposed immutable typed skill-retention defaults shared by output scoring and pre-evolution grooming; retired versions' scores and lifecycle observations remain available for audit.

### Changed

- Reduced the automatic evolution cooldown from 20 minutes to 10 minutes.
- Automatic evolution batches now include the complete invocation that reaches or crosses the token trigger threshold, leaving later evidence for subsequent runs instead of stopping below the threshold.
