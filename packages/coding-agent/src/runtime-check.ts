// Evaluate before the CLI's application imports so older Node installations get
// an actionable message rather than an exception from a provider dependency.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	console.error(`Diffex requires Node.js 22.19.0 or newer (found ${process.versions.node}).`);
	console.error(
		"Upgrade Node with your version manager, then reinstall @diffexai/diffex using the same package manager and prefix.",
	);
	process.exit(1);
}
