# Source publication review

This review prepares a controlled private-to-public transition for `diffexai/diffex`.
It does not change repository visibility or authorize package publication.
CI failures and Dependabot remediation are deferred at the owner's explicit request.
Neither is represented as resolved.
The reviewed source is ready for the controlled transition below, subject to landing the reviewed changes and pausing Actions before the visibility switch.
It is not ready for unrestricted public workflow execution until the public controls are verified.

## Publication scope

Making this repository public exposes reachable branches and tags, historical source, issues and pull requests, comments, and retained Actions evidence.
The approved npm payload is a smaller and separate distribution scope.
Source publication includes development records under `docs/release`, agent prompts, evaluation adapters, test fixtures, and native helper source.
Do not rely on `private` package flags or artifact names to keep those materials confidential.
Do not change visibility if any of this material must remain private.

The current npm policy permits only `@diffexai/diffex`, with bundled runtime workspaces.
Opening the source does not authorize standalone binaries, container publication, or additional package registries.
Historical distribution reviews describe the policy in force when they were written; they are not current claims of access protection after a visibility change.

## Review evidence

The review started from source commit `006e464e149f16fd14e36624bd9adf98d0c29e9d` on 2026-10-17.
A fresh remote mirror contains 242 branch refs, nine tag refs, 246 pull-request refs, and 6,797 reachable commits.
Gitleaks 8.30.1 was downloaded from its official release and its archive SHA-256 matched the published checksum: `b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`.
The scanner used its default rules, full redaction, and ignored inline allow comments.

Gitleaks reported 6,401 commits scanned and 42 generic-key matches.
The tracked working-tree scan reported nine matches.
Current-tree matches are test idempotency strings and a keyboard binding.
Historical matches additionally include model identifiers, an HTTP beta-feature header, and upstream OAuth client constants.
The historical Google Cloud and Google Antigravity OAuth files are byte-identical to their public Pi upstream files at the same commits.
Those client constants are not evidence of a private Diffex account credential.
The historical compaction transcript fixture also has the same Git blob identity as public upstream: `5e744e3d4b69b43789776719dd900af043fd8a8d`.

The GitHub discussion inventory contains 239 issues/pull requests, 26 issue comments, 48 pull-request review comments, and 83 review bodies retrieved across all 235 PRs.
No GitHub release records or gist links were present in that inventory.
Wiki, Pages, and Discussions are disabled.
Four linked attachments were downloaded with authenticated access and visually inspected: a CLI schema-error screenshot and three demonstration UI screenshots, without visible credentials or personal data.
The four tracked coding-agent documentation images were also visually inspected; they contain demonstration UI or artwork, without visible credentials.

All 501 inventoried artifacts and 2,021 workflow log archives were downloaded and scanned with nested-archive traversal enabled to depth eight.
Two older runs, `32985640027` and `32985547564`, returned HTTP 404 for their logs and could not be reviewed.
The combined scan also included issue/PR text, review bodies, and Git commit metadata and scanned approximately 778.55 MB of content.
It produced 272 matches: 252 generic-key matches in archived test strings, keyboard bindings, and model-file manifests, plus 20 commit SHA strings misidentified as Sourcegraph tokens.
The flagged token-plan manifest entries were verified against the SHA-256 of the embedded model files.
An additional pass unpacked 1,005 Docker build-record members and scanned approximately 119.54 MB without matches.
No private Diffex account credential was confirmed in these results.
This conclusion does not mean every scanner match was a placeholder: the historical public upstream OAuth client constants are real client identifiers already shipped upstream.
The closing remote-history refresh produced the same 42 findings and no new refs or commits.
A subsequent inventory found one additional model-catalog workflow run, `39061334078`, which was skipped without executing jobs; the artifact count remained 501.

These checks are a targeted disclosure review, not a proof that no secret, personal data, or application vulnerability exists.
Expired or deleted content and third-party systems outside the repository cannot be certified by this review.
New commits, comments, artifacts, and runs after the inventory require a delta review before the visibility change.

