# Task Profiles and Harnesses

Task profiles let Diffex support coding, research, finance, healthcare, legal work, and unanticipated tasks without making the core harness specific to any one field.
A task profile is an immutable bundle of base instructions, routing metadata, tool policy, guardrails, and compaction guidance.
A harness descriptor gives a task a stable identity while referring to one immutable built-in profile and its applicable `EVOLVED.md` notes.

Diffex includes `general`, `coding`, `research`, `finance`, `healthcare`, and `legal` profiles.
High-stakes profiles require current sources and qualified human review rather than claiming professional authority.
Automatic routing evaluates the requested outcome, not the user's profession or an incidental topic mention.

## Prompt stack

Every composed system prompt has three top-level layers in this order:

1. **Base** contains exactly one resolved profile portion: the thin `DEFAULT` prompt or an immutable `PROMPT_PROFILE`.
   Necessary native harness rules, profile guardrails, tool guidance, documentation pointers, skill guidance, and concise runtime facts are folded into this same base layer.
   Tool JSON schemas remain out-of-band runtime data.
2. **User instructions** contains the applicable read-only `AGENTS.md` and `CLAUDE.md` files.
3. **Evolved notes** contains only the bounded `EVOLVED.md` notes applicable to the active harness.

The layer order is fixed so provenance remains inspectable and later observations cannot silently replace a tuned base profile or user instructions.
Evolved notes are advisory and cannot expand tool access, authority, or other capabilities.

An explicit CLI or SDK custom system prompt replaces the profile portion inside the base layer.
An explicit append system prompt is appended inside that same profile portion.
Neither option creates a fourth top-level prompt layer.

## Automatic lifecycle

An automatic session begins with the neutral `general` bootstrap profile, which renders a genuinely thin `DEFAULT` profile portion inside the base layer.
Diffex completes the first accepted user task with that default before running any task classifier.
This avoids a speculative pre-turn model call and ensures the user's first request is answered even if classification later fails.

After the initial response completes, Diffex performs exactly one harness resolution:

1. The router considers compatible evolved harnesses first.
2. If none clearly matches, it selects one immutable built-in base profile.
3. A new selection creates a prompt-free harness descriptor that records only identity, description, base-profile reference, and creation time.
4. Diffex activates the resolved harness for subsequent turns and records its identity and EVOLVED-derived revision in session metadata.

Low-confidence, invalid, or failed routing uses a conservative fallback.
An unambiguous finance, healthcare, or legal primary task selects that high-stakes profile, while ambiguous or unmatched work remains on `general`.
Coding deliverables with incidental high-stakes terminology remain on `general` during fallback.
The router never invents a prompt, creates a generated `PROMPT.md`, or modifies an existing profile.
A harness descriptor is not a prompt profile and contains no authored instructions.

Routine follow-ups remain in the active harness.
Before an idle later prompt is delivered, Diffex conservatively checks whether it clearly begins a materially different task.
Incidental terminology, refinements, and ambiguous requests stay in the current harness without interrupting the user.

When a clear boundary is found in interactive or RPC mode, Diffex pauses the submitted prompt and asks whether to switch:

- Accepting an existing evolved harness starts a fresh linked session on its immutable base profile.
- Accepting a new task creates only a metadata descriptor, starts a fresh linked session on the selected immutable base profile, and leaves all prompt profiles unchanged.
- Declining processes the submitted prompt exactly once in the current harness.
- Cancelling does not submit the prompt.

Distinct tasks may use the same base profile, such as two unrelated coding projects or two unrelated general tasks.
Print and JSON modes never auto-accept a task switch because they have no confirmation channel.
Explicit steering and follow-up queue commands are treated as continuations while a response is active.

Prompts submitted while a response or compaction is active are admitted in order and do not trigger duplicate harness resolution.
Public skill and prompt-template commands are classified from their expanded content after the initial turn, while built-in and extension slash commands retain precedence and bypass classification.

## Harness descriptors

Harness descriptors are runtime-managed JSON files under `~/.pi/agent/harnesses/`.
Their IDs use lowercase letters, numbers, and interior hyphens.
The model cannot author or edit them.

A descriptor points to an immutable built-in base profile rather than copying its prompt.
Its revision is derived from the descriptor identity and applicable EVOLVED note hashes, so a resumed session can audit which evolved state it restored.
Once a harness has a harness-scoped durable lesson, it becomes eligible for reuse by a later automatic session whose task clearly matches its description.
Project-scoped lessons affect reuse only while that trusted project context is present.

This separation keeps carefully tuned prompts predictable while allowing future sessions to reuse task-specific learning through an inspectable note layer.

## Manual selection

Use `/profile <id>` to start a linked session pinned to a profile.
Use `/profile auto` to start from the automatic lifecycle again.

Pin a profile from the CLI by ID or path:

```bash
pi --profile research "Compare the evidence for these claims"
pi --profile ./profiles/my-domain "Handle this specialized task"
pi --profile auto "Start with DEFAULT, then resolve the harness"
```

