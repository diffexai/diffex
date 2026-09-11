import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  identityPattern,
  scanIdentities,
} from "./check-runtime-identities.mjs";
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/scan-candidate-artifacts.mjs ARTIFACT_DIRECTORY",
  );
const root = resolve(process.argv[2]);
const results = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = readFileSync(path);
    const text = bytes.toString("latin1");
    const hits = [...text.matchAll(identityPattern)];
    const decodedSources = [];
    if (entry.name.endsWith(".map")) {
      const map = JSON.parse(bytes.toString("utf8"));
      for (const [index, source] of (map.sourcesContent ?? []).entries()) {
        if (source === null) continue;
        decodedSources.push(...scanIdentities(map.sources[index], source));
      }
    }
    if (!hits.length && !decodedSources.length) continue;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (entry.name === "CHANGELOG.md") {
      results.push({
        path: relative(root, path),
        sha256,
        historicalOccurrences: hits.length,
      });
      continue;
    }
    const occurrences = hits.map((m) => ({
      identity: m[0],
      offset: m.index,
      context: text.slice(
        Math.max(0, m.index - 90),
        m.index + m[0].length + 100,
      ),
    }));
    results.push({
      path: relative(root, path),
      sha256,
      occurrences,
      ...(decodedSources.length ? { decodedSources } : {}),
    });
  }
}
walk(join(root, "node/node_modules/@diffexai"));
walk(join(root, "binaries/darwin-arm64"));
writeFileSync(
  join(root, "identity-scan.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  `Recorded ${results.length} files with matches for explicit review in identity-scan.json.`,
);
