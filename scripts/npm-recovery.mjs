import assert from "node:assert/strict";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function findNpmRecoveryBackup(scope, errorOutput) {
	assert(errorOutput.includes("ENOTEMPTY"), "Recovery requires npm ENOTEMPTY evidence");
	const candidates = readdirSync(scope, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && /^\.diffex-[a-zA-Z0-9]+$/.test(entry.name))
		.map((entry) => join(scope, entry.name))
		.filter((path) => errorOutput.includes(path) || errorOutput.includes(realpathSync(path)));
	assert.equal(
		candidates.length,
		1,
		`Expected one reported Diffex backup inside the isolated prefix:\n${errorOutput}`,
	);
	return candidates[0];
}
