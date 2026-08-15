# Using Diffex

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - the built-in footer keeps the active profile, routing mode, and harness visible above the current model, thinking level, and context usage.

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Copy response | Ctrl+X copies the last assistant message; in `/tree`, it copies the selected message |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `externalEditor`, `$VISUAL`, `$EDITOR`, Notepad on Windows, or `nano` elsewhere |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/skill:name`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| [`/llama`](llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/plan [on\|off]` | Toggle plan mode, set it explicitly, or reopen a pending plan |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/subagents` | Show all sub-agents in the current session |
| `/tree` | Jump to any point in the session and continue from there |
| `/trust` | Save project trust decision for future sessions |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML or JSONL |
| `/import <file>` | Import and resume a session from a JSONL file |
| `/share` | Upload as a secret GitHub Gist and return its direct URL |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit Diffex |

`/subagents` runs immediately, including while the parent agent is working or compacting.
It displays the current in-memory roster without adding the command or roster to model context.

## Automatic Sub-agent Coordination

`spawn_agent` starts child work asynchronously, so the parent can launch multiple children without waiting between tool calls.
The enclosing parent prompt remains active after the parent attempts to finish.
Diffex freezes the children started by that prompt, waits until all of them finish, fail, or are interrupted, and displays a deterministic notice as each child terminates.

After the whole batch is terminal, Diffex gives the parent one hidden, name-sorted context message containing the child results, partial output, errors, and retry availability.
The parent continues automatically and produces its final response without another user prompt.
If the parent already retrieved a terminal result with `agents`, Diffex does not deliver that result again.

An initial failure gives the parent one opportunity to send a corrective `agent_action` message with `wake: true`.
Only one coordinated retry is allowed per child during the current user prompt.
The parent may decline the retry, and a later explicit user prompt starts a fresh retry cycle.

While Diffex waits, the status indicator remains active and steering or follow-up input stays queued.
Press Escape to restore queued input to the editor and interrupt unfinished children in the frozen batch.
Diffex displays interrupted notices and settles without making another parent model call.

Completion notices use assistant styling, but are not conversation messages.
They are not persisted or included in model context.
JSON and RPC modes emit the same notices as structured session events.

## Plan Mode

Start an interactive planning session with `diffex --plan`, toggle it with `/plan`, or set it explicitly with `/plan on` or `/plan off`.
Plan mode can be changed only while the session is idle.

Plan mode exposes `submit_plan` and canonical `read`, `grep`, `find`, and `ls` repository inspection tools when caller restrictions and the active task profile permit them.
Extension tools, SDK custom tools, shell execution, and file mutation tools are unavailable until the plan is accepted or discarded.
`submit_plan` is intrinsic to plan mode and remains available even when caller tool filters disable every inspection tool.
Automatic task-profile routing pauses for planning prompts.
In automatic mode, choosing Implement routes every accepted task before execution, even when a harness is already active.
The router may keep the active harness for a continuation, reuse a related harness, or switch to a newly selected task harness.
Diffex asks which profile should govern implementation only when the router finds a high-confidence ambiguity among specialized profiles.
The chooser shows each option's description, safeguards, and tool-policy summary.
The choice determines the implementation profile's expertise, safeguards, and tool access.
The recommended option receives initial focus but is not selected automatically.
Canceling the choice leaves the accepted implementation pending; use `/plan` to retry.
A malformed, low-confidence, or failed route also leaves the accepted implementation pending instead of silently falling back to another profile.
A pinned profile bypasses automatic routing and implements the plan in place.
Pin a profile before planning when its guardrails must apply during planning itself.

`submit_plan` ends the planning turn and creates a Markdown plan artifact.
The artifact remains pending in the session until you implement or discard it.
Collaboration-mode changes, submitted plans, and their resolutions are persisted in the session, so the active branch restores the correct mode, pending plan, or accepted implementation handoff after resume or tree navigation.

The `--plan` startup flag is supported only in interactive mode.
Diffex rejects it in print, JSON, and RPC modes because those modes cannot resolve a pending plan.
The same restriction applies when a resumed session's active branch is in plan mode or has an accepted implementation waiting to start.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want Diffex to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.diffex/agent/sessions/`, organized by working directory.

