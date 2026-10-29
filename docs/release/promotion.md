# Release promotion and recovery

This implementation builds on CLI PR #209 and cloud PR #150.
The default approved policy enables only the CLI npm package and defers direct standalone installation, Python, secondary installers, and runtime images.
The [Homebrew-only archive path](homebrew.md) is implemented behind a separate pending approval gate. With that gate deferred, no archive or GitHub Release is published and the private source repository stays private. Authorizing public release hosting must not silently expose private source history or source/debug Actions artifacts.
Enabling another channel fails closed until required asset enumeration, immutable publication, and anonymous byte verification exist for that channel.
The R2 schema remains the [npm release contract](contract.md), without a binary manifest or new client fields.

## Source selection and review

Only `patch` and `minor` releases are supported.
Patch covers fixes and additions; minor covers breaking changes.
The legacy major release alias and explicit-version invocation reject before mutation.
`scripts/release.mjs` validates one canonical fetch and push origin, a clean `main`, all public package versions, and the stable target version.
It fetches `origin/main`, requires exact `HEAD` equality, and checks local and remote target-tag absence before npm queries or source mutation.
Catalog source updates must already be reviewed and merged; release preparation hydrates model data without regenerating committed catalog source.
Only workspace manifests, root lockfiles, generated CLI shrinkwrap/install locks, and project changelogs may be staged.
Unexpected generated outputs stop the release.
The command displays diffs and requires the operator to inspect all generated changes and type the version in an interactive terminal before creating release refs.
Remote main is refreshed again after review.
The tagged release commit and next-cycle changelog commit are pushed together with `git push --atomic`.

The CI source resolver fetches the named stable tag, resolves its commit once, verifies the push event commit when present, and checks that the release commit belongs to `origin/main`.
Every public package must match the tag version.
The private monorepo manifest has independent version metadata and does not define the public release version.
A supplied recovery ref must resolve to exactly the same commit, even when the workflow itself runs from another allowed ref.
Every downstream checkout uses the resolved full commit, including publication and announcement.
Recovery can fix workflow orchestration through a reviewed workflow ref, but it cannot substitute different release code or repack different bytes under the same version.

## Promotion states

| State | Required evidence and transition |
| --- | --- |
| Source verified | Canonical repository, immutable tag commit, main ancestry, matching versions, and equal recovery source. |
| Inputs frozen | Locked npm dependencies, pinned Node/npm, one hydrated model snapshot, and a private source archive with its SHA-256 digest. |
| Artifacts prepared | Build without catalog regeneration, checks, tests, disclosure inspection of every final tarball, and a manifest binding all input and output digests. |
| Artifacts retained | Successful immutable private Actions artifact upload before npm publishing receives credentials. |
| npm verified | Every existing or newly published package is anonymously downloadable and its size, SHA-256, and SHA-512 match the retained manifest. |
| Version recorded | Conditional creation of the immutable npm record, or exact identity verification of its existing bytes. |
| Announced | Conditional latest-pointer advancement without version regression; equal completion is a no-op. |

The names describe verified prerequisites, not a mutable state field in the public contract.
The source archive and `inputs.json` freeze inputs before the build.
Packing rejects changes to tracked source or frozen model data, and `manifest.json` must agree with those original inputs.
Registry requests reject redirects and use thirty-second timeouts; tarballs are streamed with a 256 MiB limit.
Missing packages are eligible for publication, while mismatched existing bytes abort before publishing any missing package.
Announcement re-downloads the CLI tarball and verifies its bytes before either R2 write.
No failed prerequisite advances the pointer.

## Retained artifacts and retries

The private Actions artifact is named `private-release-<full-source-commit>` and contains the approved npm tarballs, `manifest.json`, `inputs.json`, and `source.tar.gz`.
The build manifest records Node/npm versions and the build platform, and binds the private source tree, lockfile, disclosure policy, and model files.
Private debug maps use a separate private artifact.
Both artifacts request ninety-day retention; repository or organization retention limits may shorten that availability.
Archive approved evidence in access-controlled long-term storage before expiry if longer recovery is required.
Neither the source archive nor debug maps are public release assets.

Rerunning the original workflow downloads its existing artifact and verifies it instead of rebuilding or overwriting it.
A retry before any publication job ran may rebuild if no approved artifact was retained.
After publication has started, missing or expired retained evidence blocks reconstruction.
An operator must restore reviewed original evidence through a separately reviewed recovery path or prepare a new version; no digest mismatch is repaired by overwriting npm or an immutable release.

For a recovery dispatch, select the original tag and original release run:

```sh
gh workflow run build-binaries.yml --repo diffexai/diffex --ref main \
  -f tag=vX.Y.Z -f recovery_run_id=ORIGINAL_RUN_ID
```

The optional `source_ref` is an equality assertion against the release tag, never an alternative release candidate.
Recovery accepts artifacts only from the canonical repository's release workflow with a push or manual-dispatch event.
It copies the original artifact to the recovery run once; rerunning that recovery reuses the copy.
Ambiguous artifacts, expired evidence, failed downloads, and incomplete publication-job history stop recovery.
Publication consumes `node scripts/publish.mjs --artifacts .artifacts/release` with no rebuild or repack.
The bootstrap helper also retains exact checked bytes under `.artifacts/npm-bootstrap` and verifies existing versions before skipping them.
Keep that directory throughout bootstrap recovery.

