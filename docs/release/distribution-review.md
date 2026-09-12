# Approved npm distribution policy

The owner approved npm as the host for every public artifact in this release on 2026-09-12.
Standalone archives, Python, all secondary installation channels, and hosted runtime publication are deferred.
The implementation starts from CLI PR #208 at `ae811d134dd63b0a688aea10ea0368c0935e7e48`.
The canonical source repository remains private, and the hosted image identity remains `ghcr.io/diffexai/diffex-runtime`.
This work does not authorize npm bootstrap or production publication.

## Distributions and source disclosure

[distribution-policy.json](distribution-policy.json) records the approved decisions.
The manifest generator derives all eleven public packages from `scripts/release-packages.mjs`, including `@diffexai/diffex-coding-agent-server` and canonical CLI `@diffexai/diffex`.
It rejects private workspace names, the generated private installer package as an npm publication, obsolete `@diffexai/diffex-coding-agent`, incomplete inventories, and mixed versions.
The source commit is a full identity string and is not copied into another repository's Git history.

Readable JavaScript and declarations ship in all public packages.
The CLI also ships runtime JavaScript and declarations from `dist/vendor/evolution` and `dist/vendor/harness-trace`; their private workspace flags do not make those delivered files private.
These are the only private workspace implementations approved for vendoring.
TypeScript examples and native source/build files are excluded.
Runtime JSON, SQLite migration SQL, HTML/CSS export templates, documentation with inline examples, and Diffex-owned TUI native prebuilds remain included.
The TUI helpers call system APIs; their source remains in the private build input and their project notices remain in the package.

The owning preparation tool checks that each emitted runtime path has an approved source input and rejects unexpected build output.
It records the exact runtime paths and SHA-256 values in each package's `distribution-files.json`.
The final tarball checker additionally records every delivered path and hash, including documentation, notices, and binary resources, in private publication evidence.
Source maps are moved to `.artifacts/private-debug/<COMMIT>/<PACKAGE>/` and mapping directives are removed from generated JavaScript and declarations.
CI retains debug maps and final payload inventories only as artifacts of the private source repository.
Original TypeScript, inline maps, and embedded `sourcesContent` are rejected in public payloads.
Delivered code remains inspectable; repository privacy, minification, obfuscation, and compilation do not guarantee confidentiality or prevent reverse engineering.

## License and notice inventory

All eleven shipped package manifests declare `Apache-2.0`.
The two vendored Diffex workspaces also declare `Apache-2.0`.
Each public package receives the complete root `LICENSE`, preserving the full Apache text, Luntraa, Inc. ownership, and the complete upstream MIT license and copyright notice for Pi-derived portions.
The package declaration does not replace the MIT terms of those portions or other third-party terms.
The generated `NOTICE` describes that distinction and the Diffex modifications.

Each package's `distribution-components.json` identifies project portions, bundled components, notice filenames and hashes, and separately resolved package-manager dependencies.
The CLI's bundled HTML exporter includes marked 18.0.5 under MIT and highlight.js 11.9.0 under BSD-3-Clause, with their complete notices in `THIRD-PARTY-NOTICES.txt`.
The latter differs from the separately installed highlight.js 10.7.3 dependency and is inventoried independently.
Exact upstream license revisions are retained in `legal/upstream/sources.json`.
External npm dependencies are resolved separately by the package manager; they are not incorrectly counted as code bundled in a Diffex npm tarball.

The standalone review found Bun's documented statically linked LGPL components and relinking requirements.
The owner therefore deferred standalone publication rather than approving an incomplete runtime notice/source/object set.
The [Bun 1.3.14 notice](../../legal/upstream/bun-1.3.14.LICENSE) records that finding.
The standalone build entrypoints are deliberately blocked, the required binary asset list is empty, and the runtime image workflow remains paused.
Enabling either distribution requires a new complete native dependency, runtime layer, license, and redistribution-material review.

## Public downloads and verification

The public host is `https://registry.npmjs.org`, under the Diffex-controlled npm package namespace.
Versioned tarball URLs are `https://registry.npmjs.org/<PACKAGE>/-/<UNSCOPED_NAME>-<VERSION>.tgz`.
For canonical CLI 0.2.0, the URL is `https://registry.npmjs.org/@diffexai/diffex/-/diffex-0.2.0.tgz`.
No private source-repository credentials are required after the approved version is published.
Npm versions are immutable; published bytes must never be replaced.

The CLI tarball includes `release/distribution-manifest.json`, `release/install-package.json`, and `release/install-package-lock.json`.
The installer metadata remains private-marked to prevent separate npm publication, but its approved contents are intentionally public inside the CLI tarball.
Each public package includes `distribution-files.json` with its runtime file checksums and source commit.
Npm registry `dist.integrity` verifies the complete tarball's bytes, including embedded verification files.
The workflow publishes only checked tarballs; it no longer creates GitHub releases or requires an asset-repository token.
Npm trust remains bound to private `diffexai/diffex`, workflow `build-binaries.yml`, environment `npm-publish`.

The full source archive remains a private build input and is excluded from all public package and publication lists.
Its owning validator requires the root license and model snapshot invariants.
The public cloud release record remains the existing npm publication contract; the richer embedded manifest is not a replacement R2 schema.

## Changelog reset and local acceptance

The owner explicitly approved the one-time reset after automatic review required direct authorization.
Only the nine paths listed in the release audit were cleared; their previous contents remain at `ae811d134dd63b0a688aea10ea0368c0935e7e48`.
At the owner's request, `./diffex-test.sh` was launched in a dedicated tmux session and `/cl` regenerated all nine files from Diffex change history.
The audit completed structural, cross-package coverage, and changelog-parser checks, with no inherited release sections restored.
Packaging rejects empty or structurally invalid project changelogs.
The regenerated files pass the 94 focused changelog, configuration, and version-check tests, and `release-notes.mjs extract --version Unreleased --tag v0.2.0` extracts their release notes.
Do not repeat the reset during normal releases or replace upstream legal notices with changelog entries.

An actual baseline CLI tarball reproduced the source disclosure issue through `npm pack --ignore-scripts --json --cache /tmp/diffex-npm-cache --pack-destination /tmp/diffex-distribution-baseline` from `packages/coding-agent`.
It contained TypeScript examples, native C source, source maps, and duplicated vendored build directories.
The new checker rejects that baseline.
Regression fixtures exercise real npm packing, notice inclusion, private debug retention, missing notices, prohibited source, renamed and inline maps, map strings inside native resources, nested archives, unapproved workspaces, and manifest identity errors.
The tests also prove that reset changelogs block packing before registry queries or writes.

The CLI quality gate, full isolated `./test.sh` suite, and focused changelog/config/version tests passed; the cloud quality gate and shared release contract checker passed.
All eleven build directories passed the approved-input preparation check before final packing.
The runtime checksum inventory also covers the TUI native prebuilds.
Final acceptance must retain the regenerated changelog revision, actual eleven-package tarball hashes and file inventories, isolated installation/startup results, and private source-archive validation.
Anonymous public download acceptance follows separately authorized npm publication and is not claimed by local fixtures.
No npm packages, release records, deployments, sessions, or provider sandboxes have been published or created by this implementation.