An explicit ID or path pins the session and applies that immutable profile immediately.
`auto` overrides a configured default and enables post-turn initial resolution plus confirmed future task switches.

### Routing cost

Automatic routing makes one classification request after the first accepted task turn.
After a harness exists, substantive idle prompts are conservatively classified before delivery so clear task changes can be confirmed.
No second model request is made when deterministic fallback can identify a clear target after router failure, and no switch is applied without host confirmation.
By default Diffex uses the active session model so routing quality and model behavior remain predictable.
Set `routerModel` in `settings.json` to `"provider/model"` to choose a dedicated model explicitly, or `"auto"` to restore use of the active session model.
Pinning a profile disables classification entirely.

## Custom profile files

User profiles are discovered under `~/.pi/agent/profiles/`.
Profiles in a trusted project are discovered under `.pi/profiles/`.
Each profile directory contains a `profile.json` manifest and normally a prompt file such as `PROMPT.md`.
Profiles can also be supplied through `settings.json`, a Diffex package manifest, or an explicit path.

Custom and package profiles are immutable to model self-evolution, just like built-ins.
The user or package author can revise their source files, but Diffex never tunes them from session history.
Automatic resolution selects only built-in profiles, while a custom profile can be pinned explicitly by ID or path.

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
Omit `defaultProfile`, or set it to `"auto"`, to use the automatic lifecycle.

## User instructions

`AGENTS.md` and `CLAUDE.md` are independent, user-controlled instruction sources for global and repository guidance.
Diffex reads applicable files from `~/.pi/agent/`, the current directory, and its ancestors.
When `AGENTS.override.md` exists in a directory, it replaces the `AGENTS.md` variant in that same directory, but it does not suppress `CLAUDE.md`.
`CLAUDE.md` is loaded for compatibility in every profile, not only the coding profile.

The model can read these files but cannot modify them through self-evolution.
Only the user should change repository and global instruction files.

## EVOLVED.md

The global `~/.pi/agent/EVOLVED.md` starts as an empty, user-visible file.
A trusted project can also use `.pi/EVOLVED.md`; Diffex creates that project file only when the first project-scoped lesson is recorded.
The user can inspect and edit either file directly.

The model can append a bounded, structured lesson only through the validated `evolve` tool.
Direct model writes to `EVOLVED.md`, profile files, harness descriptors, `AGENTS.md`, and `CLAUDE.md` are blocked.
The validated `evolve` tool records task lessons under the active harness ID, or under the pinned base profile before a harness exists.
Free-form notes written directly by the user are loaded with the `*` identifier and apply user-wide.
Project-scoped notes remain project-local.

Applicable notes are bounded, deduplicated, and composed only into the final evolved layer.
They never rewrite the immutable base profile or user instruction files.
Do not store secrets, credentials, full transcripts, or temporary task state in evolution notes.

There is no generated-profile finalization step.
Diffex does not create or append to `PROMPT.md` at turn completion or session shutdown.
All durable model-authored learning flows through `EVOLVED.md`.

## Native runtime telemetry

Harness telemetry is passive structural tracing through an explicit `TelemetryContext`.
The default context is a no-op, and there is no default exporter or coupling to install analytics.
A host can opt into a bounded, process-local capture and read newly settled spans by cursor after a turn.
The host owns capture lifetime, retention, and any downstream evolution policy.

Native spans describe lifecycle structure such as runs, turns, steps, tool execution, routing, and evolution outcomes.
They exclude raw prompts and completions, system-profile and instruction content, EVOLVED note content, file paths and contents, tool arguments and results, provider payloads, headers, credentials, router explanations, handoffs, and free-form errors.
Traces are not durable application state and are never copied into session files.

A host may use structural signals to decide whether bounded local transcript evaluation is warranted.
Any accepted durable lesson still passes through the normal EVOLVED validation and writer.
Telemetry never becomes a fourth prompt layer and never edits a profile or harness descriptor.

## SDK

`AgentSessionRuntime` owns automatic post-turn harness resolution and runtime replacement.
A bare `AgentSession` uses its currently loaded profile and does not run the automatic resolver by itself.

Pin a profile with `createAgentSession`:

```typescript
const { session } = await createAgentSession({
  profile: "research",
  profileRouting: "pinned",
  sessionManager: SessionManager.inMemory(),
});
```

Use `profile: "auto"` with `profileRouting: "auto"` when the host wraps the session in `AgentSessionRuntime` and wants automatic harness resolution.
A host that supports future-turn switching registers a task-boundary resolver on the runtime and returns `switch`, `stay`, or `cancel` for each proposed boundary.
A custom `ResourceLoader` must expose the profile registry, active profile, user instruction files, and applicable evolved notes in addition to its other resources.

## SYSTEM.md removal

Diffex does not discover `SYSTEM.md` or `APPEND_SYSTEM.md` from global or project directories.
Move stable task behavior into an immutable task profile and put user or repository guidance in `AGENTS.md` or `CLAUDE.md`.
Explicit `--system-prompt`, `--append-system-prompt`, and SDK prompt overrides remain available as host-controlled customization inside the base layer.
