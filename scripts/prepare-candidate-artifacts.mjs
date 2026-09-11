import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
if (!process.argv[2])
  throw new Error(
    "Usage: node scripts/prepare-candidate-artifacts.mjs ARTIFACT_DIRECTORY",
  );
const out = resolve(process.argv[2]);
mkdirSync(join(out, "tarballs"), { recursive: true });
// Refuse an existing consumer so same-version local tarballs cannot be cached.
mkdirSync(join(out, "node"));
const packages = getPublicWorkspacePackages();
const dependencies = {};
const manifest = [];
for (const pkg of packages) {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        join(out, "tarballs"),
      ],
      { cwd: pkg.directory, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    ),
  );
  const file = join(out, "tarballs", packed.filename);
  dependencies[pkg.name] = `file:${file}`;
  manifest.push({
    name: pkg.name,
    version: pkg.version,
    filename: packed.filename,
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
  });
  console.log(`Packed ${pkg.name}`);
}
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
writeFileSync(
  join(out, "node/package.json"),
  JSON.stringify(
    { private: true, type: "module", dependencies, overrides: dependencies },
    null,
    2,
  ) + "\n",
);
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts"], {
  cwd: join(out, "node"),
  stdio: "inherit",
});
for (const pkg of packages) {
  const installed = resolve(out, "node/node_modules", pkg.name, "package.json");
  const info = JSON.parse(readFileSync(installed, "utf8"));
  if (info.name !== pkg.name || info.version !== pkg.version)
    throw new Error("Installed identity mismatch");
}
console.log(
  "All eleven local tarball identities verified outside the workspace.",
);
