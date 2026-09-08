# Quickstart

This page gets you from install to a useful first Diffex session.

## Install

Diffex is distributed as an npm package:

```bash
npm install -g --ignore-scripts @earendil-works/diffex-coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Diffex does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed Diffex:

```bash
# npm
npm uninstall -g @earendil-works/diffex-coding-agent

# pnpm
pnpm remove -g @earendil-works/diffex-coding-agent

# Yarn
yarn global remove @earendil-works/diffex-coding-agent

# Bun
bun uninstall -g @earendil-works/diffex-coding-agent
```

Uninstalling Diffex leaves settings, credentials, sessions, and installed Diffex packages in `~/.diffex/agent/`.

Then start Diffex in the project directory you want it to work on:

```bash
cd /path/to/project
diffex
```

## Authenticate

Diffex can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start Diffex and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching Diffex:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
diffex
```

You can also run `/login` and select an API-key provider to store the key in `~/.diffex/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once Diffex starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Diffex gives the model five tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands
- `update_plan` - track progress with an ordered task checklist

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Diffex runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give Diffex project instructions

Diffex loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Diffex loads:

- `~/.diffex/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Diffex loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart Diffex, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
diffex @README.md "Summarize this"
diffex @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Plan before implementing

Press Shift+Tab or run `/plan` to enter interactive Plan mode. `/plan <request>` enters the mode and immediately submits the request. The model inspects available evidence without implementing, using only permitted trusted `read`, `grep`, `find`, and `ls` tools plus the structured `request_user_input` tool when available.

Structured questions offer two or three choices and an **Other** free-form answer. Answer every question to submit, or cancel to continue the conversation in Plan mode. When choices are unsuitable or the question tool is filtered out, the model asks an ordinary question instead.

A valid final plan is stored and displayed as clean Markdown. After the response settles, choose **Implement the plan** to switch to Default and submit `Implement the plan.` in the same session, or **Stay in Plan mode**. Queued messages take precedence over this offer. Plan mode persists on the selected interactive session branch across resume, fork, and `/tree` navigation; print, JSON, RPC, and SDK modes always use Default.

Plan mode is separate from `update_plan`, which only tracks an execution-time progress checklist.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model, then select its thinking level when multiple levels are supported. You can select the current model to change only its thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models. Thinking-level cycling has no default shortcut; configure `app.thinking.cycle` in `keybindings.json` to enable one.

### Continue later

Sessions are saved automatically:

```bash
diffex -c                  # Continue most recent session
diffex -r                  # Browse previous sessions
diffex --name "my task"    # Set session display name at startup
diffex --session <path|id> # Open a specific session
```

Inside Diffex, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
diffex -p "Summarize this codebase"
cat README.md | diffex -p "Summarize this text"
diffex -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Diffex](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Diffex Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).
