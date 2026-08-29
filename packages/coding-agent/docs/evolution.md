# Harness Evolution

Diffex can derive workspace-scoped guidance from persisted invocation evidence and store it in immutable harness revisions. A revision can contain `EVOLVE.md` memory and evolved `skills/<name>/SKILL.md` artifacts. The selected revision changes both together.

## Controls

Use `/evolve` to:

- inspect evidence eligibility and running or completed jobs;
- start, resume, cancel, or browse evolution work;
- inspect memory proposals and their evidence;
- inspect skill-candidate provenance, textual draft diffs, deterministic validation, and retrieval/behavior evaluation;
- activate a skill candidate only after its persisted evaluation is accepted;
- inspect target revisions and roll back an activated evolved skill to its immutable parent revision;
- enable or disable future tracing and evolution work.

Skill activation always requires explicit confirmation. Automatic skill activation is not enabled. Candidates that have not passed every required gate remain read-only.

Use `/version` to inspect compatible revisions for the current workspace and select one. Selection validates the complete bundle. A revision with corrupt, unsupported, or workspace-mismatched artifacts is not activated.

## Request boundaries

Harness selection is resolved at prompt admission. A fresh prompt observes the selected revision; in-flight work and already admitted queued messages keep their pinned memory and skill versions. Background candidate validation reads the atomically selected revision directly, so it does not depend on a session reaching its next prompt boundary first. If `/version` changes while an evolution job is running, the job continues from its frozen base and cannot replace the newer selection.

The footer identifies the active harness and shows background evolution activity. `/skills` lists only evolved skills from the active revision whose workspace identity matches the current workspace.

## Automatic eligibility

When evolution is enabled, automatic work requires all of the following:

- more than 1,000,000 estimated unprocessed evidence tokens;
- at least three eligible settled invocations;
- no blocking job;
- a 20-minute cooldown after the previous automatic run.

Evolution model calls use the configured provider and may consume provider quota. Manual `/evolve` work uses the same frozen evidence and validation boundaries.

## Validation and security

Source traces, tool output, files, and generated drafts are treated as untrusted data. Deterministic validation checks structure, provenance, workspace scope, immutable versions, inventory, and bounded sensitive-data rules. Retrieval and behavioral evaluation are separate gates.

These checks do not prove semantic safety and are not a sandbox. Review candidate provenance, draft diffs, validation issues, and evaluation results before activation. See [Security](security.md).

## Storage and recovery

Evolution state is stored beneath the effective agent directory:

- `traces/` contains immutable invocation evidence intervals;
- `evolution/` contains jobs, artifacts, candidate history, observations, receipts, and recovery state;
- `evolution-failures/` contains failure reports;
- `harness-state/` contains immutable revisions and the selected pointer.

Interrupted jobs and candidate work resume from durable checkpoints. Writer retries use stable idempotency keys, leases, exact base revisions, and compare-and-swap selection. Rollback selects an existing immutable parent; it does not mutate historical revisions.

Set `evolution.enabled` to `false` in global settings or use the toggle in `/evolve` to stop future tracing and background/manual evolution controls. Already-running Diffex processes monitor this global setting and stop their trace collectors and evolution workers when another process disables it. Disabling evolution does not unselect the current harness or remove already active evolved skills.
