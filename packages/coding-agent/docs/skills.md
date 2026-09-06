> Diffex can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Diffex implements the [Agent Skills standard](https://agentskills.io/specification), warning about most violations but remaining lenient. Diffex allows skill names to differ from their parent directory even though the standard disallows it; that rule is suboptimal for shared skill directories used across multiple agent harnesses.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

Diffex loads skills from:

- Global:
  - `~/.diffex/agent/skills/`
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.diffex/skills/`
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories or `diffex.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- In `~/.diffex/agent/skills/` and `.diffex/skills/`, direct root `.md` files are discovered as individual skills
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.diffex/settings.json`:

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Diffex scans skill locations and builds one catalog for the session. Each entry has a stable source identity, source kind, scope, content digest, version, and the full content captured at load time.
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills).
3. When a task matches, the agent uses `read` to load the full SKILL.md (models don't always do this; use `/skills` to reference it explicitly).
4. Explicit references use the catalog's captured version, so a file change does not alter a request that has already been admitted. Reload resources to catalog a changed installed skill.
5. Invocation traces record availability, model listing, explicit references, `/skills` force-loading, and digest-matched reads as separate facts for the exact catalog version.
6. The agent follows the instructions, using relative paths to reference scripts and assets.

This is progressive disclosure: only names, descriptions, and locations are always in context; full instructions load on-demand. The TUI, system prompt, SDK, and evolution snapshots all read from the same catalog. Trace observations do not infer that a skill was used or caused an outcome.

### Evolved Skills

Evolved skills are immutable, workspace-scoped packages in a harness revision. The package version covers `SKILL.md` and every bundled UTF-8 supporting file, while the content digest identifies `SKILL.md` itself. Diffex exposes a package only when the active revision and workspace identity match. Selecting another revision changes `EVOLVE.md` memory and the evolved-skill set together at the next prompt boundary; in-flight and already admitted queued requests remain pinned.

While workspace-matching evolved skills are active, each completed assistant turn (including its tool results) requests a bounded private skill-feedback call on the output's model. Only exact package-file reads and admitted references delivered during that turn qualify for helpful/harmful ratings; catalog listing and undelivered queued references do not. Malformed, neutral, duplicate, or uninvoked claims discard the whole report without retry. Reports bypass session messages, extension request/event hooks, traces, exports, compaction, and evolution snapshots. Validated reports have an internal scoring-consumer interface; point application and retention are separate work and are not enabled by this transport.

An evolved reference binds its skill ID, content version, digest, workspace, and harness revision. A reference from an inactive revision is rejected. `/reload` refreshes installed skills while preserving the evolved overlay from the active harness. Accepted evolved skills activate automatically after validation and any configured evaluation finish. Use `/evolve` to inspect provenance, validation, available evaluation results, activation, and rollback. See [Harness Evolution](evolution.md).

## Skill Commands

Use `/skills` in interactive mode to browse Installed Workspace Skills, Installed Global Skills, and Evolved Skills. Within a category, press Space to enable or disable the highlighted skill for future model prompts; enabled skills display as `[x] name` and disabled skills as `[] name`. The change applies to the next prompt. Press Enter to reference the highlighted skill in the editor without changing whether it is enabled.

Referenced skills appear in the editor as purple skill-name tokens while retaining versioned references internally, so you can add the task before submitting. Each reference loads that exact captured skill content for one request, including queued steering and follow-up messages. Disabled skills remain available for explicit reference but are omitted from progressive disclosure in the system prompt.

To install a package containing skills from an interactive terminal, run `diffex install <source>` and choose `Install globally` or `Install for this workspace`. The prompt shows both destinations and the trust implications. Workspace installation requires project trust and never falls back to global installation. Non-interactive installs retain the global default; pass `-l` to select workspace scope explicitly.

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && npm install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative paths from the skill directory:

```markdown
See [the reference guide](references/REFERENCE.md) for details.
```

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Unlike the standard, Diffex does not require this to match the parent directory because that standard requirement is suboptimal for shared skill directories. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from the system prompt. Users must reference it explicitly through `/skills`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
Diffex does not require the name to match the parent directory. The Agent Skills standard does, but that requirement is suboptimal for shared skill directories used by multiple tools.

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Diffex validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

**Exception:** Skills with missing description are not loaded.

Installed skill name precedence is project, user, then package order. Collisions warn and retain the higher-precedence installed skill. When an evolved skill has the same name, the installed skill retains the unsuffixed name and the evolved skill is exposed as `<name>-Evolved`; if that alias also collides, the evolved skill is omitted with a diagnostic.

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && npm install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Web search, browser automation, Google APIs, transcription
