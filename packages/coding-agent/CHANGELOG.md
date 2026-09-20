# Changelog

## [Unreleased]

### Fixed

- Check the reserve budget before every normal model request, preserving pending inputs and complete tool batches through durable compaction without replaying the run.
- Bound unsuccessful proactive compaction to one operation per logical run, warn before continuing, and preserve independent cancellation, manual compaction, and failed-response recovery.
- Unified pre-prompt, post-answer, and displayed context estimates, using local estimates when provider usage no longer applies after compaction or context changes.
- Show compaction warnings alongside valid summaries or specific cancellation reasons, and write plain text warnings to stderr without changing successful answer output.

## [0.2.7] - 2026-09-18

### Fixed

- Improved stability and fixed UI issues.

## [0.2.6] - 2026-09-18

### Fixed

- Fixed bugs and improved stability.

## [0.2.5] - 2026-09-17

### Fixed

- Fixed bugs and improved reliability.

## [0.2.4] - 2026-09-15

## [0.2.3] - 2026-09-14

### New Features

- Added a streamlined interactive transcript and compact dialogs for clearer conversation and activity states ([#166](https://github.com/diffexai/diffex/pull/166) by [@jefft72](https://github.com/jefft72)).
- Added an animated Diffex welcome sequence at interactive startup ([#167](https://github.com/diffexai/diffex/pull/167) by [@jefft72](https://github.com/jefft72)).
- Added a responsive interactive layout with adaptive editor and footer sizing, compact queued-message summaries, and a recoverable small-terminal view. See [Interactive Mode](docs/usage.md#interactive-mode) ([#168](https://github.com/diffexai/diffex/pull/168) by [@jefft72](https://github.com/jefft72)).

### Fixed

- Fixed startup changelog previews to show only entries not previously seen.

## [0.2.2] - 2026-09-14

### Breaking Changes

- Renamed the CLI package to `@diffexai/diffex` and the executable, configuration directory, environment variables, and public branding from Pi to Diffex.
  Update automation and extensions to use the Diffex names.
- Moved thinking-level selection from settings to the model-selection flow.
  Custom settings integrations must stop passing `thinkingLevel`, `availableThinkingLevels`, and `onThinkingLevelChange`.

### Added

- Added the `diffex` launcher and branded interactive startup experience.
- Added automatic sub-agent coordination with child sessions, lifecycle controls, `/subagents` inspection, branch-aware provenance, durable persistence, and child-to-parent escalation reports.
  See [Automatic Sub-agent Coordination](docs/usage.md#automatic-sub-agent-coordination).
- Added the built-in `update_plan` checklist tool with sequential lifecycle updates, durable branch-local state, and restoration after opening, resuming, or compacting a session ([#52](https://github.com/diffexai/diffex/pull/52) by [@Issacboy123](https://github.com/Issacboy123), [#53](https://github.com/diffexai/diffex/pull/53) by [@Issacboy123](https://github.com/Issacboy123), [#54](https://github.com/diffexai/diffex/pull/54) by [@Issacboy123](https://github.com/Issacboy123), [#55](https://github.com/diffexai/diffex/pull/55) by [@Issacboy123](https://github.com/Issacboy123)).
- Added syntax-highlighted edit diffs, a color-coded footer, and animated working-status feedback.
- Added explicit skill selection plus versioned evolved skills and operator controls.
  See [Skills](docs/skills.md#evolved-skills) and [Harness Evolution](docs/evolution.md#controls).
- Added automatic harness evolution with workspace-scoped evidence, invocation tracing, private continuation context, candidate validation, activation, and lesson and skill grooming.
  See [Harness Evolution](docs/evolution.md).
- Added Diffex account device authentication through `/login` and `diffex auth`.
- Added interactive Plan mode with trusted read-only tools, structured questions, strict final-plan output, branch-local persistence, and same-session implementation handoff.
  See [Plan Mode](docs/usage.md#plan-mode) ([#180](https://github.com/diffexai/diffex/pull/180) by [@Issacboy123](https://github.com/Issacboy123), [#181](https://github.com/diffexai/diffex/pull/181) by [@Issacboy123](https://github.com/Issacboy123), [#182](https://github.com/diffexai/diffex/pull/182) by [@Issacboy123](https://github.com/Issacboy123), [#184](https://github.com/diffexai/diffex/pull/184) by [@Issacboy123](https://github.com/Issacboy123), [#185](https://github.com/diffexai/diffex/pull/185) by [@Issacboy123](https://github.com/Issacboy123), [#186](https://github.com/diffexai/diffex/pull/186) by [@Issacboy123](https://github.com/Issacboy123)).
- Added model-specific thinking-level selection after `/model` and Ctrl+L model selection ([#197](https://github.com/diffexai/diffex/pull/197) by [@Issacboy123](https://github.com/Issacboy123)).
- Added Diffex visual foundations for editor framing, loaders, Markdown, and settings lists ([#165](https://github.com/diffexai/diffex/pull/165) by [@jefft72](https://github.com/jefft72)).
- Added conversation structure and response-path components for interactive transcripts ([#171](https://github.com/diffexai/diffex/pull/171) by [@jefft72](https://github.com/jefft72), [#172](https://github.com/diffexai/diffex/pull/172) by [@jefft72](https://github.com/jefft72)).

### Changed

- Simplified the startup intro and added a startup changelog preview ([#10](https://github.com/diffexai/diffex/pull/10), [#11](https://github.com/diffexai/diffex/pull/11)).
- Updated Diffex font and Markdown color palettes and unified themed interface styles.
- Lowered the automatic evolution eligibility threshold, based eligibility on provider-reported usage, and bounded background work to protect active sessions.
- Restricted approved public distribution to npm packages.
  Standalone binaries, hosted runtime publication, and secondary installation channels remain deferred pending redistribution review.
- Removed install reporting from update and provider flows.

### Fixed

- Fixed OpenAI and DeepSeek tool-schema compatibility.
- Fixed sub-agent cancellation, hook-policy enforcement, branch provenance, prompt URL metadata, and stale-record recovery.
- Fixed automatic evolution recovery, retry classification, evidence handling, cancellation, and legacy-record compatibility.
- Fixed Plan implementation handoffs that could bypass awaited hooks, retain stale offers, or accept busy sessions ([#188](https://github.com/diffexai/diffex/pull/188) by [@Issacboy123](https://github.com/Issacboy123)).
- Fixed self-update checks and targets to use the authoritative Diffex package version and pinned package-manager commands.
- Fixed live response-path state, compact selectors, redraws, and slash-command completion ([#173](https://github.com/diffexai/diffex/pull/173) by [@jefft72](https://github.com/jefft72), [#174](https://github.com/diffexai/diffex/pull/174) by [@jefft72](https://github.com/jefft72), [#175](https://github.com/diffexai/diffex/pull/175) by [@jefft72](https://github.com/jefft72)).
- Fixed Markdown rendering that exposed source delimiters, cursor blinking while unfocused, and panel flicker while streaming.

### Removed

- Removed the legacy Plan-mode extension example after the built-in workflow superseded it.
- Removed inherited provider affiliation and residual product identities from user-facing surfaces.
