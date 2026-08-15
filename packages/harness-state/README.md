# `@diffexai/diffex-harness-state`

Private workspace package for the version 1 Diffex harness-state schema and directory-bundle persistence.

## State and bundle format

A version 1 logical state contains only the evolvable static system prompt:

```ts
{
	schemaVersion: 1;
	systemPrompt: string;
}
```

The prompt must not start with U+FEFF and must contain a non-whitespace character. A portable bundle root is a direct directory, not a symbolic link, with exactly these direct regular files and exact casing:

```text
state-directory/
|-- manifest.json  # canonical saved form is {"schemaVersion":1} plus one LF
`-- EVOLVE.md      # systemPrompt UTF-8 bytes, preserved verbatim
```

Both files must be fatal, BOM-free UTF-8. The manifest must contain only `schemaVersion: 1`.

## API

- `HarnessStateSchema` and `HarnessStateManifestSchema` are strict TypeBox schemas. Their inferred `HarnessState` and `HarnessStateManifest` types expose readonly fields.
- `loadHarnessState(bundlePath)` validates a bundle and returns its flat logical state without normalizing the prompt.
- `saveHarnessState(state, destinationPath)` validates the state, stages a canonical two-file bundle beside the destination, and renames it into place. The parent must already be a directory, any existing destination entry is rejected, and a failed save attempts to remove its owned staging directory.
- `loadDefaultHarnessState()` loads the packaged clean-default bundle through `loadHarnessState()`.

Invalid state, layout, encoding, manifest, or prompt data rejects with an ordinary descriptive `Error`. JSON syntax failures retain the original syntax error as their cause. Other filesystem errors propagate unchanged.

## Version 1 limitations

Version 1 stores only the static system prompt. It has no migration or compatibility behavior and does not represent tools, models, context, sessions, lineage, provenance, or evolution metadata. Persistence does not provide cross-process coordination, retries, or durability guarantees.
