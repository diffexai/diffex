# Diffex Terminal-Bench installation

This private Python package implements the installation stage of a Harbor adapter.
Task execution, credentials, trial isolation, outcome parsing, and trajectories belong to subsequent implementation steps.
Calling `DiffexAgent.run()` currently raises `NotImplementedError` so an installation check cannot be mistaken for a benchmark result.

## Host setup

Use Python 3.13 and uv (validated with uv 0.11.2).
The benchmark has its own Python environment and lockfile, outside the npm workspaces.

```bash
cd evals/terminal-bench
uv sync --locked
uv run --locked python -c 'from diffex_terminal_bench.adapter import DiffexAgent; print(DiffexAgent.import_path())'
```

The import path is `diffex_terminal_bench.adapter:DiffexAgent`.
Harbor is pinned to `0.23.0` in `pyproject.toml` and `uv.lock`.
The adapter follows that release's `BaseInstalledAgent.install(environment)` interface.
See [Harbor's installed-agent documentation](https://www.harborframework.com/docs/agents).

## Installation contract

The task container must provide Debian/Ubuntu Linux with glibc, root access, Bash, GNU coreutils, and network access to its apt mirrors, nodejs.org, and registry.npmjs.org.
Linux x86_64 and aarch64 have separate pinned Node archive checksums.
The installer fails explicitly on unsupported platforms and refuses to reuse an existing installation.

[pins.toml](src/diffex_terminal_bench/pins.toml) records Node `22.23.2`, Diffex `0.2.2`, the public npm registry, archive checksums, npm integrity, and a 600-second installation deadline.
The deadline includes apt prerequisites, Node download, npm installation, and all three CLI checks.
GNU `timeout` terminates the installer process group at the deadline and kills it after a ten-second grace period.
Harbor's command transport allows another five seconds to collect the result.

Setup installs Node under `/opt/diffex-terminal-bench/node` and uses `npm install --ignore-scripts --save-exact --registry=https://registry.npmjs.org/ @diffexai/diffex@0.2.2` with a private prefix.
An isolated home and npm cache prevent host or task npm settings from changing installation.
Node archive SHA-256, registry metadata, installed package version, and npm lockfile integrity must match the checked-in pins.
The `/usr/local/bin/diffex` wrapper always invokes the pinned Node binary.
No monorepo source files or provider credentials are required inside the container.

Setup then runs `diffex --version`, `diffex --help`, and `diffex --list-models` from `/tmp` with stdin closed and a fresh smoke-state directory.
The setup directory under Harbor's agent logs contains installation stdout/stderr, registry metadata, the resolved npm installation lockfile, and stdout/stderr for each CLI check.
`installation.json` is written only after every check passes and records installed versions, integrity, elapsed time, and the deadline.

## Production exclusion

This directory is outside every npm workspace and every production package's file allowlist.
The repository root is npm-private, and this Python package carries the `Private :: Do Not Upload` classifier.
Do not publish it to npm or PyPI.
Generated environments, Python caches, `results/`, and Harbor `jobs/` are ignored locally.

## Updating pins

Change the Harbor requirement and matching runtime pin together, then regenerate `uv.lock` with `uv lock` and review the dependency changes.
Update Node checksums from the selected release's [official SHASUMS256.txt](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt).
For Diffex, query the exact release with `npm view @diffexai/diffex@VERSION version dist engines --json --registry=https://registry.npmjs.org/` and review the new version, engine requirement, and integrity.
Rerun the clean Linux installation checks after any pin change.
