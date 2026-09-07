# Harness Evolution

Diffex can derive workspace-scoped guidance from persisted invocation evidence and store it in immutable harness revisions. A revision can contain `EVOLVE.md` memory and complete evolved skill packages rooted at `skills/<name>/SKILL.md`, including referenced UTF-8 scripts, assets, and documentation. The selected revision changes both together.

## Controls

Use `/evolve` to:

- inspect evidence eligibility and running or completed jobs;
- select the evolution model, which defaults to the current session model until explicitly set;
- start, resume, cancel, or browse evolution work;
- inspect memory proposals and their evidence;
- distinguish analysis completion from waiting, retrying, completed, partially failed, or failed candidate generation;
- inspect each skill candidate's registry state, latest transition time and reason, readable supporting and contradicting evidence, textual draft diff, deterministic validation, and retrieval/behavior evaluation when available;
- inspect automatic skill activation after deterministic validation succeeds and any available persisted evaluation is accepted;
- inspect target revisions and roll back an activated evolved skill to its pre-activation revision, even when later descendants preserved it;
- enable or disable future tracing and evolution work.

Accepted skill candidates activate automatically once deterministic validation and any configured retrieval and behavior evaluation finish. Retrieval and behavior evaluation is temporarily skipped when no evaluator is configured; in that case, deterministic structure, provenance, scope, security, and inventory validation still must pass before automatic activation. If harness memory changes after validation, activation automatically rebases the candidate onto the selected revision and preserves its memory. Automatic activation may also rebase over unrelated evolved-skill changes after rechecking the candidate's exact source and target paths; conflicting skill changes remain blocked.

Use `/version` to inspect compatible revisions for the current workspace and select one, including skill creation and update revisions that preserve memory. Validated bundles determine membership; missing descriptive metadata produces an unknown-time label rather than hiding a compatible revision. Workspace provenance comes from successful write or activation receipts matched to their workspace, or an unchanged-memory descendant of a compatible revision, and every skill must match the workspace. Merely observing a revision as a local job's input does not establish workspace ownership. Unattributed memory-only revisions cannot be assumed compatible.

The picker orders revisions by recorded activation time (newest first), with unknown times last and revision hashes breaking ties. Skill activation times come from persisted writer receipts. Historical memory receipts use a frozen input timestamp, so memory revisions use their activation checkpoint completion time, falling back to job completion when that checkpoint is unavailable. Immutable bundles are not rewritten to add this information.

Rows show revision hashes, lesson counts, and evolved skill counts. Revision details show memory and the complete skill inventory, including package versions and files. Selecting a revision that removes or changes skills requires confirmation; the preview compares both the shared selection and this session's active skills. Missing comparison contents also require confirmation. Selection validates the complete bundle. Corrupt, unsupported, or workspace-mismatched bundles remain unavailable.

### Candidate and activation states

A proposed skill is a candidate, not a bundle member. An accepted candidate has passed its configured gates but may still await activation. A successfully written bundle can appear before activation, with an unknown activation time. An activation receipt records a historical bundle selection; it does not prove the skill is present in the currently selected revision. `/version` shows the selected bundle's actual contents. Main-job completion does not imply subsequent skill synthesis, validation, or activation has finished; inspect candidate generation and individual candidates in `/evolve` separately.

## Request boundaries

Harness selection is resolved at prompt admission. A fresh prompt observes the selected revision; in-flight work and already admitted queued messages keep their pinned memory and skill versions. Background candidate validation reads the atomically selected revision directly, so it does not depend on a session reaching its next prompt boundary first. If `/version` changes while an evolution job is running, its memory activation continues from the frozen base and cannot replace the newer selection. Separate skill work can still activate a compatible descendant later.

The footer identifies the active harness and shows background evolution activity. `/skills` lists only evolved skills from the active revision whose workspace identity matches the current workspace. Harness selection is workspace-scoped: sessions in the same workspace observe each other's selections at prompt boundaries, while sessions in other workspaces keep their own selected revision.

## Automatic eligibility

When evolution is enabled, automatic work considers only invocation evidence accumulated by the active workspace and requires all of the following:

- at least 400,000 reported input and output tokens from unprocessed assistant messages;
- at least three eligible settled invocations;
- no blocking job;
- a 10-minute cooldown after the previous automatic run.

Each automatic run freezes the oldest unprocessed invocation evidence up to the same 400,000-token trigger threshold, including the complete invocation that reaches or crosses it. This can exceed 400,000 tokens only to preserve that invocation boundary, including when a single invocation exceeds the threshold. Later invocations remain unprocessed. A larger backlog is processed in successive threshold-sized batches after each cooldown, not all at once. A remaining partial batch waits until it reaches 400,000 tokens. The token total is the sum of provider-reported input and output usage shown after assistant responses. It does not estimate serialized evidence size or add cache-read and cache-write usage. Evolution model calls use the current session model unless a model is explicitly selected in `/evolve`; the explicit selection stays fixed across later session-model switches and may consume that provider's quota. Manual `/evolve` work remains uncapped and uses the same frozen evidence and validation boundaries.

## Lesson feedback and grooming

After each completed assistant output with active evolution memory, a private continuation asks only which used lessons were helpful or harmful. Valid reports score helpful +1, harmful -1.5, and omitted lessons -1; a valid empty report scores every eligible lesson -1. Failed or invalid reports change no scores. Reports stay out of conversation history, extension events, exports, compaction, traces, and evolution snapshots.

