import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROJECT_CHANGELOGS } from "./prepare-distribution.mjs";
import { cliDistribution, distributionDocs } from "./cli-distribution.mjs";

test("packed CLI exposes the product homepage and preserves referenced documentation", () => {
	const root = mkdtempSync(join(tmpdir(), "diffex-cli-presentation-"));
	try {
		const copy = (file) => {
			mkdirSync(join(root, file, ".."), { recursive: true });
			cpSync(file, join(root, file));
		};
		for (const script of [
			"prepare-distribution.mjs",
			"release-packages.mjs",
			"release-distribution-manifest.mjs",
			"package-workspaces.mjs",
			"check-distribution-payload.py",
			"distribution-docs.json",
			"cli-distribution.mjs",
			"stage-cli-distribution.mjs",
		])
			copy(`scripts/${script}`);
		for (const file of [
			"LICENSE",
			"docs/release/distribution-policy.json",
			"legal/upstream/highlight-11.9.0.LICENSE",
			"node_modules/marked/LICENSE",
			"packages/coding-agent/npm-shrinkwrap.json",
			"packages/coding-agent/install-lock/package.json",
			"packages/coding-agent/install-lock/package-lock.json",
		])
			copy(file);
		const directories = [
			"packages/coding-agent",
			"packages/evolution",
			"packages/harness-trace",
			...cliDistribution().bundled.map((pkg) => pkg.directory),
		];
		for (const directory of directories) {
			copy(`${directory}/package.json`);
			for (const folder of ["src", "dist", "docs"]) mkdirSync(join(root, directory, folder), { recursive: true });
			writeFileSync(join(root, directory, "src/index.ts"), "export const value = 1;\n");
			writeFileSync(join(root, directory, "dist/index.js"), "export const value = 1;\n");
			for (const file of ["README.md", "CONTRIBUTING.md", "docs/skills.md", "CHANGELOG.md"])
				writeFileSync(join(root, directory, file), "Repository documentation\n");
		}
		const pkg = join(root, "packages/coding-agent");
		cpSync("packages/coding-agent/docs", join(pkg, "docs"), { recursive: true });
		const excludedDocs = [
			"development.md",
			"docs.json",
			"index.md",
			"invocation-traces.md",
			"images/doom-extension.png",
			"images/exy.png",
			"new-internal-audit.md",
			"windows.md",
			"termux.md",
		];
		writeFileSync(join(pkg, "docs/new-internal-audit.md"), "Private audit must never ship");
		const metadata = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
		metadata.files.push("CONTRIBUTING.md");
		writeFileSync(join(pkg, "package.json"), JSON.stringify(metadata));
		for (const platform of ["darwin", "win32"])
			mkdirSync(join(root, "packages/tui/native", platform, "prebuilds"), { recursive: true });
		writeFileSync(
			join(root, "prepare.mjs"),
			'import { preparePackageDistribution } from "./scripts/prepare-distribution.mjs";\n' +
				'import { stageCliDistribution } from "./scripts/stage-cli-distribution.mjs";\n' +
				'preparePackageDistribution("packages/coding-agent");\n' +
				'stageCliDistribution("packages/coding-agent", "stage");\n',
		);
		execFileSync("node", ["prepare.mjs"], {
			cwd: root,
			env: { ...process.env, DIFFEX_SOURCE_COMMIT: "a".repeat(40) },
		});
		const [packed] = JSON.parse(
			execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(root, "cache")], {
				cwd: join(root, "stage"),
				encoding: "utf8",
			}),
		);
		const archive = join(root, "stage", packed.filename);
		const published = JSON.parse(
			execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
		);
		assert.equal(published.homepage, "https://diffex.ai/");
		assert.equal(published.repository, undefined);
		assert.equal(published.bugs, undefined);
		assert.equal(published.diffexConfig.production, true);
		assert.match(
			execFileSync("tar", ["-xOf", archive, "package/README.md"], { encoding: "utf8" }),
			/docs\/installation\.md/,
		);
		for (const file of readdirSync(join(pkg, "docs"), { recursive: true })) {
			const source = join(pkg, "docs", file);
			if (!statSync(source).isFile()) continue;
			const path = `docs/${file.replaceAll("\\", "/")}`;
			if (!distributionDocs.includes(path)) {
				assert(!packed.files.some((entry) => entry.path === path), `${path} must not ship`);
			} else {
				assert.deepEqual(
					execFileSync("tar", ["-xOf", archive, `package/${path}`]),
					readFileSync(source),
					`${path} must remain intact`,
				);
			}
		}
		for (const file of excludedDocs) assert(existsSync(join(pkg, "docs", file)), `${file} must remain in source`);
		for (const { path } of packed.files)
			assert(!path.split("/").some((part) => ["notice", "contributing.md"].includes(part.toLowerCase())), path);
		const attribution = execFileSync("tar", ["-xOf", archive, "package/THIRD-PARTY-NOTICES.txt"], {
			encoding: "utf8",
		});
		assert(attribution.startsWith(readFileSync(join(pkg, "NOTICE"), "utf8")));
		assert.match(attribution, /highlight\.js@11\.9\.0/);
		assert.match(attribution, /marked@18\.0\.5/);
		const result = spawnSync("python3", ["scripts/check-distribution-payload.py", archive], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

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
			"distribution-docs.json",
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
