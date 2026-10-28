# Local package and native acceptance

The release gate installs every package returned by `scripts/release-packages.mjs` from its reviewed local tarball.
Each package receives a separate consumer with only its public dependency closure, ordered before the package that requires it.
Consumers live outside the repository in paths containing spaces, with separate homes, configuration, projects, temporary files, and package prefixes.
npm and Bun start with an empty registry cache shared only among consumers in that acceptance run, and Bun registry concurrency is bounded.
pnpm consumers use isolated stores, homes, configuration and global executable directories; no user store or credentials are inherited.
Installed file identities are rechecked in every consumer even when downloaded dependencies are cached.
Native candidate npm consumers explicitly enable dependency lifecycle scripts; pnpm and Bun consumers keep scripts disabled.
The shared `installConsumer` helper still disables scripts by default; acceptance opts npm into the reviewed script-enabled path.
The Diffex registry scope points to an unavailable loopback endpoint, so a missing local override fails instead of fetching an older Diffex package.
External npm dependencies still resolve from the public registry, except for the reviewed Mistral provider bundle.
Only that provider implementation absorbs its required pure-JavaScript SDK code; other implementation paths, declarations, lazy loading, extensions, native bindings and WASM remain unchanged.
Bundling checks exact approved npm versions/licenses, records input hashes and registry integrity, preserves complete license/NOTICE text, and rehashes the final staged runtime inventory.
New unresolved dependency references, location-sensitive inputs, unreviewed dynamic imports, missing legal documents or unexpected bundle output fail packaging.
A mock-fetch regression exercises Mistral streaming, request options, errors and cancellation without live provider credentials.

Declared runtime exports, wildcard exports, declarations, main files, and executable targets must exist inside the installed package.
Runtime imports and representative operations execute in fresh Node processes.
Installed runtime inventories must equal the inventory extracted from the checked tarball, and every recorded installed file must match its SHA-256 digest.
The operation inventory fails closed if a new public package has no representative operation.

The current public inventory contains only `@diffexai/diffex`.
Its required internal modules ship inside the tarball, and installation must succeed while separate Diffex registry requests are blocked.
The representative CLI operation initializes model runtime, loads clipboard native code, executes image WASM, and exports a session to HTML.
Hosted server packages remain private and are covered by repository tests rather than public npm artifact acceptance.

The packed CLI additionally executes help, version, model listing, controlled inference, a terminal prompt/reply, account-menu inspection, and clean exit.
The terminal path exercises packaged themes and the HTML export path exercises its templates, CSS, and bundled renderer resources.
Clipboard coverage loads the native module without reading or replacing the user's clipboard.
Socket guards reject non-loopback process traffic; the terminal fixture supplies the known no-release HTTP response and fails on unexpected socket attempts.
No provider credentials are inherited.
The controlled environment must supply native `fd` and `ripgrep` executables on PATH.
Acceptance executes file discovery and content search, records their versions, and keeps automatic helper downloads blocked.
Native runners install those prerequisites through apt or Homebrew before package acceptance.
This validates the npm installation with controlled system helpers; it does not establish the separate automatic-helper-download lifecycle.

## Installed lifecycle acceptance

The acceptance command also runs `scripts/npm-lifecycle.mjs` against the exact reviewed CLI tarball.
It installs globally into an isolated prefix, checks PATH, version, help, and models, then invokes the installed self-updater with real npm subprocesses.
Only discovery and the Diffex-scoped registry are controlled fixtures; dependency downloads use npmjs.org.
This updater/recovery harness intentionally retains scripts-disabled installation and self-update behavior; the candidate consumer and public fresh-install checks separately cover script-enabled npm installation.
An isolated version-metadata predecessor exercises upgrade to the reviewed candidate without publishing a fake release.
Fresh caches require actual target downloads.
Malformed and foreign metadata, redirects, outages, no release, and checksum mismatches are rejected without changing the installed prefix, including force.
An interrupted npm download demonstrates the documented pinned repair and, when npm reports `ENOTEMPTY`, relocation of the affected CLI installation or its exact stale backup before retrying.
Interruption itself can mutate npm's prefix and is not claimed to preserve the executable.
Uninstall verifies executable removal and retained global and project data.
The same harness verifies Bun and pnpm global installation and PATH, rejects a foreign release identity without mutation, upgrades with real package-manager subprocesses, checks the installed runtime hashes, and uninstalls while retaining user and project data.
pnpm upgrades reuse the same store location with its contents cleared, preserving store identity while requiring fresh package downloads.
pnpm's shell executable shim and package links are checked against the isolated consumer rather than treated as npm-style direct executable symlinks.
An isolated Bun global scope registry ensures that the upgrade receives the reviewed candidate bytes.
`npm-lifecycle.json` records commands, identities, results, limitations, and cleanup.

