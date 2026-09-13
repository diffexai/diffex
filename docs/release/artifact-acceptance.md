# Local package and native acceptance

The release gate installs every package returned by `scripts/release-packages.mjs` from its reviewed local tarball.
Each package receives a separate consumer with only its public dependency closure, ordered before the package that requires it.
Consumers live outside the repository in paths containing spaces, with separate homes, configuration, projects, temporary files, and package prefixes.
Each manager starts with an empty registry cache shared only among consumers in that acceptance run, and Bun registry concurrency is bounded.
Installed file identities are rechecked in every consumer even when downloaded dependencies are cached.
Lifecycle scripts are disabled and the Diffex registry scope points to an unavailable loopback endpoint, so a missing local override fails instead of fetching an older Diffex package.
External npm dependencies still resolve from the public registry.

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

## Supported distribution scope

The approved channel remains npm, installed with npm or Bun and executed on Node 22.19.0 or newer.
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
`acceptance.json` records the source commit, OS, architecture, Node and package-manager versions, each package's imports and operation result, exact tarball checksums, process outcomes, and cleanup.
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

The baseline CLI-only acceptance passed on Darwin arm64 but emitted no per-package operation or hosted-server result.
The previous expanded acceptance covered eleven packages and the hosted server lifecycle before the owner reduced the public inventory on 2026-09-13.
Current acceptance validates the complete CLI-only tarball through both managers.
The owner specified that no live provider test environment is available, so real login and inference remain pending.
Native runner results and exact committed-candidate evidence are recorded in the implementation pull request and accompanying acceptance record.
Public downloads and public-to-public upgrades remain unexecuted until publication; local fixture inference does not establish those results.
