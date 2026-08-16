# `@diffexai/diffex-harness-state`

Private workspace package for the Diffex harness-state schema and directory-bundle persistence.

## State and bundle format

A logical state contains only the evolvable static system prompt:

```ts
{
	systemPrompt: string;
}
```

The prompt must not start with U+FEFF and must contain a non-whitespace character. A portable bundle root is a direct directory, not a symbolic link, with exactly these direct regular files and exact casing:

```text
state-directory/
|-- manifest.json  # SHA-256 metadata for the exact EVOLVE.md bytes
`-- EVOLVE.md      # systemPrompt UTF-8 bytes, preserved verbatim
```

Both files must be fatal, BOM-free UTF-8. The manifest must contain only `contentHash`, formatted as `sha256:` followed by 64 lowercase hexadecimal characters. Loading verifies that it matches the exact `EVOLVE.md` bytes, including line endings and trailing whitespace.

## API

- `HarnessStateSchema` and `HarnessStateManifestSchema` are strict TypeBox schemas. Their inferred `HarnessState` and `HarnessStateManifest` types expose readonly fields.
- `loadHarnessState(bundlePath)` validates a bundle, verifies its content hash, and returns its flat logical state without normalizing the prompt.
- `saveHarnessState(state, destinationPath)` validates the state, derives its content hash, stages a canonical two-file bundle beside the destination, and renames it into place. The parent must already be a directory, any existing destination entry is rejected, and a failed save attempts to remove its owned staging directory.

The package does not include or select a default harness. Callers must provide an explicit bundle path or state.

Invalid state, layout, encoding, manifest, or prompt data rejects with an ordinary descriptive `Error`. JSON syntax failures retain the original syntax error as their cause. Other filesystem errors propagate unchanged.

## Limitations

The state stores only the static system prompt. It has no migration or compatibility behavior and does not represent tools, models, context, sessions, lineage, provenance, or evolution metadata beyond the derived content hash. Persistence does not provide cross-process coordination, retries, or durability guarantees.
