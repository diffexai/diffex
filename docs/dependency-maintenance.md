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
- `@typescript/native-preview` has no stable release under that package name; do not replace its existing pin with another prerelease as part of a stable-only update. Its existing pin remains available to workspace build scripts, while the root check uses stable TypeScript 7's `tsc`.

## Install tooling

npm 10.9.3 can crash while resolving optional Vitest peers (`Cannot read properties of null (reading 'edgesOut')`). npm **11.21.1** supports the project's minimum Node version and can be invoked temporarily without changing the global installation:

```bash
npm exec --yes --ignore-scripts --package=npm@11.21.1 -- npm install --package-lock-only --ignore-scripts
```

If changed dependencies remain duplicated under workspaces, run `npm dedupe --package-lock-only --ignore-scripts` before regenerating distribution locks. The generators resolve dependencies from their originating workspace and relocate them to published `node_modules/` paths, preserving nested version differences and platform-specific optional dependencies. They reject unresolved or conflicting flattened dependencies. The root OpenTelemetry API pin also makes SDK optional peers available to the browser smoke check.

The repository normally enforces a two-day minimum release age. Do not disable it without explicit approval. This update batch received approval to use `npm_config_min_release_age=0` on install commands only; `.npmrc` remains unchanged.

## Development tooling

Development tooling uses Biome **2.6.3**, TypeScript **7.0.2**, esbuild **0.28.2**, and tsx **4.23.15**. Biome's schema and recommended preset configuration are migrated together with newly enforced diagnostics. The TypeScript target is **ES2024**, matching Unicode-set regular expressions already used on supported Node runtimes. The relative-import policy checker uses TypeScript 7's exported native AST API (`typescript/unstable/ast` and `typescript/unstable/sync`); these API paths are unstable, so the exact compiler pin and syntax/diagnostic regression tests must move together. Temporary parser projects and native clients are cleaned up after every check.

`diff` supplies its own declarations, so the obsolete `@types/diff` stub is no longer needed. The rimraf override is synchronized at **6.1.3** in the root and published CLI manifests/locks. Nanoid and protobufjs overrides remain in their consumers' compatible major lines rather than forcing unsupported transitive majors.

## Runtime libraries

Runtime pins use keyring **2.1.2**, Chalk **6.0.1**, diff **9.0.0**, highlight.js **11.12.0**, and HTTP/HTTPS proxy agents **9.1.0**. Terminal tests use xterm/headless **6.0.0**. Node declarations are synchronized at **26.6.5**; the supported runtime minimum remains Node **22.19.0**, and no new runtime APIs are required.

Keyring's missing-password result is now `null`. The storage adapter still reports a missing session as `undefined`. Socket adapters normalize the new declaration's string-or-buffer input, and syntax highlighting uses highlight.js's public entry point. The extension dependency example pins Chalk 6.0.1.

The standalone sandbox example lock now resolves shell-quote **1.12.0**, addressing both reported shell-quote advisories. Sandbox runtime itself is intentionally retained at **0.0.26**: version 0.0.81 introduces node-forge 1.4.0 with the unpatched [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) signature-verification advisory. Revisit this exception when a patched upstream dependency is available; do not force an incompatible Zod major override to suppress the remaining audit findings.

## Networking review

[Undici 8.12.3](https://github.com/nodejs/undici/releases/tag/v8.12.3) fixes HTTP/2 connection replacement following stream timeouts and preserves caller async context for queued pool requests. These can affect timeout recovery and request attribution; review networking tests when updating. It retains the Node 22.19.0 minimum.

## Provider SDK migrations

The provider SDKs use Anthropic **1.3.0**, Google GenAI **2.31.0**, Mistral **3.2.0**, and OpenAI **7.43.0**. The standalone custom Anthropic provider example uses the same Anthropic pin and lockfile. Mistral uses scoped Chat and HTTPClient imports so its new Node-only voice exports do not enter browser bundles. Cloudflare compatibility tests inject an in-memory fetch implementation rather than relying on SDK hoisting.

Google automatic continuation is explicitly disabled for Gemini and Vertex requests. A continuation limit is reported as `length` rather than allowing the SDK to send additional requests automatically. Google authentication remains independent of GitHub credentials.

Anthropic adopts the SDK's API version **2026-10-21** and no longer sends the removed sampling parameters. A model-context-window limit is reported as `length`. The Google GenAI install-script allowlist was reviewed and updated: its published `preinstall` is still a no-op, and installs continue to skip scripts.

## Security review

The initial audit reported seven affected packages, all present in the baseline lockfile. Updating Vitest/coverage to 4.1.12 and refreshing compatible Vite and source-map-js transitives removes five findings. The remaining sandbox-runtime/Zod dependency chain requires further review; do not force a Zod major-version override across consumers without checking their APIs.
