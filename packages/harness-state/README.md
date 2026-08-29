# `@earendil-works/diffex-harness-state`

Persistent, content-addressed harness revisions for Diffex.

## Storage

`HarnessStateStore` stores revisions beneath an agent directory:

```text
<agentDir>/harness-state/
|-- current.json
`-- versions/
    `-- sha256-<revision-digest>/
        |-- manifest.json
        |-- EVOLVE.md
        `-- skills/
            `-- <name>/
                `-- SKILL.md
```

Revision identifiers use canonical `sha256:<digest>` strings in APIs and data. Directory names replace the colon with a dash for Windows portability.

The schema-v2 manifest contains the revision, immutable parent, evolution-memory metadata, and a closed sorted artifact inventory. The revision hash covers the schema version, parent, metadata, and artifact descriptors; each artifact also records a hash over its exact bytes. Including the parent means identical content on different lineages produces different revisions.

Supported artifacts are one `evolution-memory` at `EVOLVE.md` and validated workspace-scoped `skill` artifacts at canonical `skills/<name>/SKILL.md` paths. The manifest can describe future kinds for inspection, but activation rejects a bundle containing a kind the runtime cannot fully understand.

## State and inheritance

`HarnessStateInput` requires `memory` and accepts optional `skills`:

- omitting `skills` while saving from a base inherits that base's exact skill set;
- passing `skills: []` explicitly clears the skill set;
- passing a skill list replaces the complete inherited set.

Memory and skills are therefore saved, validated, selected, and rolled back as one revision. The store persists artifacts; it does not synthesize, evaluate, or decide when to activate skills. Session-level request pinning belongs to the coding-agent runtime.

## Validation

Loading or selecting validates the complete bundle. Validation rejects malformed or noncanonical manifests, revision and content hash mismatches, undeclared or missing files, duplicate and nonportable paths, incorrect casing, symbolic links, non-regular files, malformed UTF-8, leading BOMs, unsupported artifact kinds, malformed skill frontmatter, and missing or mismatched workspace metadata.

`EVOLVE.md` may be exactly empty for the root revision. Non-empty whitespace-only memory is invalid.

## API

- `computeHarnessVersion(input)` computes a canonical revision identifier.
- `serializeHarnessVersion(input)` exposes the canonical hash serialization.
- `harnessVersionDirectoryName(version)` creates the portable directory name.
- `computeHarnessSkillId(workspace, path)` derives stable workspace/path identity for a harness skill.
- `validateHarnessSkillContent(path, content)` validates canonical Agent Skills frontmatter and content.
- `saveHarnessState(state, destinationPath, base, metadata)` writes an immutable revision bundle.
- `loadHarnessState(bundlePath)` validates and loads one complete revision bundle.
- `new HarnessStateStore(agentDir)` manages the global store.

The store provides:

- `initialize()` creates and selects the empty root when no pointer exists.
- `loadCurrent()` strictly validates and loads the selected revision.
- `loadVersion(version)` loads one exact immutable revision without selecting it.
- `listVersions()` returns compatible bundles and per-path diagnostics for corrupt or incompatible entries. Diagnostics retain validated manifest and memory state when a future artifact is the only activation blocker.
- `saveVersion(state, base, metadata?)` creates an immutable revision without selecting it and inherits omitted metadata and skills from its base.
- `selectVersion(version)` validates the complete target and atomically replaces the pointer.
- `selectVersionIfCurrent(version, expectedCurrent)` selects only when the pointer still matches the expected revision. Skill activation and rollback use this compare-and-swap primitive.
- `advance(state, expectedBase, metadata?)` commits and selects a successor only when the selected revision still matches `expectedBase`.

Initialization, selection, and advancement share a cross-process store lock. Version writes stage beside their destination and are idempotent only when an existing revision validates to the same canonical content. Pointer replacement uses a staged file and atomic rename. Expected-base races return discriminated conflict results and never create or select a silent branch.
