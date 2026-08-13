# Task Profiles

Task profiles let one Diffex harness handle coding, research, finance, healthcare, legal work, and tasks that were not anticipated when Diffex was built.
A profile is a versioned bundle of task instructions, routing metadata, tool policy, guardrails, context-file rules, and compaction instructions.

Diffex includes `general`, `coding`, `research`, `finance`, `healthcare`, and `legal` profiles.
High-stakes profiles require current sources and qualified human review rather than claiming professional authority.

## Routing

The CLI uses automatic intent routing unless a profile is pinned by the user, settings, or restored session metadata.
The router evaluates the requested outcome, not the user's profession or an incidental topic mention.

On the first substantive prompt, Diffex selects the best matching profile.
If a later prompt starts a clearly distinct task that needs another profile, Diffex creates a linked session runtime and passes it a bounded handoff.
The original session remains unchanged.
Prompts submitted while a response or compaction is active are classified before they enter the queue.
Public skill and prompt-template commands are classified from their expanded content, while built-in and extension slash commands retain precedence and bypass task classification.
If no existing profile adequately fits a clear task, Diffex creates a provisional profile from the generated-profile template.
Ambiguous requests and low-confidence classifications stay in the current profile.

Use `/profile <id>` to start a linked session pinned to a profile.
Use `/profile auto` to allow automatic routing again.

Pin a profile from the CLI by ID or path:

```bash
pi --profile research "Compare the evidence for these claims"
pi --profile ./profiles/my-domain "Handle this specialized task"
pi --profile auto "Choose the appropriate workflow"
```

An explicit ID or path pins the session.
`auto` overrides a configured default and enables routing.

## Profile files

User profiles are discovered under `~/.pi/agent/profiles/`.
Profiles in a trusted project are discovered under `.pi/profiles/`.
Each profile directory contains a `profile.json` manifest and normally a prompt file such as `PROMPT.md`.
Profiles can also be supplied through `settings.json`, a Diffex package manifest, or an explicit path.

A minimal profile manifest looks like this:

```json
{
  "schemaVersion": 1,
  "id": "policy-analysis",
  "name": "Policy Analysis",
  "description": "Source-grounded public policy analysis.",
  "promptFile": "PROMPT.md",
  "routing": {
    "description": "Use for analysis of public policy evidence and tradeoffs.",
    "examples": ["Compare the evidence for these policy options"],
    "keywords": ["policy", "regulation", "public administration"]
  },
  "tools": {
    "default": ["read"],
    "required": [],
    "denied": ["edit", "write"]
  },
  "guardrails": {
    "highStakes": false,
    "requireHumanReview": false,
    "requireCurrentSources": true,
    "disallowedActions": [],
    "instructions": ["Separate evidence from inference."]
  },
  "context": {
    "fileNames": ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD"],
    "label": "User instructions"
  },
  "promptGuidelines": ["Cite primary sources when possible."],
  "compactionInstructions": "Preserve claims, sources, dates, uncertainty, decisions, and pending work."
}
```

Use exactly one of `prompt` or `promptFile`.
Profile IDs use lowercase letters, numbers, and hyphens.

A package can expose profiles with its `pi.profiles` field:

```json
{
  "pi": {
    "profiles": ["./profiles"]
  }
}
```

Use `defaultProfile` in `settings.json` to pin a default profile by ID or path.
Omit `defaultProfile`, or set it to `"auto"`, to keep automatic routing enabled.

### Routing cost

Routing classifies every prompt, so it runs on a small model rather than the session model.
By default Diffex picks the cheapest model from the same provider and API that still has enough context for the router prompt, and falls back to the session model when there is no cheaper sibling.
Set `routerModel` in `settings.json` to `"provider/model"` to choose one explicitly, or `"auto"` to restore automatic selection.
Pinning a profile disables routing entirely, so no classification request is made.

## User instructions

`AGENTS.md` is the user-controlled instruction layer for global and repository guidance.
Diffex reads `~/.pi/agent/AGENTS.md` and applicable files from the current directory and its ancestors.
`AGENTS.override.md` replaces the other instruction file in the same directory.
The coding profile also reads `CLAUDE.md` for compatibility.

The model can read these files but the self-evolution path cannot modify them.
Only the user should change repository and global instruction files.

## EVOLVED.md

The global `~/.pi/agent/EVOLVED.md` starts as an empty user-visible file.
A trusted project can also use `.pi/EVOLVED.md`; Diffex creates that project file only when the first project-scoped lesson is recorded.
The user can inspect and edit either file directly.

The model can append a bounded, structured lesson only through the `evolve` tool.
Direct model writes to `EVOLVED.md`, instruction files, and profile files are blocked.
Do not store secrets, credentials, full transcripts, or temporary task state in evolution notes.

Built-in, package, and user-authored profiles are immutable to self-evolution.
Matching notes remain a separate advisory context layer for those profiles.
At session finalization, only a generated profile may append relevant, bounded global notes from `EVOLVED.md` to its prompt.
Project-scoped notes remain project-local advisory context and are never persisted into a globally reusable generated profile.
This keeps tuned profiles predictable while allowing a new domain profile to improve from explicit, inspectable lessons.

## SDK

The direct SDK starts from the neutral `general` profile and records automatic-routing intent by default.
Automatic profile classification and runtime replacement are performed by `AgentSessionRuntime`; a bare `AgentSession` uses its currently loaded profile.
Pin a profile with `profile`:

```typescript
const { session } = await createAgentSession({
  profile: "research",
  profileRouting: "pinned",
  sessionManager: SessionManager.inMemory(),
});
```

Use `profile: "auto"` with `profileRouting: "auto"` when a host will continue automatic routing and runtime replacement.
A custom `ResourceLoader` must expose the profile registry, active profile, and evolved notes in addition to the other resources.

## SYSTEM.md removal

Diffex no longer discovers `SYSTEM.md` or `APPEND_SYSTEM.md` from global or project directories.
Move stable task behavior into a task profile and put user or repository guidance in `AGENTS.md`.
Explicit `--system-prompt`, `--append-system-prompt`, and SDK prompt overrides remain available for one-off host-controlled customization.
