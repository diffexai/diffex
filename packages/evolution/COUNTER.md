# Counter Reservation

## Pipeline boundary

The eventual topology is `traces + current memory -> Counter`, followed by `traces + CounterReport -> Reflector -> Curator -> deterministic Validator -> Writer`.
The pipeline already owns a pre-reflection checkpoint and accepts an optional `PreReflectionStage` implementation at that boundary.
The current default is `DisabledPreReflectionStage`.

The disabled stage returns no report.
Its checkpoint contains no artifacts and no Counter-specific state.
It emits no observations, signals, trends, scores, proposals, mutations, or ledger events.
It does not make model calls or change deterministic validation and selection.

## Stable memory identity

`EvolutionMemoryItem.memoryItemId` is a generated stable address and must not be derived from rendered text or its digest.
`contentDigest` verifies the item content associated with a revision, while `creationRevision` and `supersessionRevision` describe its harness lifetime.
Ledger event references connect the item to durable audit history without putting that history into EVOLVE.md.
Frozen evolution snapshots carry active memory-item records separately from the rendered memory string.

Mutable Counter metadata must remain outside EVOLVE.md.
Observation totals, trends, policy versions, and other mutable statistics must not alter the rendered prompt or force a harness revision.

## Observation invariants

`CounterObservation` is an append-only raw record.
Implementations must never replace raw observations with aggregate totals.
Each record identifies the memory item, harness revision, top-level task lineage, traces, evidence, signal source, attribution method, policy version, timestamp, and idempotency key.

Candidate observations may be appended while evidence is incomplete.
At most one final observation may exist for each `(memoryItemId, topLevelTaskLineageId)` pair.
The uniqueness key deliberately excludes retries, resumed processes, repeated citations, subagent activity, and policy version.
Those execution details may contribute evidence to the same task-level conclusion but must not inflate the final sample count.

Future trace metadata should distinguish memory items that were available, selected, and used.
Attribution may use direct user feedback or deterministic test, tool, replay, and environment outcomes.
Model self-assessment and co-occurrence are weaker attribution methods than direct feedback and deterministic outcomes.

## Report and policy boundary

`CounterReport` contains evidence references and trends only.
It must not contain executable mutations, proposal scores, or decisions to keep, refine, rescope, deactivate, remove, or delete an item.
Those decisions belong to Curator proposals and deterministic policy gates.

Removal thresholds, minimum sample sizes, recency treatment, and deactivation-before-deletion behavior belong to a separately versioned policy.
The observation and report contracts carry the applicable policy version without embedding policy knobs into their schemas.

## Deferred implementation

This reservation does not add observation persistence, aggregation, attribution, scoring, pruning, trace selection metadata, or memory mutation.
A future implementation may provide the existing `PreReflectionStage` port, persist raw observations in a dedicated append-only store, and emit a versioned `CounterReport`.
That implementation must preserve the frozen job input, checkpoint artifact format, and explicit `counterReport` input already consumed by Reflector.

## Skill lifecycle observations

Skill lifecycle outcomes use a separate append-only store under evolution state. They are never written into `SKILL.md`, `EVOLVE.md`, or a harness revision, so recording a later outcome cannot rewrite the active or historical harness.

Each observation binds one exact skill ID, version, content digest, harness revision, workspace identity, and top-level task lineage. Observable invocation events remain distinct (`available`, `listed`, `selected`, `explicitly-referenced`, `read`, and `force-loaded`); none is represented as inferred skill use. Co-occurrence can record only an `unknown` outcome and cannot carry a lifecycle issue classification.

Final observations are unique per workspace, exact skill version, and top-level task lineage. Direct user attribution and deterministic test, tool, replay, or environment outcomes receive more report weight than model self-assessment or inference. Candidate observations remain auditable but do not contribute to final outcome weights or recommendations.

Lifecycle reports consider recommendations only for the exact evolved skill versions active in the supplied workspace snapshot. Outcomes for the same immutable skill version remain applicable when that version reappears in a later harness revision, while the observation retains its original harness attribution. Different skill versions and installed skills remain available for audit but cannot target the evolved-skill writer. Reports can recommend narrowing triggers, revising a procedure, merging active evolved duplicates, deactivating a harmful skill, or retiring obsolete guidance. A recommendation is not a mutation: it requires a new Skill Curator candidate and the existing deterministic validation, retrieval evaluation, and behavioral evaluation gates before the skill writer can act.
