import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { stageCliDistribution } from "./stage-cli-distribution.mjs";
import { join, resolve } from "node:path";
import { assertChangelogsReady, preparePackageDistribution } from "./prepare-distribution.mjs";

// Publish and local acceptance must consume these exact checked bytes.
// Never validate `npm pack --dry-run` and then publish a workspace directory.
export function packReviewedPackage(pkg, outputDirectory) {
	assertChangelogsReady();
	preparePackageDistribution(pkg.directory);
	const stage = pkg.name === "@diffexai/diffex" ? mkdtempSync(join(tmpdir(), "diffex-cli-pack-")) : undefined;
	try {
		if (stage) stageCliDistribution(pkg.directory, stage);
		const [packed] = JSON.parse(
			execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", resolve(outputDirectory)], {
				cwd: stage ?? pkg.directory,
				encoding: "utf8",
				maxBuffer: 20 * 1024 * 1024,
			}),
		);
		const file = join(resolve(outputDirectory), packed.filename);
		const inspection = JSON.parse(
			execFileSync(
				"python3",
				["scripts/check-distribution-payload.py", file, "--name", pkg.name, "--version", pkg.version],
				{ encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
			),
		);
		const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
		return { file, sha256, name: pkg.name, version: pkg.version, payloadFiles: inspection.payloadFiles };
	} finally {
		if (stage) rmSync(stage, { recursive: true, force: true });
	}
}
