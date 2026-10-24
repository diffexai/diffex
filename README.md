<p align="center">
  <a href="https://diffex.ai/">
    <img src="docs/assets/diffex-wordmark.png" alt="diffex.ai wordmark" width="760">
  </a>
</p>

<p align="center">
  <img src="docs/assets/daytona-startup-grid.png" alt="Daytona Startup Grid" width="240">
</p>

<p align="center">
  <img src="docs/assets/e2b-startups.png" alt="E2B for Startups" width="151">
</p>

<p align="center">
  <a href="https://diffex.ai/"><img alt="Website" src="https://img.shields.io/badge/site-diffex.ai-black.svg" /></a>
  <a href="https://www.npmjs.com/package/@diffexai/diffex?activeTab=readme"><img alt="Latest npm version" src="https://img.shields.io/npm/v/%40diffexai%2Fdiffex?label=diffex" /></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.19 or newer" src="https://img.shields.io/badge/node-%3E%3D22.19.0-339933.svg?logo=node.js&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" /></a>
  <a href="https://github.com/diffexai/diffex/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/diffexai/diffex/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
</p>

# Diffex

Diffex is a lightweight, self-evolving coding agent that lives in your CLI. Ask it to explore a codebase, implement features, fix bugs, and run tests—all from your terminal.

- **Work with your code:** read and edit files, run shell commands, and iterate on changes in an interactive session.
- **Choose your models:** connect subscription accounts or API keys, or use local models.
- **Make it yours:** add skills, extensions, and reusable prompts, or integrate Diffex into your own tools.

## Quick start

Requires Node.js 22.19 or newer and npm.

```bash
npm install -g --ignore-scripts @diffexai/diffex
cd your-project
diffex
```

Use `/login` to connect a supported subscription provider, or set a provider API key such as `ANTHROPIC_API_KEY` before launching. Then describe what you want to build or change.

Diffex runs with your user account's permissions. Use a container or sandbox when working with untrusted code.

## Benchmarks

Diffex scores are reported mean rewards; Codex's score is published leaderboard accuracy. Trial counts show scored / total attempts. All Diffex runs used `max` reasoning without subagents.

| Benchmark | Agent | Model | Score | Trials |
|-----------|-------|-------|------:|-------:|
| [Deep SWE 1.1](https://hub.harborframework.com/jobs/c7689ad5-0558-41cc-9b8d-576d71d2b3b0) | Diffex 0.3.2 | GPT-6 Luna | 67.27% | 110 / 113 |
| [Terminal-Bench 2.1](https://hub.harborframework.com/jobs/10462e7b-ec7d-49fa-9103-2060d4f62931) | Diffex 0.3.2 | GPT-6 Luna | 80.19% | 424 / 445 |
| [Terminal-Bench 2.1](https://hub.harborframework.com/jobs/169f8574-9c7f-411c-9fe5-489ea4471016) | Diffex 0.3.1 | GPT-5.6 Luna | 79.85% | 412 / 445 |
| [Terminal-Bench 2.1](https://github.com/harbor-framework/terminal-bench-2-1/pull/112) | Codex | GPT-5.6 Luna | 75.73% | 445 / 445 |

Deep SWE also reported **95.13% fail-to-pass** and **98.85% pass-to-pass** test scores.

On Terminal-Bench 2.1, Diffex's reported GPT-5.6 Luna score is **4.12 percentage points above Codex**, also using `max` reasoning. This is not a controlled comparison: execution environments may differ.

## Documentation

- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [Usage and commands](packages/coding-agent/docs/usage.md)
- [Providers and authentication](packages/coding-agent/docs/providers.md)
- [Local models](packages/coding-agent/docs/llama-cpp.md)
- [Skills](packages/coding-agent/docs/skills.md) and [extensions](packages/coding-agent/docs/extensions.md)
- [SDK](packages/coding-agent/docs/sdk.md) and [RPC integration](packages/coding-agent/docs/rpc.md)
- [Containerization and sandboxing](packages/coding-agent/docs/containerization.md)

## Development

```bash
git clone https://github.com/diffexai/diffex.git
cd diffex
npm install --ignore-scripts
npm run build:offline
./diffex-test.sh
```

Validate changes with:

```bash
npm run check
./test.sh
```

The checks cover formatting, linting, dependency policy, and TypeScript. The test command runs non-E2E suites without activating tests that require provider credentials.

If you find Diffex useful, please [give it a star on GitHub](https://github.com/diffexai/diffex). Help us improve Diffex by [suggesting features or reporting issues](https://github.com/diffexai/diffex/issues/new/choose), or [contributing directly](CONTRIBUTING.md).

## Acknowledgments

Thank you to the developers of [Pi](https://github.com/earendil-works/pi) for building the foundation that Diffex builds on.

## License

Apache License 2.0
