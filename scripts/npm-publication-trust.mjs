import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrustedPublisherCommands } from "./npm-publish-plan.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

export function assertTrustedPublisher(value) {
	if (
		value?.type !== "github" ||
		value.repository !== "diffexai/diffex" ||
		value.file !== "build-binaries.yml" ||
		value.environment !== "npm-publish" ||
		!Array.isArray(value.permissions) ||
		value.permissions.length !== 1 ||
		value.permissions[0] !== "createPackage"
	)
		throw new Error("Expected exactly the Diffex GitHub npm publish relationship");
}

export function verifyPublicationTrust(packages, query) {
	return packages.map(({ name, directory }) => {
		const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		if (pkg.repository?.url !== "git+https://github.com/diffexai/diffex.git")
			throw new Error(`${name}: repository metadata must match the trusted source`);
		const value = query(name);
		assertTrustedPublisher(value);
		return {
			name,
			type: value.type,
			repository: value.repository,
			file: value.file,
			environment: value.environment,
			permissions: value.permissions,
		};
	});
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args.length !== 1 || !["--plan", "--verify"].includes(args[0]))
		throw new Error("Usage: node scripts/npm-publication-trust.mjs <--plan|--verify>");
	const packages = getPublicWorkspacePackages();
	if (args[0] === "--plan") {
		console.log(createTrustedPublisherCommands(packages.map(({ name }) => name)).join("\n"));
	} else {
		const verified = verifyPublicationTrust(packages, (name) => {
			const result = spawnSync(
				process.platform === "win32" ? "npm.cmd" : "npm",
				["trust", "list", name, "--json", "--registry=https://registry.npmjs.org"],
				{ encoding: "utf8", timeout: 120_000, stdio: ["inherit", "pipe", "pipe"] },
			);
			if (result.error || result.status !== 0)
				throw new Error(`${name}: npm trust list failed; use npm >=11.15.0 with authorized interactive authentication`);
			try {
				return JSON.parse(result.stdout);
			} catch {
				throw new Error(`${name}: expected exactly one JSON trust configuration`);
			}
		});
		console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), packages: verified }, null, 2));
	}
}
