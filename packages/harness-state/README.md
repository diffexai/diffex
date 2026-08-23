# `@earendil-works/diffex-harness-state`

Persistent, content-addressed harness revisions for Diffex.

## Storage

`HarnessStateStore` stores global revisions beneath an agent directory:

```text
<agentDir>/harness-state/
|-- current.json
`-- versions/
    `-- sha256-<revision-digest>/
        |-- manifest.json
        `-- EVOLVE.md
```

Revision identifiers use canonical `sha256:<digest>` strings in APIs and data.
Directory names replace the colon with a dash for Windows portability.

Each manifest contains `schemaVersion`, `version`, `base`, content-addressed harness metadata including the next evolution lesson number, and a deterministic artifact inventory.
The current manifest schema version is 2.
The revision hash covers the schema version, parent revision, harness metadata, and sorted artifact descriptors, but not the `version` field itself.
Each artifact retains its own content hash over its exact bytes.
Including the parent revision makes repeated evolution with identical artifact content produce a distinct successor.

Only one `evolution-memory` artifact at `EVOLVE.md` is supported for activation today.
The manifest schema can represent future artifact kinds so incompatible revisions can be inspected and reported, but activation rejects every kind the runtime cannot fully understand.

## Validation

Activation validates the complete bundle before returning any state.
It rejects malformed or noncanonical manifests, revision and content hash mismatches, undeclared or missing files, duplicate and nonportable paths, incorrect casing, symbolic links, non-regular files, malformed UTF-8, leading BOMs, and unsupported artifact kinds.
`EVOLVE.md` may be exactly empty for the root revision.
Non-empty whitespace-only memory remains invalid.

## API

- `computeHarnessVersion(input)` computes a canonical revision identifier.
- `serializeHarnessVersion(input)` exposes the canonical serialization used by the hash.
- `harnessVersionDirectoryName(version)` creates the portable directory name.
- `saveHarnessState(state, destinationPath, base, metadata)` writes an immutable, idempotent revision bundle.
- `loadHarnessState(bundlePath)` validates and loads one complete revision bundle.
- `new HarnessStateStore(agentDir)` manages the global store beneath an effective agent directory.

The store provides these operations:

- `initialize()` creates and selects the empty root if no pointer exists.
- `loadCurrent()` strictly validates and loads the selected revision.
- `listVersions()` returns compatible bundles and per-path diagnostics for corrupt or incompatible entries.
  Diagnostics retain validated manifest and EVOLVE state when an incompatible future artifact is the only activation blocker.
- `saveVersion(state, base, metadata?)` creates an immutable revision without selecting it and inherits omitted metadata from its base.
- `selectVersion(version)` validates the complete target and atomically replaces the pointer.
- `advance(state, expectedBase, metadata?)` commits and selects a successor only when the selected revision still matches `expectedBase`, inheriting omitted metadata.

Initialization, selection, and advancement share a cross-process store lock.
Version writes stage beside their destination and are idempotent only when an existing revision validates to the same canonical content.
Pointer replacement uses a staged file and atomic rename.
An expected-base race returns a discriminated `conflict` result and does not create or select a silent branch.

The package does not implement skill generation, source mutation, orchestration loading, build execution, restart handling, rollback, garbage collection, aliases, project-local stores, or session-level revision pinning.
