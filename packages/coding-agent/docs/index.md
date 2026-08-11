# Diffex Documentation

Diffex is a minimal terminal agent harness.
It stays small at the core while task profiles, TypeScript extensions, skills, prompt templates, themes, and Diffex packages adapt it to different kinds of work.

## Quick start

Install Diffex with npm:

```bash
npm install -g --ignore-scripts @earendil-works/diffex-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Diffex does not require install scripts for normal npm installs.

To uninstall Diffex, use the matching package manager. For npm installs:

```bash
npm uninstall -g @earendil-works/diffex-coding-agent
```

For pnpm, Yarn, or Bun installs, use the matching global remove command: `pnpm remove -g @earendil-works/diffex-coding-agent`, `yarn global remove @earendil-works/diffex-coding-agent`, or `bun uninstall -g @earendil-works/diffex-coding-agent`.

Then run it in a project directory:

```bash
diffex
```

Authenticate with `/login` for subscription providers, or set an API key such as `ANTHROPIC_API_KEY` before starting Diffex.

For the full first-run flow, see [Quickstart](quickstart.md).

## Start here

- [Quickstart](quickstart.md) - install, authenticate, and run a first session.
- [Using Diffex](usage.md) - interactive mode, slash commands, context files, and CLI reference.
- [Task profiles](task-profiles.md) - automatic task routing, profile authoring, user instructions, and controlled evolution.
- [Providers](providers.md) - subscription and API-key setup for built-in providers.
- [llama.cpp](llama-cpp.md) - run a local router and manage models with `/llama`.
- [Security](security.md) - project trust, sandbox boundaries, and vulnerability reporting.
- [Containerization](containerization.md) - sandbox Diffex with Gondolin, Docker, or OpenShell.
- [Settings](settings.md) - global and project settings.
- [Keybindings](keybindings.md) - default shortcuts and custom keybindings.
- [Sessions](sessions.md) - session management, branching, and tree navigation.
- [Compaction](compaction.md) - context compaction and branch summarization.

## Customization

- [Extensions](extensions.md) - TypeScript modules for tools, commands, events, and custom UI.
- [Skills](skills.md) - Agent Skills for reusable on-demand capabilities.
- [Prompt templates](prompt-templates.md) - reusable prompts that expand from slash commands.
- [Themes](themes.md) - built-in and custom terminal themes.
- [Diffex packages](packages.md) - bundle and share extensions, skills, prompts, themes, and task profiles.
- [Custom models](models.md) - add model entries for supported provider APIs.
- [Custom providers](custom-provider.md) - implement custom APIs and OAuth flows.

## Programmatic usage

- [SDK](sdk.md) - embed Diffex in Node.js applications.
- [RPC mode](rpc.md) - integrate over stdin/stdout JSONL.
- [JSON event stream mode](json.md) - print mode with structured events.
- [TUI components](tui.md) - build custom terminal UI for extensions.

## Reference

- [Environment variables](environment-variables.md) - Diffex process configuration and session metadata available to bash tools.
- [Session format](session-format.md) - JSONL session file format, entry types, and SessionManager API.

## Platform setup

- [Windows](windows.md)
- [Termux on Android](termux.md)
- [tmux](tmux.md)
- [Terminal setup](terminal-setup.md)
- [Shell aliases](shell-aliases.md)

## Development

- [Development](development.md) - local setup, project structure, and debugging.
