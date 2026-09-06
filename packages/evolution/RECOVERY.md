# Evolution Recovery

Evolution recovery preserves the frozen evidence range, immutable artifacts, append-only ledger history, and selected harness pointer.
Recovery never treats partial output as completed work and never feeds evolution telemetry back into the evidence corpus.

## Recovery matrix

| Durable state | Detection | Recovery action | Safety invariant |
| --- | --- | --- | --- |
| Queued or active job with an expired scope lease | Startup finds an active manifest whose lease cannot be renewed. | Mark the job interrupted and require an explicit resume. | Resume uses the original input snapshot and evidence high-water cursor. |
| Interrupted snapshot, reflection, curation, validation, write, or activation | The manifest remains at the incomplete stage and has no checkpoint for that stage. | Resume the same stage with its stable idempotency key. | Completed checkpoints and their artifacts are not recomputed. |
| Interrupted Reflector model or slice-tool call | The abort signal revokes the tool registry and the node has no completion checkpoint. | Retry the logical call with the same node and stage idempotency key. | A node becomes visible only after its node and lesson artifacts are durable. |
| Retryable provider or stage failure | The manifest records `retryable-failed`, a reason, and a retry time. | Resume after the retry time or through the explicit recovery control. | The processed-evidence cursor does not advance. |
| Terminal validation, schema, or artifact failure | The manifest records `terminal-failed` and retains the frozen range. | Inspect the failure, then supersede or administratively resolve the job before creating overlapping work. | Invalid or incompatible state cannot be executed. |
| Corrupt or incompatible trace | Materialization fails for one trace while later traces remain discoverable. | Quarantine that trace from successful materializations and continue with valid evidence. | A failed materialization cannot erase or renumber valid later evidence. |
| Trace arriving after a frozen snapshot | Its creation-order cursor is above the job high-water cursor. | Leave it for a later job. | Resume cannot change the meaning of the existing job. |
| Concurrent manual or automatic trigger | Scope leasing or an existing open job blocks duplicate creation. | Attach the command to the durable active job when it becomes visible. | One scope has at most one overlapping active evidence consumer. |
| Operator cancels an active round | Worker shutdown settles active work before cancellation acquires the scope lease. | Resolve the round as cancelled and hide it from browse, view, and resume while retaining its immutable artifacts and ledger. | The processed-evidence cursor does not advance, so the same tokens and invocations remain eligible for a fresh round. |
| Stale scope or Writer owner | A newer lease fence replaces the expired lease. | Reject all writes from the stale fence and let the current owner continue. | A stale process cannot save a manifest, advance a cursor, or activate a harness. |
| Writer failure before candidate publication | The writing stage has no durable successful receipt. | Retry writing with the same batch hash and operation IDs. | The selected harness and EVOLVE.md remain unchanged. |
| Activation failure after candidate staging | The candidate receipt exists but no activation receipt or checkpoint exists. | Retry activation with the same candidate and expected base revision. | The delta is not applied twice. |
| Harness selection changes during a running job | `/version` selects a revision other than the job's frozen base. | Load the frozen base directly, save the evolved child on that lineage, and select it only if the frozen base is still current. | A harness toggle cannot rebase or invalidate evolution, and a newer user selection remains selected. |
| Cursor committed but completion manifest write failed | The final stage checkpoint remains durable and cursor commit is idempotent. | Retry completion against the same job and committed cursor. | Completion creates one logical terminal record. |
| Ledger append retried | The same event ID and byte-identical content already exist. | Treat the append as successful. | Reusing an event ID with different content is corruption. |
| Rollback selection conflict | The selected harness changed after the rollback confirmation. | Reject the rollback and refresh the available action from current harness state. | Rollback never replaces an unexpected selected revision. |
| Successful rollback selection | The recorded immutable parent is still present and the evolved revision is current. | Select the parent with compare-and-swap and refresh on the next prompt boundary. | Existing in-flight prompts stay pinned to their admitted revision. |
| Unsupported skill or orchestration target | The target registry has no enabled writer route. | Preserve the finding as deferred evidence with no executable payload. | Disabled target kinds cannot reach filesystem mutation or activation. |
| Interrupted skill-candidate consolidation | A completed evolution job has checkpointed candidates but no completed candidate-work event. | Resume from append-only registry events with the same source-job idempotency key; repair missing scores or transitions before completion. | Candidate proposal revisions remain immutable, retries do not add recurrence, and partial registry appends cannot activate a skill. |
| Interrupted or failed skill synthesis, validation, evaluation, write, or activation | A qualified group is missing the next immutable artifact or transition, an accepted candidate has a durable write without a matching activation, or synthesis returned a non-retryable error other than context pressure or exhausted its identity-scoped attempts. | Resume recoverable work with revision-bound idempotency keys; reuse recorded artifacts and receipts, repair the missing transition, and record terminal synthesis as `synthesis-failed` until a new proposal revision changes its synthesis identity. | Only transient provider or transport synthesis failures are retried, attempts follow the synthesis identity across source jobs, terminal groups do not block later qualified groups, only deterministically valid drafts enter evaluation, only accepted evaluations reach the writer, and retries cannot stage or activate a skill twice. |
| Skill synthesis context pressure | Request diagnostics identify an oversized request digest for the current capsule and model limits. | Park the group as evidence-qualified, continue later groups, and retry only after capsule or model-capability change. | The known oversized identity is not submitted again under unchanged limits, context pressure does not consume transient retry attempts, and context pressure alone never becomes terminal `synthesis-failed`. |

