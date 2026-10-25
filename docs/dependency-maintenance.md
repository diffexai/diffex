# Dependency maintenance

Direct external dependencies are pinned to exact versions. Refresh the root lockfile with `npm install --package-lock-only --ignore-scripts`, hydrate with `npm install --ignore-scripts`, then regenerate the CLI distribution locks:

```bash
node scripts/generate-coding-agent-shrinkwrap.mjs
node scripts/generate-coding-agent-install-lock.mjs
npm run check
./test.sh
```

Keep each dependency's pins synchronized across consuming workspaces and examples. Update live documentation examples when their dependency versions change; do not rewrite historical release records or notices for unchanged vendored files. The HTML exporter still vendors marked 18.0.5 and highlight.js 11.9.0; packaging reads their tracked licenses under `legal/upstream/`, independently of installed runtime versions.

## Compatibility exceptions

- Vitest and `@vitest/coverage-v8` use **4.1.12**, the patched 4.x release. The latest `vitest-evals` (**0.17.0**) requires `vitest >=4 <5`, so Vitest 5 is not compatible with the evaluation workspace.
- `hosted-git-info` remains **9.0.3**. Version 10.1.1 requires Node `^22.22.2 || ^24.15.0 || >=26.0.0`, above the project's Node 22.19.0 minimum.
- `@typescript/native-preview` has no stable release under that package name; do not replace its existing pin with another prerelease as part of a stable-only update.

## Install tooling

npm 10.9.3 can crash while resolving optional Vitest peers (`Cannot read properties of null (reading 'edgesOut')`). npm **11.21.1** supports the project's minimum Node version and can be invoked temporarily without changing the global installation:

```bash
npm exec --yes --ignore-scripts --package=npm@11.21.1 -- npm install --package-lock-only --ignore-scripts
```

If changed dependencies remain duplicated under workspaces, run `npm dedupe --package-lock-only --ignore-scripts` before regenerating distribution locks. The generators resolve dependencies from their originating workspace and relocate them to published `node_modules/` paths, preserving nested version differences and platform-specific optional dependencies. They reject unresolved or conflicting flattened dependencies. The root OpenTelemetry API pin also makes SDK optional peers available to the browser smoke check.

The repository normally enforces a two-day minimum release age. Do not disable it without explicit approval. This update batch received approval to use `npm_config_min_release_age=0` on install commands only; `.npmrc` remains unchanged.

## Networking review

[Undici 8.12.3](https://github.com/nodejs/undici/releases/tag/v8.12.3) fixes HTTP/2 connection replacement following stream timeouts and preserves caller async context for queued pool requests. These can affect timeout recovery and request attribution; review networking tests when updating. It retains the Node 22.19.0 minimum.

## Security review

The initial audit reported seven affected packages, all present in the baseline lockfile. Updating Vitest/coverage to 4.1.12 and refreshing compatible Vite and source-map-js transitives removes five findings. The remaining sandbox-runtime/Zod dependency chain requires further review; do not force a Zod major-version override across consumers without checking their APIs.
