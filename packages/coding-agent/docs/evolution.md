# Harness Evolution

Diffex can derive workspace-scoped guidance from persisted invocation evidence and store it in immutable harness revisions. A revision can contain `EVOLVE.md` memory and complete evolved skill packages rooted at `skills/<name>/SKILL.md`, including referenced UTF-8 scripts, assets, and documentation. The selected revision changes both together.

## Controls

Use `/evolve` to:

- inspect evidence eligibility and running or completed jobs;
- start, resume, cancel, or browse evolution work;
- inspect memory proposals and their evidence;
- distinguish analysis completion from waiting, retrying, completed, partially failed, or failed candidate generation;
- inspect each skill candidate's registry state, latest transition time and reason, readable supporting and contradicting evidence, textual draft diff, deterministic validation, and retrieval/behavior evaluation when available;
- inspect automatic skill activation after deterministic validation succeeds and any available persisted evaluation is accepted;
- inspect target revisions and roll back an activated evolved skill to its pre-activation revision, even when later descendants preserved it;
- enable or disable future tracing and evolution work.

Accepted skill candidates activate automatically once deterministic validation and any configured retrieval and behavior evaluation finish. Retrieval and behavior evaluation is temporarily skipped when no evaluator is configured; in that case, deterministic structure, provenance, scope, security, and inventory validation still must pass before automatic activation. If harness memory changes after validation, activation automatically rebases the candidate onto the selected revision and preserves its memory. Automatic activation may also rebase over unrelated evolved-skill changes after rechecking the candidate's exact source and target paths; conflicting skill changes remain blocked.

Use `/version` to inspect compatible revisions for the current workspace and select one. Selection validates the complete bundle. A revision with corrupt, unsupported, or workspace-mismatched artifacts is not activated.

## Request boundaries

Harness selection is resolved at prompt admission. A fresh prompt observes the selected revision; in-flight work and already admitted queued messages keep their pinned memory and skill versions. Background candidate validation reads the atomically selected revision directly, so it does not depend on a session reaching its next prompt boundary first. If `/version` changes while an evolution job is running, the job continues from its frozen base and cannot replace the newer selection.

The footer identifies the active harness and shows background evolution activity. `/skills` lists only evolved skills from the active revision whose workspace identity matches the current workspace. Harness selection is workspace-scoped: sessions in the same workspace observe each other's selections at prompt boundaries, while sessions in other workspaces keep their own selected revision.

## Automatic eligibility

When evolution is enabled, automatic work considers only invocation evidence accumulated by the active workspace and requires all of the following:

- at least 400,000 reported input and output tokens from unprocessed assistant messages;
- at least three eligible settled invocations;
- no blocking job;
- a 20-minute cooldown after the previous automatic run.

Each automatic run freezes the oldest unprocessed invocation evidence up to the same 400,000-token trigger threshold, including the complete invocation that reaches or crosses it. This can exceed 400,000 tokens only to preserve that invocation boundary, including when a single invocation exceeds the threshold. Later invocations remain unprocessed. A larger backlog is processed in successive threshold-sized batches after each cooldown, not all at once. A remaining partial batch waits until it reaches 400,000 tokens. The token total is the sum of provider-reported input and output usage shown after assistant responses. It does not estimate serialized evidence size or add cache-read and cache-write usage. Evolution model calls use the configured provider and may consume provider quota. Manual `/evolve` work remains uncapped and uses the same frozen evidence and validation boundaries.

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

Interrupted jobs and candidate work resume from durable checkpoints. Writer retries use stable idempotency keys, leases, exact base revisions, and compare-and-swap selection. Skill rollback follows immutable ancestry to the candidate's application boundary and selects its existing pre-activation revision; it does not mutate historical revisions.

Set `evolution.enabled` to `false` in global settings or use the toggle in `/evolve` to stop future tracing and background/manual evolution controls. Already-running Diffex processes monitor this global setting and stop their trace collectors and evolution workers when another process disables it. Disabling evolution does not unselect the current harness or remove already active evolved skills.