## Source notices

The root `LICENSE` preserves the Apache-2.0 terms for Diffex and the upstream MIT terms and copyright for Pi-derived portions.
The vendored HTML-exporter libraries retain their bundle headers.
Their complete upstream texts are tracked at `legal/upstream/marked-18.0.5.LICENSE` and `legal/upstream/highlight-11.9.0.LICENSE`.
`legal/upstream/sources.json` records the source revisions.
Do not substitute the project license for those third-party terms.
The review verifies the notices present in the repository; it cannot establish ownership of unpublished contributions or third-party brand permissions on the owner's behalf.

## Workflow review

The pull-request-target gate uses the GitHub API and does not check out or execute pull-request code.
The contributor-approval workflow checks out the default branch and verifies maintainer permissions before changing its allowlist.
Issue-label workflows use static scripts and API arguments rather than shell interpolation of issue bodies.
Pull-request build and acceptance jobs run on GitHub-hosted runners without publication secrets.
Repository token defaults are read-only and Actions cannot approve pull requests.
Issue analysis remains disabled in GitHub and inert in the merged security workflow.
Model publication requires a successful same-repository push to main, or a main-only scheduled/manual publication.
Release and benchmark credentials remain environment-scoped and require the deployment restrictions below before Actions is resumed publicly.

## Controlled visibility transition

1. Land the reviewed security and notice changes on the default branch.
   Resolve the merge procedure explicitly if the deferred CI failure prevents a protected merge; do not silently bypass protection.
2. Pause repository Actions and ensure no credential-bearing runs remain active.
   Keep issue analysis disabled independently of the repository-wide pause.
3. Record the final source SHA and complete the delta disclosure review.
   Preserve any evidence required for release recovery before deleting retained artifacts or runs.
   Clear the four inventoried Actions caches, including npm caches and CodeQL databases, so pre-publication cache contents are not exposed to public workflow consumers.
4. Change visibility only after owner approval of the disclosure scope.
5. Before resuming Actions, verify or recreate main protection, release-tag protection, deployment policies, and scanning controls.
6. Resume only the reviewed workflows after the controls below pass readback.
   Do not resume standalone/container publication or issue analysis as part of this transition.

The latest private-repository API readback returned a plan restriction for rulesets and reported secret scanning disabled.
Earlier successful settings writes are therefore not sufficient evidence that protections remain enforced.
Public visibility should unlock the relevant controls; every control must be read back after the change.

## Required public controls

| Control | Required configuration |
| --- | --- |
| Main | Require PR approval, dismiss stale approvals, resolve review threads, require CI, and prohibit force pushes/deletion; no routine bypass. |
| Release tags | Restrict creation of `v*` tags to release maintainers; prohibit updates/deletion independently of creation privileges. |
| Model environment | Allow only branch `main`, not a tag named `main`. |
| Release environments | Allow only reviewed `main` recovery runs and `v*` tags; require Pepps233 approval and disallow admin bypass. |
| Benchmark environment | Restrict credential-bearing runs to reviewed main; retain only evidence approved for public disclosure. |
| Fork workflows | Require approval for all outside collaborators; retain read-only default token permissions and prohibit Actions PR approval. |
| Security controls | Enable secret scanning, push protection, Code Security/CodeQL, and private vulnerability reporting; verify actual status. |

Pepps233 is the only currently observed repository admin.
An admin-role exception for tag creation also grants future admins that capability; use a dedicated release team if that is not intended.
With Pepps233 as the sole deployment reviewer, preventing self-review would block deployments initiated by that same account.
Independent deployment review requires another authorized reviewer or a different initiator.

## Deferred follow-up

- Fix CI and triage dependency alerts separately, as requested by the owner.
- Adapt the release command and contributor-approval automation to PR-based changes under main protection.
- Keep issue analysis disabled until credentials, execution, and output publication have independently enforced boundaries.
- Review CodeQL and secret-scanning results after public activation before enabling publication jobs.
- Keep non-source distribution channels deferred until their separate redistribution review is complete.
