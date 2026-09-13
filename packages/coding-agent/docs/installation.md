# Install, update, and remove Diffex

Diffex is distributed through npmjs.org as `@diffexai/diffex`.
Use Node.js 22.19.0 or newer and npm on macOS or Linux, on arm64 or x64.
Windows, Android/Termux, standalone binaries, and additional installation channels are not accepted release targets.
The hosted runtime image is for the cloud service.

## Install and verify

```sh
node --version
npm --version
npm install -g --ignore-scripts --registry=https://registry.npmjs.org @diffexai/diffex
diffex --version
diffex --help
diffex --list-models
```

Only the CLI package is needed; its internal Diffex modules are included.
`--ignore-scripts` disables dependency installation scripts.
Npm verifies downloaded package bytes against registry integrity metadata.
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

## Upgrade

```sh
diffex update --self
diffex --version
```

Self-update validates the response from `https://api.diffex.ai/api/latest-version` and installs exactly `@diffexai/diffex@<verified-version>` using the detected package manager.
It rejects malformed metadata, foreign package names, redirects, and unavailable discovery before starting installation.
`--force` permits reinstalling a verified release; it does not bypass identity checks.
The discovery service can report no generally announced release even when a bootstrap package exists on npm.

To install a reviewed npm version directly, including when discovery has no release:

```sh
npm install -g --ignore-scripts --registry=https://registry.npmjs.org '@diffexai/diffex@<verified-version>'
diffex --version
```

Replace `<verified-version>` before running the command.
Use your original npm prefix if it differs from the active default.
Legacy clients that still trust Pi cannot migrate just by contacting the Diffex endpoint.
Install the canonical package directly with the command above, then verify `command -v diffex` and `diffex --version`.

## Recover an interrupted installation

Npm owns replacement of an npm installation.
If an update was interrupted or `diffex` no longer starts, repeat the pinned npm install command with the same verified version and prefix, then check `diffex --version` and `diffex --help`.
Do not remove your user-data directory to repair an executable installation.
Npm can begin filesystem replacement before a download finishes.
If retrying reports `ENOTEMPTY` while renaming to a `.diffex-...` backup, move the exact destination shown by npm to a separate backup directory and retry:

```sh
DIFFEX_RECOVERY_FROM='/exact/destination/from/npm/error/.diffex-...'
DIFFEX_RECOVERY_DIR="$(mktemp -d)"
mv "$DIFFEX_RECOVERY_FROM" "$DIFFEX_RECOVERY_DIR/"
npm install -g --ignore-scripts --registry=https://registry.npmjs.org '@diffexai/diffex@<verified-version>'
diffex --version
diffex --help
```

Replace both placeholders with the reported Diffex backup path and verified version.
Move only that package backup, preserving it until the repaired installation works.
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