Scores start at 0, persist per workspace, and apply atomically once per session/output. REPLACE creates a new lesson identity at 0; removed or superseded identities stop accruing points. `DEFAULT_LESSON_POLICY` and `LessonPolicy` in `packages/evolution/src/lesson-score-store.ts` expose the shared typed defaults, not per-session settings. Scores never appear in EVOLVE.md or model prompts.

Before an eligible automatic or manual run freezes its input, Diffex grooms the selected revision's lessons, skipping grooming when its memory is empty. Lessons with scores at or below -5 are removed first; if more than 12 remain, the lowest-scoring lessons are removed until 12 remain. Equal scores remove earlier lessons first. This maintenance includes manual lessons, verifies their content digests, and compacts lesson numbering through the memory writer. Below these limits, the selected revision is unchanged.

The job snapshots the post-groom revision, including its evolved skills, rather than the session's pinned revision. In-flight prompts remain pinned; the next prompt observes the selected revision. The `/evolve` Browse view shows **Reorganizing lessons** during grooming.

## Private skill feedback

After each completed assistant output with workspace-matching evolved skills, a separate private continuation uses the existing system prompt and conversation to request only helpful/harmful judgments on skills used. It shares the lesson-report transport without sharing assessment exchanges. Reports are validated against the workspace, revision, package identities, and exposed skill names/aliases captured before that output. Installed, unknown, ambiguous, duplicate, or malformed references invalidate the whole report.

Skill reports never enter conversation history, extension events, exports, compaction, durable traces, lifecycle observations, or evolution snapshots. Valid reports score helpful +1, harmful -1.5, and every omitted active evolved skill -1. A valid empty report scores every eligible skill -1; failed, missing, or invalid reports change no scores. Explicit and inferred scores commit atomically once per session/output, independently of lesson reports.

Only output-bound package identities still present in the selected workspace revision accrue points. Updated packages start at 0, retired packages stop accruing, and installed skills are never scored. Scores never modify skill artifacts.

Before an eligible automatic or manual run freezes its input, skill grooming removes workspace-matching evolved skills at or below -8 points, then removes the lowest-scoring survivors until at most 10 remain. Equal scores are ordered by skill ID. Removals verify the frozen package version and content digest and use the skill writer's staging and activation path without candidate evaluation. Installed skills and other workspaces are untouched; historical revisions, scores, and lifecycle observations remain available for audit. Below these limits grooming does not advance the selection. The job freezes the post-groom revision and skill catalog; the next prompt observes that selection while admitted prompts remain pinned.

## Validation and security

Source traces, tool output, files, and generated drafts are treated as untrusted data. Deterministic validation checks structure, provenance, workspace scope, immutable versions, the closed package inventory, portable paths, local-reference resolution, aggregate size limits, and bounded sensitive-data rules. Retrieval and behavioral evaluation remain separate capabilities but are temporarily skipped when the runtime has no evaluator.

These checks do not prove semantic safety and are not a sandbox. When evaluation is skipped, Diffex has not verified retrieval quality, behavior improvement, misapplication, or regressions. Review candidate supporting and contradicting evidence, draft diffs, validation issues, and any available evaluation results before activation. See [Security](security.md).

## Storage and recovery

Evolution state is stored beneath the effective agent directory:

- `evolution-workspaces/<workspace-id>/traces/` contains immutable invocation evidence intervals for one workspace;
- `evolution-workspaces/<workspace-id>/evolution/` contains that workspace's jobs, artifacts, candidate history, observations, receipts, and recovery state;
- `evolution-workspaces/<workspace-id>/evolution-failures/` contains that workspace's failure reports;
- `harness-state/versions/` contains shared immutable revisions;
- `harness-state/selections/` contains independent selected pointers keyed by workspace identity.

Sessions resolved to the same workspace identity share evidence totals, jobs, candidates, and harness selection. Different workspace identities never contribute traces, invocation counts, token totals, or jobs to each other. A process that switches to a session in another workspace rotates its trace destination before attaching the replacement session.

The evolution persistence API also provides `skill-scores/` ledgers, partitioned by evolution scope and exact workspace identity. Registration takes a validated harness bundle and includes only its workspace-matching evolved skills, never installed skills. Totals follow the skill ID, package version, and content digest across unrelated harness revisions; changed packages start at 0 and superseded totals remain available for audit. Writes validate revision membership and use atomic compare-and-swap updates. Schema version 2 retains applied output keys alongside totals for replay protection across restarts and concurrent sessions. Scoring holds harness selection stable until commit. Grooming uses compare-and-swap activation and refuses to rebase a scored removal onto a concurrently changed selection.

Interrupted jobs and candidate work resume from durable checkpoints. Writer retries use stable idempotency keys, leases, exact base revisions, and compare-and-swap selection. Skill rollback follows immutable ancestry to the candidate's application boundary and selects its existing pre-activation revision; it does not mutate historical revisions.

Set `evolution.enabled` to `false` in global settings or use the toggle in `/evolve` to stop future tracing and background/manual evolution controls. Already-running Diffex processes monitor this global setting and stop their trace collectors and evolution workers when another process disables it. Disabling evolution does not unselect the current harness or remove already active evolved skills.