## Skill score storage

`FileEvolutionPersistence` keeps mutable schema-v1 rows in `<root>/skill-scores/`, beside `skill-observations/`. Filenames hash the evolution scope, workspace (`repositoryId` and optional `directoryId`), skill ID, package version, and entrypoint content digest. Missing directory identity is distinct from every named directory.

`loadSkillScores(harnessState, revision)` validates the exact immutable harness bundle and returns only its evolved skills matching the requested workspace, initializing missing subjects at zero. Installed skills never enter this inventory. Unchanged packages share a balance across harness revisions; changing the entrypoint or any package file creates a new zero-valued subject. Superseded and retired subjects remain stored without affecting other versions. Loading an old revision reads retained balances, not a historical point-in-time snapshot.

Each row contains `schemaVersion`, `scope`, `workspace`, `harnessRevision`, `skillId`, `packageVersion`, `contentDigest`, `points`, and nullable `lastOutputIdempotencyKey`. `harnessRevision` records initialization or the last score update, not the latest revision queried. Updates bind the revision pinned to the output; they do not consult the selected pointer, which may have advanced while a request was in flight.

`saveSkillScore(harnessState, next, expected)` verifies exact workspace/version membership and atomically replaces a balance only if the stored row still equals `expected`. A stale or uninitialized row returns `conflict`. Each update requires a new non-empty output key. The existing cross-process persistence lock and atomic rename protect initialization and writes. Invalid schemas, malformed rows, mismatched filename identities, and symbolic-link rows are rejected rather than reset.

This is storage only: no model feedback, weights, neutral decay, or grooming runs yet. The last output key and compare-and-swap prevent stale overwrites but are not a complete per-output replay ledger or an atomic multi-skill report transaction. Those guarantees belong to the later scoring implementation. Scores never modify harness artifacts, lifecycle observations, snapshots, or evidence.

## Operational observability

Job detail derives queue age, stage latency, evidence-token load, Reflector model and tool budget charges, slice coverage, proposal dispositions, activation conflicts, rollback availability, and recovery attempts from durable checkpoints and ledger events.
Provider cost is shown as unavailable because provider usage is not yet recorded durably for evolution calls.
An unavailable cost value must never be interpreted as zero cost.
These operational records remain outside materialized product-runtime evidence, so the pipeline cannot learn from its own execution telemetry.

## Verification boundaries

Deterministic validation proves provenance, recurrence, immutable closure, score bounds, structural eligibility, workspace and version freshness, and bounded sensitive-data checks.
Candidate priority scoring separately orders evaluation work; it cannot skip later gates, accept a candidate, or activate a skill.
It does not prove semantic usefulness, that natural-language evidence entails a proposal, or the absence of all semantically unsafe guidance.
Skill lifecycle observations and reports remain outside harness content and can recommend a new candidate cycle after activation. Automatic regression rollback is intentionally outside this recovery contract.
