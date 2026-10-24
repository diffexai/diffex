# Contributing to Diffex

Thank you for contributing to Diffex.
Keep changes focused, evidence-backed, and easy to review.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Local Setup

Install Node.js 22.19 or newer and npm.

```bash
git clone https://github.com/diffexai/diffex.git
cd diffex
npm install --ignore-scripts
npm run build:offline
```

Run the coding agent from source with:

```bash
./diffex-test.sh
```

The launcher can be run from any directory and preserves the caller's working directory.

## Before Making Changes

Read [AGENTS.md](AGENTS.md) before changing code.
It defines the repository's source, dependency, testing, Git, and release rules.

Diffex is a TypeScript monorepo forked from the Pi Agent Harness.
Preserve package boundaries and keep the agent core minimal and extensible.
Features that do not belong in the core should be implemented through the extension system when practical.

You must understand the code you submit.
Using AI-assisted tools is acceptable, but contributors remain responsible for correctness, security, tests, and maintainability.

## Pull Request Flow

1. Create a focused branch with a descriptive name such as `feat/...`, `fix/...`, `docs/...`, `test/...`, `refactor/...`, `ci/...`, or `chore/...`.
2. Reproduce bugs through the user-facing workflow before narrowing the problem to focused tests.
3. Add or update tests for changed public behavior and bug fixes.
4. Run the required validation and resolve every error, warning, and informational diagnostic.
5. Open a pull request using the provided [GitHub pull request template](.github/pull_request_template.md). Complete every section with the summary, reasoning, changes, and testing performed, including relevant user impact.
6. Address review feedback with focused follow-up commits.
7. Merge only after approval and all required checks pass.

Do not edit package changelogs manually.
Maintainers update generated release records through the repository release workflow.

## Local Validation

Run the repository checks before requesting review:

```bash
npm run check
./test.sh
```

`npm run check` performs formatting, linting, dependency policy checks, and TypeScript validation.
`./test.sh` runs non-E2E tests without activating suites that depend on provider endpoints or credentials.

When you create or modify a test file, run that test directly and iterate until it passes.
From a package directory, use the repository's Vitest executable with the specific test path.

```bash
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Do not run the full Vitest suite directly.
Some E2E tests activate when endpoint or authentication environment variables are present.

For terminal UI changes, run `./diffex-test.sh` in a controlled terminal and exercise the affected view, dialog, navigation flow, and exit path.
For coding-agent E2E regressions, use the test harness and faux provider under `packages/coding-agent/test/suite`.

## Engineering Expectations

- Use explicit TypeScript types and avoid `any` unless no safe alternative exists.
- Use top-level imports and syntax supported by Node's erasable TypeScript mode.
- Inspect dependency APIs and their installed types instead of guessing.
- Keep package boundaries explicit and avoid unnecessary cross-package coupling.
- Prefer deterministic tests over timing-sensitive tests.
- Keep secrets, generated private state, local artifacts, and build output out of the repository.
- Treat dependency and lockfile changes as reviewed code changes.
- Document user-visible behavior and migration requirements.

## Issues

Keep issue reports concise, concrete, and reproducible.
Explain what happened, what you expected, why it matters, and the smallest known reproduction.
Include relevant versions, logs, and environment details, but remove credentials and other sensitive data.

Use `pkg:agent`, `pkg:ai`, `pkg:coding-agent`, or `pkg:tui` labels when those packages are affected.
Use all applicable package labels for cross-package work.

## Review Expectations

Reviewers evaluate correctness, user impact, security, tests, dependency boundaries, and long-term maintainability.
Call out architectural effects, new dependencies, compatibility changes, and unresolved risks in the pull request description.
Keep each pull request scoped so reviewers can understand and validate it without unrelated changes.
