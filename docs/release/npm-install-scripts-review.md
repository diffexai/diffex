# Normal npm installation review

## Status

The public npm installation command is `npm i -g @diffexai/diffex`.
Static dependency review and isolated script-enabled installation checks support that command; scripts-disabled installation remains supported.
The modified Daytona scenario still requires explicit remote qualification and evidence review before automatic behavior runs are enabled or the remote path is treated as qualified. Its workflow is manual or qualified post-merge, not an automatic pull-request check; environment secrets remain restricted to `main`.
This record does not claim that GitHub Actions or Daytona has executed the changed tests.

The normal-install follow-up changes instructions and acceptance coverage, not dependency versions, lockfiles, self-update behavior or publishing safeguards.
The generated npm README now shows the ordinary command; no install or postinstall hook is added to Diffex itself.

## Reviewed scope

The review compared the public `@diffexai/diffex@0.4.0` archive, the current CLI shrinkwrap, and the generated installer lock.
The public archive has 228 dependency entries; the current candidate graph has 140 because the reviewed Mistral provider implementation is bundled.
These are different artifacts even though they currently share version `0.4.0`.
The public archive must not be checked against the candidate's runtime inventory or source commit.

Read-only metadata and tarball inspection covered 225 unique dependency identities across these graphs, including optional platform packages and required peer dependencies.
Each downloaded tarball matched its registry SHA-512 integrity.
No implicit `binding.gyp` installation or additional preinstall/install/postinstall hook was found.
The package staging code removes the CLI's and bundled workspaces' own scripts.
Build/prepare/publishing hooks declared in registry dependencies are not consumer-install hooks.

Public CLI archive:

```text
https://registry.npmjs.org/@diffexai/diffex/-/diffex-0.4.0.tgz
sha512-l76f89GQRAv4M2DOVc6CuT6RakqvK3d1bDwdtol9ciPJ8Lbi9p97pMDy7uuA3VDUUdR+8OlWk0pfEIkhapEZUw==
```

Only two install-time hooks were found:

| Package | Hook | Reviewed behavior |
| --- | --- | --- |
| `@google/genai@2.31.0` | `preinstall`: `echo 'preinstall: no-op'` | Prints a message; no dependency build or download. |
| `protobufjs@7.6.5` | `postinstall`: `node scripts/postinstall` | Reads package metadata and may print a version-scheme warning; no network, subprocess, compilation or filesystem writes. |

The published protobufjs `scripts/postinstall.js` SHA-256 is `5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c`.
The existing exact-version allowlists in `scripts/generate-coding-agent-shrinkwrap.mjs` and `scripts/generate-coding-agent-install-lock.mjs` match these two packages.
An allowlist comment alone is not a replacement for reviewing the actual published hook bytes.
Re-review lifecycle behavior when dependency versions, peers, optional dependencies or the published package change.
This inspection does not prove that arbitrary future package versions or unrelated dependencies are safe.

## Validation contract

- The reusable artifact installer continues to disable lifecycle scripts by default.
- Native candidate acceptance explicitly enables scripts for npm package/process consumers and records that mode. pnpm and Bun acceptance remain scripts-disabled.
- Public-release npm initial and fresh installations require `ignore-scripts=false` and omit the flag from the install command; self-updates intentionally remain scripts-disabled.
- The explicit npm-only consumer option enables scripts and rejects opt-in for other package managers.
- Local audited fixtures prove that enabled npm hooks actually run, inherited credentials/configuration do not enter them, and scripts-disabled consumers remain disabled.
- Daytona's candidate npm consumers enable scripts and retain the full installed CLI behavior tests; Bun remains on its existing scripts-disabled path.
- The separate `npm-global-installation` scenario tests the retained candidate and independently verified public latest package in separate cold prefixes.
- Candidate registry metadata and seeded consumer installation locks preserve the reviewed shrinkwrap. npm 10 file/tarball transport can otherwise ignore a nested shrinkwrap and re-resolve transitive ranges; a real check caught unreviewed `protobufjs@7.6.6` before this correction.
- Both global installs require positive debug-log evidence that the exact two reviewed hook commands started and completed successfully. Configuration alone is not execution evidence. Raw npm logs are not retained.
- The public path executes exactly `npm i -g @diffexai/diffex`, with no `--ignore-scripts` flag and verified default configuration of `false`.
- Both global paths require executable resolution through PATH, expected version/help/models, exact installed runtime inventories and positive cleanup.
- Missing evidence, public latest movement, hash mismatches, scripts-disabled configuration or cleanup failure remain failures.

See [the Daytona operator guide](../daytona-behaviors.md) for workflow authorization, execution, evidence and cleanup requirements.
