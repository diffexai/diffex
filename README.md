<p align="center">
  <a href="https://diffex.ai/">
    <img src="docs/assets/diffex-wordmark.png" alt="diffex.ai wordmark" width="760">
  </a>
</p>

<p align="center">
  <a href="https://diffex.ai/"><img alt="Website" src="https://img.shields.io/badge/site-diffex.ai-black.svg" /></a>
  <a href="package.json"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/node-%3E%3D22.19.0-339933.svg?logo=node.js&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <a href="https://github.com/diffexai/diffex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/diffexai/diffex/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
</p>

# Diffex

Diffex is a TypeScript agent harness and interactive coding agent.
It provides a multi-provider LLM API, a general-purpose agent runtime, a terminal UI, remote session protocols, and an extensible coding-agent CLI.

Diffex treats the agent harness as an optimization target instead of a static configuration.
The project is evolving the harness around observable behavior, diagnostic signals, and evidence-backed improvements.

This repository is the current Node.js and TypeScript implementation.
The archived Rust implementation is available at [diffexai/diffex-legacy](https://github.com/diffexai/diffex-legacy).

Read more at [diffex.ai](https://diffex.ai/) and in the [Diffex white paper](https://diffex.ai/white-paper).

## Fork Status

Diffex is a fork of the [Pi Agent Harness](https://github.com/earendil-works/pi).
The workspace packages and CLI now use Diffex-owned names.
Use `./diffex-test.sh` to run the Diffex-branded coding agent directly from this repository.

## Workspace Packages

| Package | Responsibility |
|---------|----------------|
| [`packages/telemetry`](packages/telemetry) | Vendor-neutral telemetry contracts and typed schemas. |
| [`packages/ai`](packages/ai) | Unified LLM API with provider and model discovery. |
| [`packages/agent`](packages/agent) | Agent runtime, tool calling, state management, and attachments. |
| [`packages/protocol`](packages/protocol) | Transport-neutral CBOR protocol for remote sessions. |
| [`packages/client`](packages/client) | Transport-neutral client for remote sessions. |
| [`packages/server`](packages/server) | Experimental remote session server. |
| [`packages/session-backends/sqlite-node`](packages/session-backends/sqlite-node) | SQLite session persistence for Node.js. |
| [`packages/tui`](packages/tui) | Terminal UI components with differential rendering. |
| [`packages/coding-agent`](packages/coding-agent) | Interactive coding-agent CLI and extension system. |
| [`packages/evals`](packages/evals) | Evaluation utilities and scenarios. |

## Local Setup

Diffex requires Node.js 22.19 or newer and npm.

```bash
git clone https://github.com/diffexai/diffex.git
cd diffex
npm install --ignore-scripts
npm run build:offline
./diffex-test.sh
```

The source launcher can be run from any directory and preserves the caller's working directory.

## Local Validation

```bash
npm run check
./test.sh
```

`npm run check` runs formatting, linting, dependency policy checks, and TypeScript validation.
`./test.sh` runs the non-E2E test suites without activating tests that require provider credentials.

## Documentation

- [Coding-agent documentation](packages/coding-agent/docs/index.md)
- [Containerization and sandboxing](packages/coding-agent/docs/containerization.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Project rules](AGENTS.md)

## Permissions and Containerization

Diffex does not impose a built-in security boundary around filesystem, process, network, or credential access.
By default, it runs with the permissions of the user and process that launched it.

Use a container or sandbox when stronger isolation is required.
See the [containerization guide](packages/coding-agent/docs/containerization.md) for supported patterns.

## Contributing

Issues and pull requests are welcome.
Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation, and review expectations.
Participation in the project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Do not commit credentials, secrets, local machine artifacts, build output, or private deployment state.
Report sensitive issues privately through the repository maintainers or the contact paths on [diffex.ai](https://diffex.ai/).

## License

Diffex contributions are distributed under the [Apache License 2.0](LICENSE).
Portions derived from Pi remain available under the MIT License, with the upstream copyright and permission notice preserved in the license file.
