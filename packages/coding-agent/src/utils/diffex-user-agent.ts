export function getDiffexUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `diffex/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
