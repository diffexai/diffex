# Development

See [AGENTS.md](https://github.com/diffexai/diffex/blob/main/AGENTS.md) for additional guidelines.

## Setup

```bash
git clone https://github.com/diffexai/diffex
cd diffex
npm install --ignore-scripts
npm run build
```

Run from source:

```bash
/path/to/diffex/diffex-test.sh
```

The script can be run from any directory. Diffex keeps the caller's current working directory.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "diffexConfig": {
    "name": "diffex",
    "configDir": ".diffex"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.diffex/agent/diffex-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
./test.sh # Run non-E2E tests with credentials isolated

# From the relevant package directory:
node ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts
```

Do not run the full Vitest suite directly: endpoint or authentication environment variables can activate provider E2E tests.

See [dependency maintenance](../../../docs/dependency-maintenance.md) for dependency update constraints and validation.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```
