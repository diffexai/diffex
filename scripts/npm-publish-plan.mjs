export const BOOTSTRAP_DIST_TAG = "bootstrap";

const USAGE = "Usage: node scripts/publish.mjs [--dry-run] [--bootstrap] [--artifacts DIRECTORY]";

export function parsePublishArgs(args) {
	const options = { bootstrap: false, dryRun: false };
	const seen = new Set();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (seen.has(arg)) throw new Error(USAGE);
		seen.add(arg);
		if (arg === "--bootstrap") options.bootstrap = true;
		else if (arg === "--dry-run") options.dryRun = true;
		else if (arg === "--artifacts" && args[index + 1] && !args[index + 1].startsWith("--"))
			options.artifacts = args[++index];
		else throw new Error(USAGE);
	}
	return options;
}

export function createPublishArgs({ bootstrap }) {
	return [
		"publish",
		"--access",
		"public",
		...(bootstrap ? ["--tag", BOOTSTRAP_DIST_TAG] : ["--provenance"]),
		"--ignore-scripts",
	];
}

export function assertBootstrapPackageStates(packageStates) {
	const conflicts = packageStates.filter((pkg) => pkg.registered && !pkg.published);
	if (conflicts.length === 0) {
		return;
	}

	throw new Error(
		`Bootstrap publishing is only for package registration. These packages already exist without the workspace version:\n${conflicts.map((pkg) => `  ${pkg.name}@${pkg.version}`).join("\n")}\nUse the normal release flow instead.`,
	);
}

export function createTrustedPublisherCommands(packageNames) {
	return packageNames.map(
		(packageName) =>
			`npm trust github ${packageName} --file build-binaries.yml --repo diffexai/diffex --env npm-publish --allow-publish --yes`,
	);
}
