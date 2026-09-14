import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { distributionDocs } from "./cli-distribution.mjs";

test("image inspection rejects separate NOTICE files and development documents in earlier layers", () => {
	const directory = mkdtempSync(join(tmpdir(), "diffex runtime layers "));
	try {
		const write = (file, content) => {
			const path = join(directory, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		};
		const layer = "layer/opt/diffex/";
		const workspace = `${layer}packages/coding-agent/`;
		write(`${layer}runtime-distribution.json`, JSON.stringify({ sourceCommit: "a".repeat(40) }));
		write(`${workspace}LICENSE`, readFileSync("LICENSE"));
		write(`${workspace}THIRD-PARTY-NOTICES.txt`, "Reviewed notice");
		write(`${workspace}dist/AGENTS.md`, readFileSync("AGENTS_release.md"));
		for (const doc of distributionDocs) write(workspace + doc, "User-facing guide");
		write(
			"config.json",
			JSON.stringify({
				architecture: "amd64",
				os: "linux",
				config: { Labels: { "org.opencontainers.image.revision": "a".repeat(40) } },
			}),
		);
		write("manifest.json", JSON.stringify([{ Config: "config.json", Layers: ["layer.tar", "cleanup.tar"] }]));
		write("cleanup/opt/diffex/packages/coding-agent/docs/.wh.development.md", "");
		execFileSync("tar", ["-cf", join(directory, "cleanup.tar"), "-C", join(directory, "cleanup"), "opt"], {
			env: { ...process.env, COPYFILE_DISABLE: "1" },
		});
		const inspect = () => {
			execFileSync("tar", ["-cf", join(directory, "layer.tar"), "-C", join(directory, "layer"), "opt"], {
				env: { ...process.env, COPYFILE_DISABLE: "1" },
			});
			execFileSync(
				"tar",
				[
					"-cf",
					join(directory, "image.tar"),
					"-C",
					directory,
					"manifest.json",
					"config.json",
					"layer.tar",
					"cleanup.tar",
				],
				{ env: { ...process.env, COPYFILE_DISABLE: "1" } },
			);
			return spawnSync("python3", [resolve("scripts/check-runtime-image.py"), join(directory, "image.tar")], {
				encoding: "utf8",
			});
		};
		const valid = inspect();
		assert.equal(valid.status, 0, valid.stderr);
		write(`${workspace}dist/AGENTS.md`, "Private repository instructions");
		const substituted = inspect();
		assert.notEqual(substituted.status, 0);
		assert.match(substituted.stderr, /prohibited repository instructions/);
		write(`${workspace}dist/AGENTS.md`, readFileSync("AGENTS_release.md"));
		write(`${layer}packages/agent/dist/AGENTS.md`, readFileSync("AGENTS_release.md"));
		const misplaced = inspect();
		assert.notEqual(misplaced.status, 0);
		assert.match(misplaced.stderr, /prohibited repository instructions/);
		rmSync(join(directory, layer, "packages/agent"), { recursive: true });
		write(`${workspace}NOTICE`, "Duplicate project attribution");
		const notice = inspect();
		assert.notEqual(notice.status, 0);
		assert.match(notice.stderr, /NOTICE/);
		rmSync(join(directory, workspace, "NOTICE"));
		write(`${workspace}docs/development.md`, "Private development handoff");
		const invalid = inspect();
		assert.notEqual(invalid.status, 0);
		assert.match(invalid.stderr, /unapproved distribution documentation/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
