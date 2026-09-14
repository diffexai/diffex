# Test module loading

Import `userMsg`, `assistantMsg`, and `buildTestTree` directly from `message-fixtures.ts`.
That module has no runtime imports.
Import extension and resource-loader factories and their option types directly from `extension-test-utils.ts`.
Keep authenticated session construction in `utilities.ts`; do not re-export the extracted helpers from it.
Inline extension fixtures import `core/extensions/factory.ts`, which constructs registration state without loading jiti, the CLI, or the provider catalog.
Disk extension discovery continues through `core/extensions/loader.ts` and uses the same factory implementation.
Tool tests import the individual `core/tools` modules rather than the package entry point.

The coding-agent Vitest configuration caches transformed modules on disk while retaining default test-file isolation and workspace source aliases.
Local runs retain default worker selection; CI explicitly uses two isolated fork workers per shard.
The default cache directory is the workspace-root `node_modules/.experimental-vitest-cache`.
A missing cache falls back to normal transformation.
Vitest validates source contents and configuration before reusing cached transformations.
Custom transform plugins that depend on external files or options must include those inputs in a cache key generator or opt affected modules out of caching.
See [Vitest's filesystem cache documentation](https://v4.vitest.dev/config/experimental#experimental-fsmodulecache).

## Local measurements

Measurements used Node 22.19.0, Vitest 4.1.9, one worker, and the existing `current-plan-state.test.ts` and `session-manager/tree-traversal.test.ts` files on macOS.
Each row reports the median of three runs, and every run passed all 36 tests.
Cold-cache runs used a new temporary cache directory for each sample, followed immediately by its warm-cache run.
These small samples do not predict full-suite or hosted CI savings.

| Configuration | Total | Transform | Import |
| --- | ---: | ---: | ---: |
| Original helpers, cache disabled | 2.080 s | 1.100 s | 1.960 s |
| Split helpers, cache disabled | 0.516 s | 0.215 s | 0.402 s |
| Split helpers, cold cache | 0.531 s | 0.230 s | 0.418 s |
| Split helpers, warm cache | 0.323 s | 0.026 s | 0.206 s |

Run from `packages/coding-agent`:

```bash
node ../../node_modules/vitest/dist/cli.js --run test/current-plan-state.test.ts test/session-manager/tree-traversal.test.ts --maxWorkers=1 --experimental.fsModuleCache=false
```

For a cold/warm pair, use a fresh temporary cache directory and run the same command twice:

```bash
module_cache_dir="$(mktemp -d)"
node ../../node_modules/vitest/dist/cli.js --run test/current-plan-state.test.ts test/session-manager/tree-traversal.test.ts --maxWorkers=1 --experimental.fsModuleCache --experimental.fsModuleCachePath="$module_cache_dir"
node ../../node_modules/vitest/dist/cli.js --run test/current-plan-state.test.ts test/session-manager/tree-traversal.test.ts --maxWorkers=1 --experimental.fsModuleCache --experimental.fsModuleCachePath="$module_cache_dir"
```

Import profiling with `--reporter=verbose --experimental.importDurations.print --experimental.importDurations.limit=100` showed that `current-plan-state.test.ts` no longer imported `AgentSession`, the provider catalog, the compatibility API, or the coding-agent entry point.
The original profile attributed 1.40 seconds to `utilities.ts` and its dependencies.
The extracted message fixture took less than 1 millisecond in the new profile.

Cache invalidation was verified by warming these tests, temporarily inserting a throwing probe into `userMsg`, and rerunning without clearing the cache.
Vitest wrote a new transformation and tests failed with the probe error.
Restoring the source passed all 36 tests again.
`DEBUG=vitest:cache:fs` exposes cache reads and writes for this check.

The affected test files and shared harness consumers passed 212 tests, with 26 credential-dependent tests skipped.
The full offline suite passed through `./test.sh`, including 2,862 coding-agent tests with 49 expected skips.
The suite required execution outside the filesystem/network sandbox for localhost test servers.
`npm run check` and static workflow validation passed.

## Hosted CI acceptance

CI persistence remains opt-in through the repository Actions variable `VITEST_FS_CACHE=true`; the hosted measurements below did not demonstrate positive net savings.
The variable controls restore/save only; local transformation caching remains enabled.
The cache restores after dependency installation and saves only after a successful test job, using commit-pinned actions.
Its compatibility prefix includes a format revision, runner OS and architecture, the resolved Node version, the lockfile hash, and the Vitest/TypeScript configuration hash.
The save key appends the commit SHA, and restore never falls back outside that compatibility prefix.

Compare at least three uncached hosted runs with three restored-cache runs on the same source and runner configuration.
Record total job time, the coding-agent duration, and the restore/save step times from the Actions logs.
Confirm equivalent test counts and outcomes for cold and warm runs.
Keep persistence enabled only if the median total job saving is positive after restore/save overhead.
Disable the repository variable if that condition is not met.
The first hosted run after release-test and CLI consolidation reduced the main CI job from 14m34s to 12m56s.
See [the baseline run](https://github.com/diffexai/diffex/actions/runs/34796513283) and [the improved run](https://github.com/diffexai/diffex/actions/runs/34891736038).
Cache restore/save remained disabled in that comparison, so it does not establish a persistent-cache benefit.

## CI groups and benchmarks

CI runs four coding-agent shards alongside two scripts/other-workspace shards and a build/check job.
All test jobs use `test.sh` to isolate credentials and user resources.
The `other` group discovers test workspaces from the root workspace manifest, so new packages are included automatically.
Its shards alternate sorted workspace names, with script tests assigned only to the first shard.
The existing `build-check-test` required check succeeds only when every group succeeds.
Cache keys include the shard number and count to avoid reusing a partial cache from a different shard.

```bash
./test.sh coding-agent --shard=1/4
./test.sh other
./test.sh other --shard=1/2
```

Run `CI benchmark` manually, or add the `ci-benchmark` label to a pull request containing that workflow.
It compares one and two workers in both forks and threads, with file isolation enabled and three samples per supported configuration.
The complete suite includes native image/SQLite code and tests that change process state; a faster pool is acceptable only if those tests pass.
A separate cache benchmark seeds a cache and compares three uncached jobs with three jobs restoring that exact cache on the same source.
Include the measured save/restore overhead when deciding whether persistence saves time.
Benchmark runs are opt-in and do not extend the normal CI critical path.

## Hosted results - 2026-09-14

[The first sharded run](https://github.com/diffexai/diffex/actions/runs/34899734233) passed in 4m30s from the first job starting to the required gate finishing, versus 12m56s previously.
That single comparison shows 65.2% lower elapsed latency, with aggregate runner time increasing from 12m56s to 18m02s.
It predates the additional split into two other-workspace shards and the two-worker setting.

[CI with both refinements](https://github.com/diffexai/diffex/actions/runs/34901877173/attempts/2) passed in 3m06s using Node 22.23.2, the same version as the baseline.
That is 76.0% below the 12m56s baseline and 31.1% below the first sharded run.
Aggregate runner time was 16m45s, compared with 12m56s for the baseline and 18m02s for the first sharded run.
These are individual hosted comparisons, not repeated-run medians.
All four coding-agent shards passed 2,863 tests with 49 expected skips, all 347 script tests passed, and every other workspace passed across its two shards.
[Artifact acceptance](https://github.com/diffexai/diffex/actions/runs/34901877395/attempts/2) also passed on Linux and macOS, both Intel and ARM.

[The worker benchmark](https://github.com/diffexai/diffex/actions/runs/34899782204) used Node 22.23.2, the complete coding-agent suite, isolation enabled, and filesystem transformation caching disabled in both configurations.

| Pool | Workers | Three full-suite durations | Median | Outcome |
| --- | ---: | --- | ---: | --- |
| Forks | 1 | 403.82s, 399.21s, 401.86s | 401.86s | All passed |
| Forks | 2 | 366.87s, 362.32s, 365.85s | 365.85s | All passed |

Each run passed 2,863 tests with 49 expected skips, including native dependencies and process-state tests.
Two fork workers reduced the median by 9.0%; CI now selects that configuration.
Both thread configurations failed 58 tests because worker threads do not support `process.chdir()`.
Those tests remain intact.

[The cache comparison](https://github.com/diffexai/diffex/actions/runs/34899782204/attempts/2) completed after the account billing limit was resolved.
All six jobs used the same source, Node version, Ubuntu runner label, one isolated fork worker, and enabled filesystem transformation caching.
Cold jobs started without a persisted cache; restored jobs all hit the same 6.25MB seed.
Each job passed 2,863 tests with 49 expected skips.

| Cache state | Three complete job times | Median job | Median suite | Median transform |
| --- | --- | ---: | ---: | ---: |
| Cold | 386s, 396s, 387s | 387s | 333.93s | 7.50s |
| Restored | 458s, 499s, 484s | 484s | 423.69s | 1.98s |

Restore steps took 1s, 0s, and 2s, already included in the restored job times; the seed save took 1s.
Adding that save cost makes the restored median 485s, versus 387s cold.
The transform saving did not produce a total-job saving in these hosted samples.
Runner variation means this comparison does not establish that cache restoration caused the entire slowdown.
Hosted persistence remains disabled; the benchmark is available for future evaluation.
