# Goal-mode planning and recall

Goal mode hides `update_plan` and its generated prompt guidance.
Calls from stale model responses are rejected before execution.
Existing persisted plans remain unchanged, and leaving goal mode restores planning only when the session's configured tools permit it.
Reloading, resuming, forking, and navigating branches preserve this policy.
Historical plan snapshots are excluded from provider-visible branch and compaction summaries while goal mode is active.

Call `compact_block` when context needs room and usage is at least 40%, selecting completed investigations or obsolete outputs.
Call `query_block` when an archived summary is relevant to the next step but lacks the details needed to proceed.
Invalid selections distinguish malformed boundaries, unknown or stale block IDs, reversed order, and protected blocks within the range.
Errors suggest the oldest eligible contiguous range when one exists; every retry is validated against the current snapshot, including complete tool exchanges.

## Summary evidence and request budgets

Summary generation and recall share an explicit evidence field allowlist.
It retains message roles and ordering, text and visible reasoning, tool names and arguments, outputs and error status, images, shell outcomes, and summary provenance.
Opaque provider signatures, transport identifiers, usage and cost records, and internal bookkeeping are excluded without modifying the original session records.
Argument and output contents are preserved even when they contain keys resembling metadata.

Goal context usage measures the estimated request size as a fraction of the model's entire context window.
The 40% voluntary-compaction threshold and pressure guidance at 60%, 75%, and 85% use that full-window percentage.
At 60% the agent is prompted to consider compacting completed work, at 75% to compact older work soon, and at 85% to compact older context now.
During a tool loop, usage and guidance appear after the first completed tool batch and then every other batch.
A higher pressure tier is reported immediately, and the next ordinary batch omits the usage note.
New user input and request configuration changes receive a fresh usage note.
Stable context markers and request-fit checks remain present for every batch, including batches whose usage note is omitted.
A separate request-fit check subtracts the adapter's 4,096-token safety reserve and response headroom of `min(model.maxTokens, 8192, floor(model.contextWindow / 4))`.
Reaching that smaller input capacity triggers emergency recovery even below 100% full-window usage, independently of ordinary automatic-compaction settings.
Summary requests reserve the same output allowance and check the complete serialized prompt, including earlier interpretive history and supported images, before dispatch.
Oversized voluntary summary requests are rejected without truncating evidence or committing an archive.
The error recommends a smaller range starting with the oldest eligible blocks, or a larger model when a single block cannot fit.
Output-limit, empty-summary, tool-bearing, cancelled, and provider failures report distinct recovery guidance.
Token and image sizes remain estimates with safety headroom, not exact provider tokenization guarantees.

Emergency recovery stores a goal archive in the same compaction record as its summary.
It preserves durable references to every newly removed context entry and links existing archives without duplicating their original evidence.
Cancellation, deferred admission rollback, retries, export, resume, and forks therefore retain the same summary and recall provenance together.
When the removed evidence cannot fit a summary request, recovery uses an explicit archive notice without a model-generated summary or an oversized helper request.
The main agent can discover and recall the original evidence through `query_block`.
These recovery rules apply only while goal mode is enabled.

## Private selective recall

The main agent calls `query_block` with `archive_id` (such as `ctx-0001`) and a `query`.
Omit `archive_id` to search archive summaries and allowlisted original evidence, or use `query: "*"` to list archives.
Discovery uses a branch-scoped local BM25 index, combining summary scores with the strongest source-entry match and retaining branch order for ties.
It returns at most 20 archives per page, 240 summary characters per archive, three matching source-entry references, and eight direct archive references.
Continue with the same query and the returned cursor while the archive set remains unchanged.
Discovery requires no model helper request and exposes source references rather than raw evidence excerpts.
Search is lexical and non-exhaustive even when it returns matches; synonyms without shared terms still require alternate queries or browsing.
Weak or empty matches do not establish that evidence is absent, and results explain how to browse with `query: "*"` and no cursor.
A private recall child receives the query, archive summary, direct reference IDs, and initial BM25 search hits.
Only the synthesized answer, citations, limitations, and usage return to the main agent.
Search hits and expanded evidence do not enter the main conversation.

The recall child has two tools:

- `search_blocks(query)` searches original evidence chunks in the selected archive and its reachable references.
- `expand_block(block_id, cursor?, surrounding_chars?)` retrieves original evidence around a stable chunk ID, or browses a reachable archive by ID when search is weak or empty.

Within private recall, archive summaries are navigation hints rather than original evidence.
The index uses BM25 with k1 = 1.2 and b = 0.75, Unicode tokens, camel-case splitting, and a small stop-word list.
Chunk IDs contain archive ID, original session entry ID, message index, and message-relative offset.
IDs remain stable across model context sizes, image capabilities, and forks retaining the original entries.
Every search and expansion enforces the selected branch's reachable archive graph.

## Bounds and completeness

Original evidence is divided into chunks of at most 2,400 characters, preserving nearby word boundaries.
Search returns at most eight hits with excerpts of at most 400 characters and at most 6,000 serialized result characters.
Expansion returns at most 6,000 serialized evidence characters plus provenance and pagination metadata.
Surrounding context defaults to 512 characters on each side and is capped at 1,024.
Images are expanded separately, at most one per page, and consume an additional 6,000 characters of retrieval allowance.

Initial search, follow-up searches, and expansion share a cumulative allowance of `min(256000, floor(availableContextTokens * 1.6))` characters.
Available context excludes the provider safety reserve and response headroom described above.
The child also checks remaining context before returning more evidence and disables retrieval when context or retrieval allowance is exhausted.
The allowance is a conservative character-based estimate, not an exact provider tokenizer or image-token count.

The answer reports retrieval limits, missing original entries, unsupported or uninspected images, and remaining uninspected evidence.
Empty search results never establish absence.
The child can reformulate a query, browse an archive, paginate, or follow adjacent chunk IDs.
It is instructed to cite original evidence, identify conflicts, distinguish inferences, and preserve uncertainty.

## Validation

Faux-provider session-loop tests cover planning visibility and restoration, private initial search and expansion, branch scoping, stable IDs, browsing, image pagination, budget exhaustion, context exhaustion, and provider-visible plan snapshots.
Failure-review regressions cover signed history under a 32k estimated request guard, successful compaction followed by recall, oversized JSON rejection before dispatch, actionable failures, early recovery, and ranked discovery across 23 successive archives.
Recovery lifecycle tests cover omitted-detail recall, repeated emergencies, nested archives, summary failures, transient retries, cancellation before and after append, persistence failure, concurrent context changes, and deferred admission.
Discovery quality tests measure exact source attribution for 45 evidence-only Unicode identifiers, deterministic pagination and ties, opaque-metadata exclusion, and bounded response size separately from coding accuracy.
`goal-input-replay.test.ts` compares identical actions and evidence in baseline and goal mode over 12 and 80 exchanges.
It also compares selective evidence delivery against eager archives at 200,000-token and 1,000,000-token context sizes.
Set `DIFFEX_GOAL_COMPARISON_OUTPUT` to save replay measurements as JSON.
Faux-provider character and latency measurements do not establish live model quality or billed token savings.

The eight-run live evaluation and separate eager/selective recall calibration are saved under `evals/terminal-bench/results/goal-selective-recall-20261103/`.
That ignored local artifact directory contains `README.md`, `metrics.json`, raw traces, benchmark patches, verification results, and reproducible runners.
