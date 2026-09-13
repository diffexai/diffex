import { createHash } from "node:crypto";

const REGISTRY = "https://registry.npmjs.org";
const TIMEOUT = 30_000;
const MAX_TARBALL_BYTES = 256 * 1024 * 1024;
export const integrity = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyNpmArtifact(pkg, { allowMissing = false } = {}) {
	const response = await fetch(`${REGISTRY}/${encodeURIComponent(pkg.name)}/${pkg.version}`, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT),
	});
	if (response.status === 404 && allowMissing) return undefined;
	if (!response.ok) throw new Error(`${pkg.name}: npm metadata unavailable (${response.status})`);
	const metadata = await response.json();
	const expectedUrl = `${REGISTRY}/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`;
	if (
		metadata?.name !== pkg.name ||
		metadata?.version !== pkg.version ||
		metadata?.dist?.tarball !== expectedUrl ||
		metadata?.dist?.integrity !== pkg.integrity
	)
		throw new Error(`${pkg.name}: published metadata conflicts with approved artifact`);
	const tarball = await fetch(expectedUrl, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT) });
	if (!tarball.ok) throw new Error(`${pkg.name}: tarball unavailable (${tarball.status})`);
	if (!tarball.body) throw new Error(`${pkg.name}: missing tarball body`);
	const sha = createHash("sha256");
	const sri = createHash("sha512");
	let size = 0;
	for await (const chunk of tarball.body) {
		size += chunk.length;
		if (size > MAX_TARBALL_BYTES) throw new Error(`${pkg.name}: tarball exceeds size limit`);
		sha.update(chunk);
		sri.update(chunk);
	}
	if (size !== pkg.size || sha.digest("hex") !== pkg.sha256 || `sha512-${sri.digest("base64")}` !== pkg.integrity)
		throw new Error(`${pkg.name}: published tarball bytes conflict with approved artifact`);
	return { name: pkg.name, version: pkg.version, tarball: expectedUrl, integrity: pkg.integrity };
}

export async function readNpmPackageState(name) {
	const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}`, {
		headers: { accept: "application/json" },
		redirect: "error",
		signal: AbortSignal.timeout(TIMEOUT),
	});
	if (response.status === 404) return { registered: false, distTags: {} };
	if (!response.ok) throw new Error(`${name}: npm package inventory unavailable (${response.status})`);
	const metadata = await response.json();
	const tags = metadata?.["dist-tags"];
	if (
		metadata?.name !== name ||
		!tags ||
		typeof tags !== "object" ||
		Array.isArray(tags) ||
		Object.values(tags).some((version) => typeof version !== "string")
	)
		throw new Error(`${name}: invalid npm package inventory`);
	return { registered: true, distTags: tags };
}
