# Install, update, and remove Diffex

Diffex is distributed through npmjs.org as `@diffexai/diffex`.
Use Node.js 22.19.0 or newer and npm or pnpm on macOS or Linux, on arm64 or x64.
Windows, Android/Termux and direct standalone installation are not accepted release targets.
The Homebrew channel below is implemented but remains unavailable until its redistribution and native qualification gates are approved.
The hosted runtime image is for the cloud service.

## Install and verify

```sh
node --version
npm --version
npm i -g @diffexai/diffex
diffex --version
diffex --help
diffex --list-models
```

Only the CLI package is needed; its internal Diffex modules are included.
Normal npm installation enables dependency lifecycle scripts. The pinned dependency hooks are reviewed; Diffex itself does not require an install script or download a runtime during installation.
Npm verifies downloaded package bytes against registry integrity metadata.
If your policy disables lifecycle scripts, `npm i -g --ignore-scripts @diffexai/diffex` remains supported.
If your configured registry or mirror does not carry Diffex, select the canonical registry with `--registry=https://registry.npmjs.org`.
For a reproducible installation, replace the package argument with `@diffexai/diffex@<verified-version>`, using an exact version you have checked on npmjs.org.

The executable directory is `$(npm prefix -g)/bin` on supported platforms.
If `diffex` is not found, add that directory to your shell's PATH:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
command -v diffex
diffex --version
```

Persist the PATH setting in your shell configuration if necessary.
Use a Node version manager or a user-writable npm prefix when the global directory is not writable.
Changing Node installations can change the npm prefix; check `command -v diffex` after switching.

Start `diffex` in your project directory, use `/login` to configure your provider, and send a short prompt.
See [Quickstart](quickstart.md) and [Providers](providers.md) for authentication and execution.

## Homebrew (pending first qualified release)

The official tap is not enabled yet. After its first separately authorized release, use the explicit formula name:

```sh
brew install diffexai/tap/diffex
diffex --version
diffex --help
brew upgrade diffexai/tap/diffex
brew uninstall diffexai/tap/diffex
```

Homebrew installs a prebuilt, SHA-256-pinned application archive with private Node/npm; it does not run npm to install Diffex and requires no separately installed Node/npm. Initial targets are macOS 15+ and Ubuntu 24.04-class glibc Linux (glibc 2.39+), arm64/x64. Musl/Alpine and older systems are unsupported. The formula also installs `fd`, Git and ripgrep.

Homebrew owns upgrades. `diffex update`, `diffex update --self` and `--force` only print `brew upgrade diffexai/tap/diffex`; they do not run Brew/npm or change the application or user data. `diffex update --extensions` still updates extensions; `--all` retains extension updates but only prints the Brew command for Diffex itself. Repair with `brew reinstall diffexai/tap/diffex`.

Extensions keep their existing user/project storage. Unless you explicitly configure `npmCommand`, extension installation uses the private npm with bundled Node on subprocess PATH. Existing project trust and lifecycle-script behavior is unchanged. Git, shell utilities, OS credential/clipboard services and native extension build tools may still be needed.

Check `command -v diffex` before migrating from npm or pnpm. Uninstall the old application with its owning package manager, not by deleting a shared prefix; then verify the Brew executable is first on PATH. No installer automatically overwrites or adopts another channel. Homebrew uninstall retains `~/.diffex/agent`, project `.diffex` directories, credentials, sessions and separately configured session directories. Homebrew normally tracks the tap's current version; for an exact reviewed version, use an approved historical formula/tap commit and verify its pinned archive hashes rather than changing its URL alone.

Homebrew's trust anchor is the reviewed tap/formula and its archive SHA-256. Downloading an adjacent checksum, signature or public key is not independent authentication. Bundled runtime security fixes ship as reviewed Diffex archive/formula updates. There is no supported `curl | sh` installer or standalone self-update in this channel.

## Install with pnpm

pnpm installs the same package from npmjs.org; no separate registry or release is required:

```sh
node --version
pnpm --version
pnpm add -g --ignore-scripts --registry=https://registry.npmjs.org @diffexai/diffex
diffex --version
diffex --help
```

If pnpm reports `ERR_PNPM_NO_GLOBAL_BIN_DIR`, run `pnpm setup` and open a new terminal before retrying.
Use `pnpm bin -g` to locate the executable directory and ensure it is on PATH.
Use pnpm for subsequent upgrades, repairs, and removal of this installation; do not mix npm and pnpm in the same installation directory.
For a reproducible installation, specify `@diffexai/diffex@<verified-version>` instead of the unversioned package.

npm and pnpm own the initial download display. Diffex's package has no install script or second installer banner; npm can run the reviewed dependency hooks.
`diffex update --self` shows a compact activity indicator in terminals, retains warnings and failure diagnostics, and streams package-manager output when redirected to a log.
The indicator shows activity, not an estimated download percentage.

## Upgrade

```sh
diffex update --self
diffex --version
```

Self-update validates the response from `https://api.diffex.ai/api/latest-version` and installs exactly `@diffexai/diffex@<verified-version>` using the detected package manager.
The updater intentionally disables lifecycle scripts; this stricter update policy is independent of the ordinary npm installation command.
It rejects malformed metadata, foreign package names, redirects, and unavailable discovery before starting installation.
`--force` permits reinstalling a verified release; it does not bypass identity checks.
The discovery service can report no generally announced release even when a bootstrap package exists on npm.

