export const BOOTSTRAP_DIST_TAG = "bootstrap";

const USAGE = "Usage: node scripts/publish.mjs [--dry-run] [--bootstrap]";

export function parsePublishArgs(args) {
	const unknownArgs = args.filter((arg) => arg !== "--dry-run" && arg !== "--bootstrap");
	if (unknownArgs.length > 0) {
		throw new Error(USAGE);
	}

	return {
		bootstrap: args.includes("--bootstrap"),
		dryRun: args.includes("--dry-run"),
	};
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