## Supported distribution scope

The approved channel remains the npm registry, installed with npm, pnpm or Bun and executed on Node 22.19.0 or newer.
Bun package installation is distinct from a Bun standalone executable.
Standalone publication remains deferred for every platform under the approved redistribution policy, and the manifest advertises no binary assets or binary platforms.
Windows npm targets are now explicitly deferred until equivalent terminal acceptance is available.
The advertised npm targets are Darwin arm64/x64 and Linux arm64/x64.
The reusable native workflow uses clean native runners for those four targets, downloads the same retained tarballs, verifies their source and checksums, and runs the complete acceptance command before npm publication can proceed.
Runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Commands and evidence

Build, pack, and accept the current local candidate:

```sh
npm run release:local -- --out '/tmp/diffex local release'
```

Accept existing reviewed artifacts without rebuilding or repacking:

```sh
node scripts/artifact-acceptance.mjs /path/to/artifacts /path/to/private-evidence
```

The command accepts both the local manifest/tarballs layout and the frozen release artifact layout.
`acceptance.json` records the source commit, OS, architecture, Node and package-manager versions, each package's imports and operation result, lifecycle script modes for package and process consumers, exact tarball checksums, process outcomes, and cleanup.
A failed run records failure and the completed subset; it cannot produce a passing overall status.
Terminal transcripts and smoke events are retained beside it in private evidence storage.
Every test-owned consumer, session, cache, configuration directory, and server process is removed, including on failure.

Verify final tarball bytes from their directory using the retained checksum list:

```sh
shasum -a 256 -c /path/to/private-evidence/SHA256SUMS
```

On Linux, `sha256sum -c` accepts the same checksum file.
Regression coverage alters archive bytes and confirms verification fails before installation.
The release workflow retains the source snapshot and manifests privately, while npm publication supplies registry integrity through the existing publisher.
Trusted publishing authenticates the private source workflow, but npm does not generate provenance for private repositories.
Public acceptance must compare the actual downloaded npm bytes with these retained identities after separately authorized publication.
Its initial predecessor install and fresh release reinstall require npm's effective `ignore-scripts` configuration to be `false` before each install and omit the `--ignore-scripts` flag.
These public lifecycle installs use exact versions so the predecessor and release identities remain deterministic; the separate Daytona `npm-global-installation` scenario checks the unversioned `npm i -g @diffexai/diffex` command.
Public pnpm and Bun installs continue to disable scripts, and the installed self-updater intentionally remains scripts-disabled for every manager.
Public evidence records each initial/fresh installation's lifecycle mode and npm configuration result separately from the updater mode.
Changed Daytona scenarios remain a pending remote execution and evidence-review gate; local tests do not establish that result.

The baseline CLI-only acceptance passed on Darwin arm64 but emitted no per-package operation or hosted-server result.
The previous expanded acceptance covered eleven packages and the hosted server lifecycle before the owner reduced the public inventory on 2026-09-13.
Current acceptance validates the complete CLI-only tarball through npm, pnpm and Bun.
The owner specified that no live provider test environment is available, so real login and inference remain pending.
Native runner results and exact committed-candidate evidence are recorded in the implementation pull request and accompanying acceptance record.
Public downloads and public-to-public upgrades remain unexecuted until publication; local fixture inference does not establish those results.
