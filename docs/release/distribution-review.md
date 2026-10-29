# Approved npm distribution policy

The owner approved npm as the host for every public artifact in this release on 2026-09-12.
Standalone archives, Python, all secondary installation channels, and hosted runtime publication are deferred.
The implementation starts from CLI PR #208 at `ae811d134dd63b0a688aea10ea0368c0935e7e48`.
The canonical source repository remains private, and the hosted image identity remains `ghcr.io/diffexai/diffex-runtime`.
This work does not authorize npm bootstrap or production publication.

## Pending Homebrew-only review

The Homebrew archive/formula implementation is separate from the historical Bun standalone proposal. It bundles a pinned official Node runtime and private npm, preserves third-party legal/source files under a dedicated checker, and does not add a direct installer or standalone self-updater. This is implementation permission, not redistribution or publication approval. `channels.homebrew` remains deferred and the release signing-key list remains empty until the owner approves the runtime/dependency inventory, signer authority, four-target native evidence, macOS quarantine, Daytona lifecycle evidence and authorized anonymous hosting. See [Homebrew release and recovery](homebrew.md) for the exact review checklist and retained-byte contract. The original npm disclosure restrictions below are unchanged.

## Distributions and source disclosure

[distribution-policy.json](distribution-policy.json) records the approved decisions.
On 2026-09-13 the owner revised the public inventory to only `@diffexai/diffex` and approved a bundled `0.2.1` replacement with retirement of `0.2.0`.
The manifest generator now rejects every additional public package.
It rejects private workspace names, the generated private installer package as an npm publication, obsolete `@diffexai/diffex-coding-agent`, incomplete inventories, and mixed versions.
The source commit is a full identity string and is not copied into another repository's Git history.

Readable JavaScript and declarations ship in all public packages.
The CLI also ships runtime JavaScript and declarations from `dist/vendor/evolution` and `dist/vendor/harness-trace`; their private workspace flags do not make those delivered files private.
The approved CLI-only replacement also includes the agent, AI, client, harness-state, protocol, telemetry, and TUI runtime workspaces under `dist/node_modules/@diffexai`.
Their previously reviewed runtime assets and complete notices are preserved, while publication and installation locks exclude separate Diffex registry dependencies.
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

The CLI and all bundled workspace manifests declare `MIT`.
The two vendored Diffex workspaces also declare `MIT`.
Each public package receives the complete root `LICENSE`, preserving the MIT terms, Luntraa, Inc. ownership, and the complete upstream MIT license and copyright notice for Pi-derived portions.
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

## Historical changelog reset and local acceptance

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
Local artifact acceptance completed for source commit `196a385b4c24210522b50a6037355f1ef617545c` after `/cl` regeneration.
Anonymous public download acceptance follows separately authorized npm publication and is not claimed by local fixtures.
This implementation did not publish npm packages or create production release records, deployments, hosted sessions, or provider sandboxes.

## Recorded local artifact acceptance

Validation ran on Darwin arm64 with Node 22.19.0, npm 10.9.3, and Bun 1.3.11.
The candidate version is 0.2.0; these artifacts were not published.
The following commands completed successfully:

```sh
npm run check
./test.sh
node scripts/prepare-candidate-artifacts.mjs '/tmp/diffex npm distribution candidate'
python3 scripts/verify-candidate-artifacts.py '/tmp/diffex npm distribution candidate'
./scripts/create-source-archive.sh --version 0.2.0 --ref 196a385b4c24210522b50a6037355f1ef617545c --out /tmp/diffex-private-source-0.2.0.tar.gz
```

All eleven actual tarballs passed final-byte source, notice, component, runtime-hash, and identity inspection.
Both isolated package-manager installations resolved all eleven local tarball identities, and every package entrypoint imported successfully with outbound sockets blocked.
The installed CLI passed help, version, auth help, model listing, fixture inference, interactive prompt/reply, account-menu inspection, and clean exit in both installations.
The fixture intercepted release discovery and inference; it did not authenticate a real account or invoke a real model provider.
Native execution on other operating systems or architectures is not established by this host's results.
The test homes and processes were cleaned up, and the temporary package installation directories were removed after retaining evidence.

A rebuild from the committed source reproduced the exact runtime and generated metadata bytes in all eleven inspected tarballs.
It retained 1,216 source maps under the matching commit in private debug storage.
The runtime inventories cover 1,269 files, including four project-owned native prebuilds.
The full source archive passed its independent required-file and model-snapshot checks.
Its SHA-256 is `cd734c1ec4606c68f72c50e62c65554f9f3c36ff814b87eef378793bdf685f78`; it remains a private build input.

The local evidence directory is `.artifacts/distribution-acceptance/196a385b4c24210522b50a6037355f1ef617545c/`.
It retains the checked tarballs, full payload inventories, embedded manifest, command logs, terminal results, package import results, and environment identity.
CI uses private workflow artifacts for its equivalent evidence.
The following SHA-256 values cover the complete local tarballs:

| Package | SHA-256 |
| --- | --- |
| `@diffexai/diffex-agent-core@0.2.0` | `14cc1d808e2a17e601758fa856f6aafe03a3d1ba7fab6f17aee6367188c957ca` |
| `@diffexai/diffex-ai@0.2.0` | `307209b097f0ca349256de98b44555576c215a7dba9ca6e11a1ff318fb06e8bc` |
| `@diffexai/diffex-client@0.2.0` | `d3ce06054506433edb3c7abec849f4bc9bdb3c83067b3dc08bf0e478557c9216` |
| `@diffexai/diffex@0.2.0` | `97b327ac33c04e0dcabc4732f47ee72d0e98980c4a59cdd836d02dcb00c79260` |
| `@diffexai/diffex-coding-agent-server@0.2.0` | `b7bf6181137f35bc0c119da969ffc26425756161547bc86654a782f2703ba7a5` |
| `@diffexai/diffex-harness-state@0.2.0` | `b8eda020f0fb6449ea6cdac1e359b102318f0871317cef827b27dfafa2e2452f` |
| `@diffexai/diffex-protocol@0.2.0` | `a9cd8f3983982d683f7c2a33c7dba96958234973abaca1533267daee1f8da706` |
| `@diffexai/diffex-server@0.2.0` | `788a04fbeee68260b62da9c0dd2844422069117043d2940582543afad4f462ac` |
| `@diffexai/diffex-session-backend-sqlite-node@0.2.0` | `647b5c93973f46d4be3f791bf1a8d6c5e08fc54309ec73d9a450abe1d27f9c67` |
| `@diffexai/diffex-telemetry@0.2.0` | `d7d0d4478c38a4e521c3960833498fbb3a7d9e7658073a51f4938c46739ad657` |
| `@diffexai/diffex-tui@0.2.0` | `55fd31269758777f6603709b343592370de3a67b37b3229727a358ec83fabe9c` |
