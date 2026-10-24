import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkIdentities,
  scanIdentities,
} from "./check-runtime-identities.mjs";

test("checks path and exact content, and rejects added or stale exceptions", () => {
  const root = mkdtempSync(join(tmpdir(), "diffex-identity-gate-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages"));
    const path = "packages/catalog.ts";
    const context = 'const endpoint = "https://pi.dev";';
    const entries = [
      {
        path,
        context,
        identities: ["pi.dev"],
        category: "approved integration",
        reason: "Approved model catalog",
      },
    ];
    const allowlist = join(root, "scripts/runtime-identity-allowlist.json");
    writeFileSync(allowlist, JSON.stringify(entries));
    writeFileSync(join(root, path), context);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", path], { cwd: root });
    assert.equal(checkIdentities(root).occurrences, 1);
    writeFileSync(
      join(root, "README.md"),
      "Thank you to [Pi](https://github.com/earendil-works/pi).",
    );
    assert.equal(checkIdentities(root).occurrences, 1);
    writeFileSync(join(root, "README.md"), "# Diffex");
    assert.equal(checkIdentities(root).occurrences, 1);
    writeFileSync(
      join(root, path),
      context + '\nfetch("https://pi.dev/api/report-install");',
    );
    assert.throws(() => checkIdentities(root));
    writeFileSync(
      join(root, path),
      "const endpoint = 'https://api.diffex.ai';",
    );
    assert.throws(() => checkIdentities(root));
    writeFileSync(
      join(root, path),
      context.replace("const endpoint", "const authority"),
    );
    assert.throws(() => checkIdentities(root));
    writeFileSync(join(root, path), context);
    writeFileSync(
      allowlist,
      JSON.stringify([{ ...entries[0], category: "deferred exception" }]),
    );
    assert.throws(() => checkIdentities(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("finds inherited packages, services, operational identities and attribution", () => {
  const text =
    '@earendil-works/gondolin security@earendil.com @mariozechner/pi-ai pi-share:v1:sidebar-width "Pi" "pi (browser)"';
  assert.equal(scanIdentities("source.ts", text).length, 6);
  assert.equal(
    scanIdentities("math.ts", 'const pi = Math.PI; pi: "π"').length,
    0,
  );
});