## Git push interruption

Keep the two prepared commits and the local tag after an ambiguous or failed push.
Inspect both remote refs without changing them:

```sh
git ls-remote origin refs/heads/main refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'
node scripts/release.mjs --push-prepared vX.Y.Z
```

The recovery command requires clean main, a matching package version, the exact next-cycle commit immediately after the tagged release, no extra next-cycle files, compatible remote main ancestry, and no conflicting remote tag.
It repeats the atomic push without recreating commits or tags.
If the server accepted the original push but its acknowledgement was lost, repetition confirms the same refs without changing identity.
Conflicting remote refs require investigation and are never force-pushed.

If a server explicitly reports that atomic pushes are unsupported, do not silently fall back.
After reviewing both refs and confirming no conflict, the operator may push `refs/heads/main:refs/heads/main`, fetch and verify that remote main contains the prepared release, and then push `refs/tags/vX.Y.Z:refs/tags/vX.Y.Z` without force.
A failure before the tag push leaves only the prepared branch commits remote and cannot start tag-triggered publication.
A failure after the tag push is resolved by reading the remote tag and workflow run before retrying the identical ref.
GitHub supports the normal atomic path; the command intentionally refuses automatic non-atomic fallback.

## Publication and announcement failures

| Failure | Recovery and preservation |
| --- | --- |
| Artifact upload fails | No publication job can start; fix private evidence retention first. |
| Some npm publishes succeed | Keep original artifact; verify every existing version against it and publish only absent versions. |
| Existing tarball differs or is unavailable | Stop; do not overwrite npm, skip verification, or announce. |
| New public channel lacks asset checks | Policy gate blocks promotion before registry or storage operations. |
| Version record succeeds but latest write fails | Re-verify npm and reuse the immutable record's original bytes and timestamp for the pointer retry. |
| Latest is already equal or newer | Preserve it; matching completion is safe to repeat and an older release cannot regress it. |

Draft cleanup is unrelated to public recovery: the approved npm-only workflow creates no GitHub draft to delete.
Private temporary build directories may be discarded before publication if no retained evidence exists.
After any npm publication, retain evidence and immutable artifacts; never delete a version record to make a conflicting retry pass.
For the optional Homebrew channel, preserve all platform archives and the complete signed bundle; recovery counts both npm and Homebrew publication attempts and never rebuilds after either started. Existing GitHub assets must match retained bytes before any missing upload. Anonymous asset verification precedes announcement, GitHub latest advancement and the tap update PR. See [Homebrew recovery](homebrew.md#release-ordering-and-exact-byte-recovery). Direct standalone installation remains deferred.

## Validation and limits

The initial reproduction ran the actual release command against an isolated clean feature branch with an unrelated origin and intercepted npm executable.
It reached npm without validating the branch or origin.
The same command now rejects the origin before npm.
The committed command regressions use temporary Git repositories and bare remotes, controlled registry metadata and tarball bytes, and intercepted npm/AWS/GitHub executables.
They cover dirty source, wrong branch/origin, local and remote divergence, existing tags, version mismatch, divergent recovery refs, partial npm publication, conflicting bytes, failed asset retention, pointer failure, and repeated completion.
Atomic-push tests exercise both a rejected server transaction and an accepted transaction whose acknowledgement is lost, followed by successful recovery using the same commits and tag.
Every fixture directory and local bare remote is removed in cleanup.

Run from the CLI root:

```sh
node --test scripts/release-source.test.mjs scripts/restore-release-artifacts.test.mjs scripts/publish-release-announcement.test.mjs scripts/npm-publish-plan.test.mjs scripts/release-contract.test.mjs
node --test scripts/*.test.mjs
npm run check
./test.sh
```

Run the cloud root and isolated public Worker `npm run check` gates and compare mirrored contracts with `node scripts/check-release-contract.mjs /path/to/diffex-new`.
Actionlint validates the release workflow.
These checks do not publish a real release, execute GitHub's credentialed publication jobs, or establish real installed-client acceptance.
The owner's changelog regeneration and actual approved-artifact/publication acceptance remain release prerequisites.
Standalone public asset publication failure cannot be exercised while that channel is deferred; the enabled-channel guard prevents pretending its assets were verified.

Validation completed on 2026-09-12 with Node 22.19.0.
The CLI `npm run check`, complete `./test.sh` non-E2E suite, all script tests, and actionlint 1.7.12 passed.
The focused release commands were rerun after correcting the private-root/public-workspace version distinction and passed against both fixture and actual workspace inventory.
The cloud root gate passed 546 unit and 23 integration tests; the public Worker gate passed 352 tests, both deployment dry runs, and the dependency audit.
The mirrored contract check passed.
All release fixtures used temporary local directories, synthetic artifacts, and intercepted external operations, and cleanup completed.
No credentialed release workflow was dispatched, so there is no publication workflow run or real release manifest to cite for this implementation.
