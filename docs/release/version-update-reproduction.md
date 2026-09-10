# Version discovery and foreign-package update reproduction

Verified on 2026-09-10 against `chore/luntraa-diffex-rename` revision `ff2250127`, using Node `22.19.0` on macOS arm64.
The checked-out package identifies itself as `@diffexai/diffex@0.2.0`.
The tests read the installed identity from the package manifest so the reproduction also follows a later package rename.

## Finding

Interactive startup and `diffex update --self` request `https://pi.dev/api/latest-version`.
A response naming `@foreign-fixture/untrusted-cli` reaches the CLI's real package-command execution boundary and causes an attempted uninstall of the installed package followed by an attempted install of the foreign package.
`--force` also accepts the foreign identity when the response version equals the installed version.
The reproduction captures both commands before execution and simulates successful completion; no package manager runs and no installed software changes.

The finding and captured commands below are historical evidence from the vulnerable implementation.
The same reproduction was confirmed again before adding the [canonical self-update safeguard](self-update-target.md).
The executable suite now asserts rejection of foreign targets and retains CLI and terminal coverage.
Endpoint cutover remains pending.

## Repeat the reproduction

Use the repository's installed dependencies, Node `22.19.0` or newer, Python 3, and a POSIX system with PTY support.
The suite explicitly skips Windows; it makes no claim about Windows package-manager execution.
No build, release, npm installation, production credentials, or live endpoint is required.

From `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/version-update-e2e.test.ts --reporter=verbose
```

The source entrypoint is `src/cli.ts`, loaded with `tsx` and the repository's TypeScript path mappings.
Manual cases pass `update --self`, optionally followed by `--force`.
Interactive cases pass `--no-session --no-extensions --no-skills`, render the real startup UI in a 100-column, 30-row PTY, and submit `/exit` through the editor after the welcome header appears.
No model prompt is submitted.
The expected no-model warning reflects the deliberately empty credential configuration.

Each case gets a fresh temporary home, agent directory, project directory, and event record.
The child environment is constructed from an allowlist and does not inherit credentials, proxy settings, user resource configuration, or loader options.
Manual cases model a writable global npm installation with a temporary package manifest and an overridden package/runtime path; install-method detection, update planning, command construction, and command dispatch remain real application code.

The preload imports HTTP configuration before installing the fetch interceptor so CLI initialization preserves the test override.
The interceptor records the actual requested URL, method, and user agent, supplies only the controlled version response, and returns `503` for unrelated background fetches.
A socket guard rejects alternate network access.
Child-process APIs are intercepted before application imports; npm root discovery is simulated, install/uninstall attempts are recorded without execution, and other application subprocesses are blocked.
Only the local `tsx` compiler's esbuild service may execute.

## Observed requests and commands

The version request is an unauthenticated `GET` with a user agent beginning `diffex/0.2.0 `.
No request reaches Pi over the network in this test.
The foreign response fixture is:

```json
{
  "version": "9999.0.0",
  "packageName": "@foreign-fixture/untrusted-cli"
}
```

The following is a captured command sequence, with the per-test temporary prefix replaced by `<temporary-prefix>`.
These lines are evidence, not commands to run manually.

```text
npm --prefix <temporary-prefix> uninstall -g @diffexai/diffex
npm --prefix <temporary-prefix> install -g --ignore-scripts --min-release-age=0 @foreign-fixture/untrusted-cli@9999.0.0
```

For `diffex update --self --force`, the fixture supplies `0.2.0`, equal to the current version.
The uninstall attempt is identical and the install target becomes `@foreign-fixture/untrusted-cli@0.2.0`.
The CLI prints its combined `Updating diffex with ...` command and reports success only because the guard emits simulated successful process completion.

| User path | Controlled condition | Version requests | Observed result |
| --- | --- | --- | --- |
| Interactive startup | Foreign newer release | 1 | Welcome screen, no update notification, no package command |
| Interactive startup | `DIFFEX_OFFLINE=1` | 0 | Welcome screen, no version error or package command |
| Interactive startup | `DIFFEX_SKIP_VERSION_CHECK=1` | 0 | Welcome screen, no version error or package command |
| Interactive startup | Transport failure | 1 | Welcome screen, no retry or visible version error |
| `update --self` | Foreign newer release | 1 | Uninstall and foreign install attempts captured |
| `update --self --force` | Foreign equal-version release | 1 | Uninstall and foreign install attempts captured |
| `update --self` | Automatic opt-out enabled | 1 | Manual uninstall and foreign install attempts still occur |
| `update --self` | Offline | 0 | Exit 1, no package command |
| `update --self --force` | Offline | 0 | Exit 1, no package command |
| `update --self` | Transport failure | 3 | Exit 1 after two retries, no package command |

Offline manual update prints `Error: Could not determine latest diffex version.`
The controlled transport failure prints `Error: Could not determine latest diffex version: controlled network failure`.
Startup remains silent even for a valid newer response because `DIFFEX_UPDATE_AVAILABLE_NOTIFICATION_ENABLED` is currently `false` in `interactive-mode.ts`; the request still happens.

## Validation and cleanup

The dedicated reproduction passed all 10 cases.
`npm run check` passed, including type checking, dependency checks, and the browser smoke check.
`./test.sh` passed after refreshing local workspace links with `npm install --ignore-scripts --offline` and adding the missing agent `/node` source alias in `vitest.base.ts`.
The checked-in lockfile is unchanged.
The focused server-harness and CLI reproduction run passed 22 tests after the rebase.

Every interactive case exited through `/exit` with status 0.
Every test removed its temporary directory and asserted that it no longer existed.
The harness enforces a 20-second case deadline and the PTY bridge kills and reaps the CLI on abnormal termination.
No package-manager process, provider call, installation, uninstallation, release publication, or infrastructure mutation occurred in the reproduction.
This establishes source-CLI behavior under controlled responses; it does not verify a published binary, live HTTPS routing, npm availability, or a deployed replacement endpoint.
