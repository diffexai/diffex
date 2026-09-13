import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

export function findNpmRecoveryDirectory(scope, errorOutput) {
	assert(errorOutput.includes("ENOTEMPTY"), "Recovery requires npm ENOTEMPTY evidence");
	const candidates = readdirSync(scope, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && (entry.name === "diffex" || /^\.diffex-[a-zA-Z0-9]+$/.test(entry.name)))
		.map((entry) => join(scope, entry.name))
		.filter((path) => errorOutput.includes(path) || errorOutput.includes(realpathSync(path)));
	const backups = candidates.filter((path) => basename(path).startsWith(".diffex-"));
	const affected = backups.length ? backups : candidates;
	assert.equal(
		affected.length,
		1,
		`Expected one reported Diffex installation or backup inside the isolated prefix:\n${errorOutput}`,
	);
	return affected[0];
}
