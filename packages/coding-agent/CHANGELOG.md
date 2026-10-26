# Changelog

## [Unreleased]

## [0.3.3] - 2026-10-26

### New Features

- Added GPT-6 Astra, Luna, Sol, and GPT-6.1 Sol to the model list for ChatGPT login.
  See [Providers](docs/providers.md).
- Added cache-preserving harness updates: background memory and evolved-skill changes apply after successful compaction or in a new session, with pending-update notices in the TUI.
  See [Request boundaries](docs/evolution.md#request-boundaries) ([#260](https://github.com/diffexai/diffex/pull/260) by [@Issacboy123](https://github.com/Issacboy123)).
- Retained lessons and evolved skills longer before score-based grooming removes them, while keeping existing capacity limits.
  See [Lesson feedback and grooming](docs/evolution.md#lesson-feedback-and-grooming) and [Private skill feedback](docs/evolution.md#private-skill-feedback).

### Added

- Added GPT-6 Astra, Luna, Sol, and GPT-6.1 Sol to the Codex model list for ChatGPT login.

### Changed

- Deferred background harness memory and evolved-skill updates until successful manual or automatic compaction or a new session, preserving the active conversation's input cache. The TUI announces pending updates; `/clear` starts with the latest revision and `/version` still switches immediately.
  See [Request boundaries](docs/evolution.md#request-boundaries) ([#260](https://github.com/diffexai/diffex/pull/260) by [@Issacboy123](https://github.com/Issacboy123)).
- Retained lessons and evolved skills longer by lowering grooming removal thresholds from -5 to -7 for lessons and from -8 to -11 for skills, without changing capacity limits.
  See [Lesson feedback and grooming](docs/evolution.md#lesson-feedback-and-grooming) and [Private skill feedback](docs/evolution.md#private-skill-feedback).
- Updated provider SDKs and runtime dependencies, including terminal rendering, syntax highlighting, credential storage, and HTTP libraries ([#272](https://github.com/diffexai/diffex/pull/272), [#273](https://github.com/diffexai/diffex/pull/273), [#274](https://github.com/diffexai/diffex/pull/274)).
- Anthropic requests now omit unsupported sampling parameters, including `temperature`. Google Gemini and Vertex AI requests no longer perform automatic SDK continuations; continuation and context-window limits are reported as `length`.
  See [Provider SDK migration notes](../ai/README.md#provider-sdk-migration-notes) ([#273](https://github.com/diffexai/diffex/pull/273)).
- Changed project and package licensing to MIT ([#280](https://github.com/diffexai/diffex/pull/280)).

### Fixed

- Fixed Google model streaming through OpenCode Go by registering its Google API implementation ([#265](https://github.com/diffexai/diffex/pull/265)).
- Fixed failed evolution evidence scans being skipped permanently; bounded retries preserve the failed cursor and expose retry status in `/evolve` ([#258](https://github.com/diffexai/diffex/pull/258) by [@Issacboy123](https://github.com/Issacboy123)).
- Enabled short prompt-cache retention for background evolution model calls ([#259](https://github.com/diffexai/diffex/pull/259) by [@Issacboy123](https://github.com/Issacboy123)).
- Updated vulnerable CLI dependencies, including Undici and Zod, and patched shell-quote in the sandbox extension example ([#262](https://github.com/diffexai/diffex/pull/262), [#272](https://github.com/diffexai/diffex/pull/272), [#274](https://github.com/diffexai/diffex/pull/274), [#281](https://github.com/diffexai/diffex/pull/281)).

## [0.3.2] - 2026-09-29

### New Features

- Added persistent plan context with stable step IDs and optional success criteria, attached to every model request and restored across session resume, compaction, and tree navigation.
  See [Plan Mode](docs/usage.md#plan-mode) ([#249](https://github.com/diffexai/diffex/pull/249)).
- Added parallel tool execution phases that overlap independent calls around sequential tool barriers.
  See [Extensions](docs/extensions.md) ([#250](https://github.com/diffexai/diffex/pull/250)).
- Added a cache hit rate to the interactive footer alongside context usage ([#249](https://github.com/diffexai/diffex/pull/249)).

### Added

- Added persistent plan step identity with stable IDs and optional success criteria, attached as hidden current-task context to every model request and restored across session resume, compaction, and tree navigation.
  See [Plan Mode](docs/usage.md#plan-mode) and [SDK tools](docs/sdk.md#tools) ([#249](https://github.com/diffexai/diffex/pull/249)).
- Added a cache hit rate to the interactive footer alongside context usage ([#249](https://github.com/diffexai/diffex/pull/249)).
- Added parallel tool execution phases that overlap consecutive parallel-capable calls around individual sequential barriers, such as `update_plan`.
  See [Extensions](docs/extensions.md#tool_execution_start--tool_execution_update--tool_execution_end) ([#250](https://github.com/diffexai/diffex/pull/250)).

### Changed

- Excluded plan tool history and saved plan snapshots from compaction and branch summaries; the latest attached snapshot supersedes retained plan context ([#251](https://github.com/diffexai/diffex/pull/251)).

### Fixed

- Fixed plan cache-prefix preservation so ordinary requests reuse the existing prompt prefix ([#249](https://github.com/diffexai/diffex/pull/249)).
- Fixed plan restoration on tree navigation to use the destination branch's authoritative plan snapshot ([#249](https://github.com/diffexai/diffex/pull/249)).
- Fixed settled tool output being remeasured on every keystroke, keeping typing responsive as session history grows ([#249](https://github.com/diffexai/diffex/pull/249)).

## [0.3.1] - 2026-09-20

### New Features

- Added opt-in background services that survive CLI and subagent exit, with explicit environment ownership.
  See [Background process lifetime](docs/background-processes.md) ([#242](https://github.com/diffexai/diffex/pull/242)).

### Added

- Added CLI and SDK options for environment-owned background processes on Linux and macOS, with durable ownership records and inherited policy for child sessions.
  See [Background process lifetime](docs/background-processes.md) ([#242](https://github.com/diffexai/diffex/pull/242)).

### Fixed

- Fixed successful background services being terminated after ownership transfers to the environment, including on later failures, interruption, session replacement, and disposal ([#242](https://github.com/diffexai/diffex/pull/242)).
- Fixed print-mode shutdown to await shared runtime disposal and handle SIGINT cleanup ([#242](https://github.com/diffexai/diffex/pull/242)).

## [0.3.0] - 2026-09-20

### New Features

- Added nonblocking `agent_status` for immediate child-status and result inspection, with automatic coordination for child completion. See [Automatic Sub-agent Coordination](docs/usage.md#automatic-sub-agent-coordination) ([#234](https://github.com/diffexai/diffex/pull/234)).
- Added automatic subagent supervision with renewable work allowances and parent-deadline bounds. See [SDK tools](docs/sdk.md#tools) ([#233](https://github.com/diffexai/diffex/pull/233)).

### Breaking Changes

- Replaced the blocking `wait_for_agents` tool with nonblocking `agent_status`; rely on automatic child-result coordination instead of tool-managed waits ([#234](https://github.com/diffexai/diffex/pull/234)).

### Fixed

- Fixed automatic compaction to check complete tool-result batches ([#233](https://github.com/diffexai/diffex/pull/233)).
- Fixed subagent completion and cancellation, including renewable work-allowance supervision ([#233](https://github.com/diffexai/diffex/pull/233)).
- Fixed session and subagent cancellation to terminate owned background shell processes ([#233](https://github.com/diffexai/diffex/pull/233)).

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