```bash
diffex -c                  # Continue most recent session
diffex -r                  # Browse and select a session
diffex --no-session        # Ephemeral mode; do not save
diffex --name "my task"    # Set session display name at startup
diffex --session <path|id> # Use a specific session file or session ID
diffex --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Diffex loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.diffex/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

If a directory contains `AGENTS.override.md`, Diffex loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories still layer normally.

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.diffex/SYSTEM.md` for a project
- `~/.diffex/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

### Project Trust

On interactive startup, Diffex asks before trusting a project folder that contains project-local settings, resources, or project `.agents/skills` and has no saved decision for the folder or a parent folder in `~/.diffex/agent/trust.json`. Trusting a project allows Diffex to load `.diffex/settings.json` and `.diffex` resources, install missing project packages, and execute project extensions.

Before the trust decision, Diffex loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.diffex/agent/settings.json`, or change it with `/settings`.

`diffex config` and package commands use the same project trust flow, except `diffex update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

Use `/trust` in interactive mode to save a project trust decision for future sessions, including trust for the immediate parent folder. It writes `~/.diffex/agent/trust.json` only; the current session is not reloaded, so restart Diffex for changes to take effect.


## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a secret GitHub Gist and return its direct URL.
Anyone with the URL can access the Gist.

If you use Diffex for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
diffex [options] [@files...] [messages...]
```

### Package Commands

```bash
diffex install <source> [-l]     # Install package, -l for project-local
diffex remove <source> [-l]      # Remove package
diffex uninstall <source> [-l]   # Alias for remove
diffex update [source|self|diffex]   # Update Diffex only, or one package source
diffex update --all              # Update Diffex and packages; reconcile pinned git refs
diffex update --extensions       # Update packages only; reconcile pinned git refs
diffex update --models           # Refresh model catalogs only
diffex update --self             # Update Diffex only
diffex update --extension <src>  # Update one package
diffex list                      # List installed packages
diffex config                    # Enable/disable package resources
```

These commands manage Diffex packages and `diffex update` can update the Diffex CLI installation. To uninstall Diffex itself, see [Quickstart](quickstart.md#uninstall). `diffex config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `diffex update` never prompts for project trust.

See [Diffex Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--plan` | Start interactive mode with native plan mode active |
| `--export <in> [out]` | Export a session to HTML |

Do not combine `--plan` with `-p`, `--mode json`, or `--mode rpc`.

In print mode, Diffex also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | diffex -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all normal-mode tools and plan-mode inspection tools |

Normal-mode built-in tools: `read`, `bash`, `edit`, `write`, `update_plan`, `grep`, `find`, `ls`.
Plan mode exposes `submit_plan` plus the permitted canonical subset of `read`, `grep`, `find`, and `ls`.
Tool allowlists and denylists constrain the inspection subset, but `submit_plan` remains available as an intrinsic plan-mode tool.

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
diffex --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--tui-mode <mode>` | TUI mode: `regular` (default) or experimental `fullscreen` |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

In `fullscreen` mode, the transcript scrolls inside the terminal viewport while queued messages, working status, extension widgets, editor, and footer remain fixed at the bottom. Mouse/trackpad input scrolls the region under the pointer; keyboard viewport actions always remain available. Inline images work in terminals that support the Kitty graphics protocol, including Kitty and Ghostty. In iTerm2 they render as text placeholders because its inline-image protocol cannot delete or crop placements during application-owned scrolling. In `regular` mode, Diffex uses the main screen and terminal-owned scrollback, and iTerm2 inline images continue to render normally.

Set **TUI mode** in `/settings` to switch between `regular` and `fullscreen` immediately and choose the default for future sessions.

### File Arguments

Prefix files with `@` to include them in the message:

```bash
diffex @prompt.md "Answer this"
diffex -p @screenshot.png "What's in this image?"
diffex @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
diffex "List all .ts files in src/"

# Interactive read-only planning
diffex --plan "Design the implementation before changing anything"

# Non-interactive
diffex -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | diffex -p "Summarize this text"

# Named one-shot session
diffex --name "release audit" -p "Audit this repository"

# Different model
diffex --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
diffex --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
diffex --model sonnet:high "Solve this complex problem"

# Limit model cycling
diffex --models "claude-*,gpt-4o"

# Read-only mode
diffex --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
diffex --exclude-tools ask_question
```

## Design Principles

Diffex keeps the core small and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

It includes a constrained native plan mode and session-scoped sub-agents while leaving MCP, permission popups, persistent to-dos, and background bash to extensions, packages, or external tools such as containers and tmux. The built-in `update_plan` tool remains a lightweight progress checklist.

For the full rationale, read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).
