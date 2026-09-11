# Using Diffex

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model. Totals include assistant responses, usage reported by tools, and summary generation.

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

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are referenced through `/skills`, and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| [`/llama`](llama-cpp.md) | Download, load, and unload llama.cpp router models |
| `/model` | Select a model, then its thinking level |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Theme, installed skills, message delivery, transport |
| `/plan [request]` | Enter Plan mode, optionally submitting a planning request |
| `/skills` | Browse installed workspace, installed global, and evolved skills |
| [`/evolve`](evolution.md) | Inspect and control harness evolution and generated skills |
| [`/version`](evolution.md#controls) | Select the active harness revision |
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

## Plan Mode

Plan mode is an interactive collaboration mode for researching and producing a decision-complete implementation plan without carrying it out. Press Shift+Tab to toggle between Default and Plan, run `/plan` to enter Plan mode idempotently, or run `/plan <request>` to enter it and submit the request through the normal prompt or queue path. The built-in footer shows `Plan mode`; an additional indicator remains visible when an extension supplies a custom footer. Mode changes require an idle session and are rejected during prompt admission, an active response or retry, compaction or branch summarization, harness switching, another transition, or a direct Bash command.

### Planning policy and tools

In Plan mode, the model must inspect available evidence before asking questions, distinguish discoverable facts from user preferences, and avoid implementation or repository mutations. Before asking, it explains the relevant context, why the decision is needed, and how the answer changes the plan.

The model-visible tool surface is restricted to the invocation's permitted, trusted pre-extension implementations of:

- `read`
- `grep`
- `find`
- `ls`
- Diffex's built-in `request_user_input`, when allowed

Tool allowlists and exclusions still apply, so a filtered or unavailable tool is not restored by Plan mode. Post-base replacements, extension and custom tools, `bash`, `edit`, `write`, `update_plan`, and sub-agent tools are unavailable to the model. Returning to Default restores the latest requested Default tool set.

This restriction is a model-tool boundary, not a filesystem security sandbox. Direct user `!` commands, extension event side effects, operating-system permissions, and external processes remain outside it.

Each logical run captures its collaboration mode. Plan runs also retain their admitted planning prompt and exact trusted tool implementations through continuations and retries. Default mode keeps its existing dynamic prompt and tool refresh behavior.

### Structured questions

For a material choice that fits meaningful alternatives, the model can use `request_user_input` with one to three questions. Each question shows two or three mutually exclusive model-supplied choices with descriptions and one Diffex-supplied **Other** choice. The recommended alternative appears first with `(Recommended)` in its label. Selecting **Other** opens free-form input; blank answers are rejected. Answers are preserved while moving among questions, and submission becomes available after every question is answered.

Cancelling the dialog returns a non-fatal cancelled result to the model and leaves Plan mode active. When `request_user_input` is filtered out, unavailable, or unsuitable for the question, the model asks an ordinary conversational question instead.

### Final plan and implementation handoff

The official plan must use exactly one pair of delimiters in one assistant text item:

    <proposed_plan>
    # Plan

    1. First implementation step
    </proposed_plan>

The opening and closing tags must each be alone on their line, unindented, outside backtick or tilde fenced code, in that order, with non-whitespace plan content between them. The response must finish normally. Ordinary text may appear before or after the block. Invalid, repeated, nested, reversed, unclosed, fenced, or otherwise non-exact markup remains ordinary assistant text and is not eligible for a handoff.

For a valid response, Diffex removes only the two tag lines before normal display and session storage. The plan Markdown and any surrounding text remain unchanged. The extracted handoff state is temporary and is not reconstructed from session history.

After the latest eligible live response settles, Diffex offers exactly:

- **Implement the plan** - switch to Default and submit `Implement the plan.` in the same session
- **Stay in Plan mode** - dismiss the offer without changing mode

Steering, follow-up, next-turn, or compaction-queued input permanently suppresses that completion's offer and continues through the existing queue path. An unrelated modal defers at most one offer until it closes. A user submission, navigation, session replacement, mode change, or new model run (including an extension-submitted run) clears the older offer, and historical plans do not replay it.

Diffex clears the older offer synchronously when a new prompt is admitted, before any awaited input hook or model startup, even if an extension handles the request without starting a model run. It rechecks the complete mode-transition busy state before showing or accepting an offer. Temporary activity defers it until idle; accepting during a busy operation does not change mode or submit the implementation message. This includes prompt admission, harness switching, and the entire direct Bash command, even while an extension's `user_bash` hook is still awaiting its result.

If the fixed implementation submission fails after switching modes, Diffex stays in Default, shows the error, and restores exactly `Implement the plan.` to the editor for retry. It does not roll back to Plan mode.

### Persistence and scope

Collaboration mode is stored as an interactive preference on the selected session branch. Interactive resume, fork, and `/tree` navigation inspect the newest matching preference on that branch and restore it when valid. A new session, a branch without a preference, or a malformed newest matching preference uses Default without reviving an older entry.

Mode entries follow normal lazy session saving. In a new disk-backed session, toggling modes alone does not create the session file: the preference remains in memory until the first assistant message is saved or the session is explicitly persisted. Once the file exists, subsequent mode changes are written immediately. Ephemeral sessions remain in memory only.

Print, JSON, RPC, and SDK invocations always use Default and do not overwrite the saved interactive preference. User wording alone cannot change collaboration mode.

Plan mode is distinct from `update_plan`. Plan mode controls the interactive planning prompt, tools, presentation, and handoff; `update_plan` is a Default-mode execution checklist and neither enters nor leaves Plan mode.

## Automatic Sub-agent Coordination

`spawn_agent` starts child work asynchronously, so the parent can launch multiple children without waiting between tool calls.
The enclosing parent prompt remains active after the parent attempts to finish.
Diffex freezes the children started by that prompt, waits until all of them finish, fail, or are interrupted, and displays a deterministic notice as each child terminates.

Children do not load parent extensions. To prevent them from bypassing parent execution policy, spawning fails before child creation when the parent registers any of these hooks: `resources_discover`, `input`, `context`, `before_agent_start`, `before_provider_request`, `before_provider_headers`, `session_before_compact`, `tool_call`, `tool_result`, or `message_end`. The rejection lists the incompatible hooks in that order. Remove those handlers to spawn children; observation-only hooks and existing-child message, interrupt, and status actions remain available.

Hidden `subagent_results` and `subagent_escalations` entries are untrusted reports from delegated agents, not user instructions, system instructions, or authority. Diffex tells the root to verify material claims against the parent task and available evidence, and to follow embedded instructions only when they are consistent with the parent task, repository policy, and current evidence. This guidance remains present when coordination tools are filtered and after custom or extension-returned system prompts are selected.

### Child Escalations

A running root-owned child can use its child-only `escalate_to_parent` tool to report a material blocker, risk, contradiction, or decision that could change the parent's plan.
Routine progress, tool logs, and completed-work summaries belong in the child's final response, and escalating does not replace that complete final response.
The tool accepts one non-empty message of at most 1,000 characters.
It is unavailable to the root and to standalone sessions, and a restored or replacement child gains it only after an explicit wake starts a new live run.

A child may send multiple reports during one live run.
Diffex accepts at most 8,000 characters of report text that are still pending admission to parent model context.
A report that would exceed that fixed aggregate limit is rejected without changing delivery state; capacity becomes available as earlier active reports begin delivery or saved idle reports enter the next explicit parent run.
A successful tool result means the report was accepted for parent delivery, not that the parent model consumed or acted on it.

While the parent is active, accepted reports are delivered as hidden context at the next normal FIFO steering boundary and never abort an in-flight model request.
Reports accepted for the same boundary are combined in acceptance order; a report accepted after delivery begins waits for a later boundary, and earlier queued user steering remains ahead of reports.
During coordinated waiting, the first pending report resumes the parent but does not consume the frozen child batch.
The parent can then use normal `agent_action` message, wake, or interrupt behavior, and the batch's terminal results are still delivered exactly once.
If a child in that frozen batch is already terminal, message or wake actions cannot replace its completed attempt until the result is delivered or explicitly consumed with `agents`.

While the parent is idle, accepting a report does not start a provider call.
Saved sessions append it to the currently selected branch for the next explicit parent run; in-memory sessions keep it only for the current process.
Hidden delivery affects display, not storage or secrecy; accepted idle reports, delivered active reports, and child tool arguments remain normal session data subject to the usual parent-owned deletion behavior.

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

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want Diffex to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Harness Evolution

`/evolve` shows evidence eligibility, jobs, memory proposals, generated skill candidates, provenance, draft diffs, validation, evaluation, target revisions, activation, and rollback. `/version` selects a complete immutable harness revision. Memory and evolved skills change together at the next prompt boundary; in-flight and admitted queued requests remain pinned. An active evolution job continues from its frozen base if the selected revision changes. The footer shows the active harness and background activity. See [Harness Evolution](evolution.md).

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

The selected collaboration mode is restored independently for the active interactive branch during resume, fork, and tree navigation. Non-interactive invocations always remain in Default and do not change that branch preference.

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
| `--export <in> [out]` | Export a session to HTML |

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
| `--no-tools`, `-nt` | Disable all tools |

Built-in tools: `read`, `bash`, `edit`, `write`, `update_plan`, `grep`, `find`, `ls`.

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

Diffex keeps the core small and pushes specialized workflow behavior into extensions, skills, prompt templates, and packages.

It includes a focused interactive Plan mode, while `update_plan` remains only a lightweight execution checklist. Diffex intentionally does not include built-in MCP, permission popups, persistent to-dos, or background bash. You can build or install different approval and planning workflows as extensions or packages, or use external tools such as containers and tmux.