To install a reviewed npm version directly, including when discovery has no release:

```sh
npm i -g --registry=https://registry.npmjs.org '@diffexai/diffex@<verified-version>'
diffex --version
```

Replace `<verified-version>` before running the command.
Use your original npm prefix if it differs from the active default.
Legacy clients that still trust Pi cannot migrate just by contacting the Diffex endpoint.
Install the canonical package directly with the command above, then verify `command -v diffex` and `diffex --version`.

## Diagnose installation failures

Check the active tools and installation before retrying:

```sh
node --version
npm --version
npm prefix -g
command -v diffex
```

For pnpm, also check `pnpm --version` and `pnpm bin -g`.
Changing Node installations can change both the active executable and the global prefix.

| Error or symptom | Action |
| --- | --- |
| `EBADENGINE`, unsupported engine, or the Node requirement message | Upgrade to Node.js 22.19.0 or newer using your Node version manager, then retry with the same manager and prefix. |
| `EACCES` or `EPERM` | Use a user-writable prefix or the Node version manager that owns the installation. Do not recursively change permissions on the global directory or other packages. |
| `diffex: command not found` after a successful install | Check the npm prefix or `pnpm bin -g`, add its executable directory to PATH, and open a new terminal. |
| `ETIMEDOUT`, `ECONNRESET`, or registry fetch failure | Check your network, proxy, and configured registry. Retry the exact pinned installation command. |
| `ETARGET` or `ERR_PNPM_NO_MATCHING_VERSION` | Check whether your registry mirror has the reviewed version; wait for it to refresh or use the canonical npmjs.org registry. Do not substitute an unverified version. |
| `EINTEGRITY` or tarball integrity failure | Retry from a trusted registry or refreshed mirror. Do not disable integrity checks. |
| `ENOSPC` | Free space on the installation and cache disks, then retry. |
| `ENOTEMPTY` during npm replacement | Follow the recovery procedure below; do not delete settings or sessions. |

Do not clear the entire npm cache or pnpm store as a first response to an unrelated error.
If reporting a failure, include the command, OS/architecture, Node and package-manager versions, and the first error code. Redact tokens, proxy credentials, and private registry URLs.

## Recover an interrupted installation

Npm owns replacement of an npm installation.
If an update was interrupted or `diffex` no longer starts, repeat the pinned npm install command with the same verified version and prefix, then check `diffex --version` and `diffex --help`.
Do not remove your user-data directory to repair an executable installation.
Npm can begin filesystem replacement before a download finishes.
If retrying reports `ENOTEMPTY` while renaming to a `.diffex-...` backup, move that reported backup directory aside.
If npm instead reports `ENOTEMPTY` while removing a dependency inside `$(npm root -g)/@diffexai/diffex`, move that complete CLI installation directory aside.
This preserves the partially installed package and lets npm install into an empty destination.
Use a separate backup directory and retry:

```sh
DIFFEX_RECOVERY_FROM='/exact/affected/CLI/installation/or/backup'
DIFFEX_RECOVERY_DIR="$(mktemp -d)"
mv "$DIFFEX_RECOVERY_FROM" "$DIFFEX_RECOVERY_DIR/"
npm i -g --registry=https://registry.npmjs.org '@diffexai/diffex@<verified-version>'
diffex --version
diffex --help
```

Replace both placeholders with the affected Diffex installation or backup path and the verified version.
Move only the `@diffexai/diffex` package directory or its reported `.diffex-...` backup, preserving it until the repaired installation works.
Do not move the global prefix, its shared `node_modules`, or another package.
This procedure does not move or delete your settings or sessions.

## Remove

```sh
npm uninstall -g --ignore-scripts @diffexai/diffex
command -v diffex
```

Use the npm prefix that installed the executable.
The final command should find no executable unless another installation remains on PATH.
If your shell caches command locations, open a new terminal or refresh its command cache.

Removal retains settings, credentials, sessions, installed extensions, and harness data under `~/.diffex/agent/`, or the directory selected by `DIFFEX_CODING_AGENT_DIR`.
Project `.diffex` directories and any separately configured session directory are also retained.
Keep this data for reinstallation; delete it separately only if you intend to erase it.

## Repair and remove pnpm installations

Retry a failed pnpm installation with the same manager and reviewed version:

```sh
pnpm add -g --ignore-scripts --registry=https://registry.npmjs.org '@diffexai/diffex@<verified-version>'
diffex --version
diffex --help
```

Do not apply npm's `.diffex-...` backup recovery procedure to pnpm's shared store.
To remove the pnpm-managed executable while retaining settings and sessions:

```sh
pnpm remove -g @diffexai/diffex
command -v diffex
```

## Bun package installations

The same npm package can also be installed by Bun while running on Node:

```sh
bun install -g --ignore-scripts @diffexai/diffex
diffex --version
diffex update --self
bun uninstall -g @diffexai/diffex
```

Use `bun pm bin -g` to locate Bun's global executable directory and add it to PATH.
Pin direct upgrades to the reviewed `@diffexai/diffex@<verified-version>` in the install command.
Use the manager that owns the installation for repair and removal.
User data follows the same retention policy.
