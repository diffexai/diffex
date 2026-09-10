# Canonical self-update target

The manual self-update planner accepts only a response identifying `@diffexai/diffex` with a canonical stable version.
It constructs the installation specification from the local `RELEASE_PACKAGE_NAME` constant and the validated version, regardless of the response's package field.
Missing or foreign package identities, installation URLs, npm aliases, prereleases, build metadata, leading zeroes, and leading `v` cannot reach package-command execution.
Validation happens before the force decision, installation detection, Windows dependency preparation, and process dispatch.
Normal and forced valid updates attempt only `@diffexai/diffex@<version>` without a package-migration uninstall.
Rejected targets print `Refusing self-update: expected a stable @diffexai/diffex release.` and exit with status 1.

This is the client safeguard required by the independently deployed release Worker in `diffex-cloud`, implemented on `feat/serve-verified-releases`.
It does not activate the Diffex endpoint: the shared checker still requests `https://pi.dev/api/latest-version` until the consumer authority migration is completed.
Strict response parsing, redirect restrictions, no-release messages, and staged endpoint canaries remain part of that migration.
Current foreign-package responses now fail safely rather than migrating installations.
Existing note rendering, offline behavior, automatic opt-out, and bounded manual retries are preserved.

## Reproduction and verification

On 2026-09-10, the original 10-case source-CLI reproduction passed before the fix and captured both normal and forced foreign-package installation attempts.
The updated controlled suite passed 18 cases, including foreign-package rejection, unsafe-version rejection with force, canonical installation targets, offline behavior, automatic opt-out, manual retries, and real-terminal startup and exit.
The package-command integration suite passed 31 cases, including missing-identity rejection and canonical npm failure handling without an uninstall.
The relevant commands, run from `packages/coding-agent`, are:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/version-update-e2e.test.ts test/package-command-paths.test.ts --reporter=verbose
```

The controlled source CLI intercepted network requests and every package-manager execution before package mutation.
Canonical install commands were recorded with `--ignore-scripts` and an explicit version; no install or uninstall actually ran.
Every case removed its temporary home, package prefix, project directory, and event record.
`npm run check` and the complete isolated `./test.sh` suite passed.
No production endpoint, package publication, installed software, or remote storage changed.
This establishes source-CLI behavior with controlled responses, not a deployed Worker-to-CLI canary or published-client acceptance.
