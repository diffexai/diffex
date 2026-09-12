import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROJECT_CHANGELOGS } from "./prepare-distribution.mjs";

test("actual npm tarball carries notices and excludes debug sources after preparation", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-prepack-test-"));
	try {
		mkdirSync(join(root, "scripts"));
		for (const script of [
			"prepare-distribution.mjs",
			"release-packages.mjs",
			"release-distribution-manifest.mjs",
			"package-workspaces.mjs",
			"check-distribution-payload.py",
		])
			cpSync(`scripts/${script}`, join(root, "scripts", script));
		cpSync("LICENSE", join(root, "LICENSE"));
		for (const file of PROJECT_CHANGELOGS) {
			mkdirSync(join(root, file, ".."), { recursive: true });
			writeFileSync(join(root, file), "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Diffex fixture feature.\n");
		}
		const pkg = join(root, "packages/agent");
		mkdirSync(join(pkg, "dist"));
		mkdirSync(join(pkg, "src"));
		writeFileSync(join(pkg, "src/index.ts"), "export const value = 1;\n");
		writeFileSync(
			join(pkg, "package.json"),
			JSON.stringify({
				name: "@diffexai/diffex-agent-core",
				version: "0.2.0",
				license: "Apache-2.0",
				type: "module",
				files: [
					"dist",
					"LICENSE",
					"NOTICE",
					"THIRD-PARTY-NOTICES.txt",
					"distribution-components.json",
					"distribution-files.json",
				],
			}),
		);
		writeFileSync(join(pkg, "dist/index.js"), "export const value = 1;\n//# sourceMappingURL=index.js.map\n");
		writeFileSync(join(pkg, "dist/index.js.map"), '{"sourcesContent":["private TypeScript"]}');
		writeFileSync(
			join(pkg, "dist/index.d.ts"),
			"export declare const value: number;\n//# sourceMappingURL=index.d.ts.map\n",
		);
		writeFileSync(join(pkg, "dist/index.d.ts.map"), '{"sourcesContent":["private declaration source"]}');
		execFileSync("node", [join(root, "scripts/prepare-distribution.mjs"), "packages/agent"], {
			cwd: tmpdir(),
			env: { ...process.env, DIFFEX_SOURCE_COMMIT: "a".repeat(40) },
		});
		assert.equal(existsSync(join(pkg, "dist/index.js.map")), false);
		assert.match(
			readFileSync(
				join(root, ".artifacts/private-debug", "a".repeat(40), "@diffexai-diffex-agent-core/dist/index.js.map"),
				"utf8",
			),
			/private TypeScript/,
		);
		const [packed] = JSON.parse(
			execFileSync(
				"npm",
				["pack", "--ignore-scripts", "--json", "--cache", join(root, "cache"), "--pack-destination", root],
				{ cwd: pkg, encoding: "utf8" },
			),
		);
		const result = spawnSync("python3", ["scripts/check-distribution-payload.py", join(root, packed.filename)], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		writeFileSync(join(root, PROJECT_CHANGELOGS[0]), "");
		const blocked = spawnSync("node", ["scripts/prepare-distribution.mjs", "packages/agent"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.notEqual(blocked.status, 0);
		assert.match(blocked.stderr, /owner \/cl regeneration is required/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
