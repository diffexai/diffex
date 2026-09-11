import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Match inherited product identities, not mathematical pi or local variable names.
export const identityPattern =
  /earendil(?:-works)?|(?:radius\.)?pi\.dev|pi-(?:gateway|coding-agent|mono|doom|share[\w:-]*|url-params)|@mariozechner\/pi[\w/-]*|(?<=["'`])(?:pi|Pi)(?=["'` (])/g;

export function scanIdentities(path, text) {
  return [...text.matchAll(identityPattern)].map((match) => ({
    path,
    line: text.slice(0, match.index).split("\n").length,
    identity: match[0],
    context:
      text.slice(0, match.index).split("\n").at(-1) +
      text.slice(match.index).split("\n")[0],
  }));
}

export function checkIdentities(root) {
  const entries = JSON.parse(
    readFileSync(
      resolve(root, "scripts/runtime-identity-allowlist.json"),
      "utf8",
    ),
  );
  const tracked = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  const files = tracked.filter(
    (path) =>
      path &&
      existsSync(resolve(root, path)) &&
      (path.startsWith("packages/") ||
        path.startsWith(".github/") ||
        path.startsWith(".diffex/") ||
        [
          "package.json",
          "package-lock.json",
          "tsconfig.json",
          "SECURITY.md",
          "README.md",
          "LICENSE",
        ].includes(path)) &&
      !path.includes("/test/") &&
      !path.includes("/tests/") &&
      !path.endsWith("CHANGELOG.md") &&
      !/\.(?:png|jpg|gif|wasm|node|ico|pdf)$/.test(path),
  );
  const actual = files.flatMap((path) =>
    scanIdentities(path, readFileSync(resolve(root, path), "utf8")),
  );
  const expected = entries.flatMap(
    ({ path, context, identities, reason, category }) => {
      assert.ok(
        reason && ["approved integration", "legal notice"].includes(category),
        `Unreviewed entry: ${path}`,
      );
      return identities.map((identity) => ({ path, context, identity }));
    },
  );
  const normalize = (items) =>
    items
      .map(({ path, context, identity }) =>
        JSON.stringify({ path, context, identity }),
      )
      .sort();
  assert.deepEqual(
    normalize(actual),
    normalize(expected),
    "Runtime identity inventory changed; remove unapproved identities or explicitly review exact occurrences.",
  );
  return { files: files.length, occurrences: actual.length };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(checkIdentities(resolve(import.meta.dirname, ".."))),
  );
}
