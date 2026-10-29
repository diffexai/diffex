import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { generateHomebrewFormula, homebrewAssetUrl, validateHomebrewManifest } from "./homebrew-formula.mjs";
import { readHomebrewFile } from "./homebrew-runtime.mjs";

export const TAP_REPOSITORY = "diffexai/homebrew-tap";
export const TAP_FILES = Object.freeze(["Formula/diffex.rb", "homebrew-manifest.json"]);
const API = "https://api.github.com";
const REPOSITORY_API = `/repos/${TAP_REPOSITORY}`;
const MAX_MANIFEST_SIZE = 64 * 1024;

function publicAssetUrl(value, initial = false) {
	// Check the raw authority too: URL normalizes an explicit :443 port away.
	const authority = initial ? /^https:\/\/github\.com\// : /^https:\/\/(?:release-assets|objects)\.githubusercontent\.com\//;
	assert(typeof value === "string" && authority.test(value) && !value.includes("#"), "Unexpected public asset redirect");
	const parsed = new URL(value);
	assert(!parsed.username && !parsed.password && !parsed.port && !parsed.hash, "Unexpected public asset redirect");
	return parsed.href;
}

async function publicBytes(url, maxSize, request) {
	let current = publicAssetUrl(url, true);
	// One deadline covers every redirect and the complete response body.
	const signal = AbortSignal.timeout(120000);
	for (let redirects = 0; ; redirects++) {
		signal.throwIfAborted();
		const response = await request(current, {
			redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer", signal,
		});
		if ([301, 302, 303, 307, 308].includes(response.status)) {
			// Never consume a redirect body or request its target before validation.
			await response.body?.cancel();
			assert(redirects < 3, "Too many public asset redirects");
			current = publicAssetUrl(response.headers.get("location"));
			continue;
		}
		assert.equal(response.status, 200, "Required public Homebrew asset is unavailable");
		assert(response.body, "Public asset body is missing");
		const chunks = [];
		let size = 0;
		for await (const chunk of response.body) {
			signal.throwIfAborted();
			size += chunk.length;
			assert(size <= maxSize, "Public asset exceeds approved size");
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}
}

// The retained manifest is the authority, not the anonymously downloaded copy.
// Release approval/signature verification belongs to the calling publication gate.
export async function verifyPublicHomebrewAssets(approved, { request = fetch, manifestBytes } = {}) {
	validateHomebrewManifest(approved);
	const url = `https://github.com/diffexai/diffex/releases/download/v${approved.version}/homebrew-manifest.json`;
	const bytes = await publicBytes(url, manifestBytes ? Math.min(MAX_MANIFEST_SIZE, manifestBytes.length) : MAX_MANIFEST_SIZE, request);
	const published = validateHomebrewManifest(JSON.parse(bytes.toString("utf8")));
	assert.deepEqual(published, approved, "Public Homebrew manifest differs from the retained approval");
	if (manifestBytes) assert(bytes.equals(manifestBytes), "Public Homebrew manifest bytes differ from the retained approval");
	for (const entry of approved.platforms) {
		const archive = await publicBytes(homebrewAssetUrl(approved, entry.platform), entry.size, request);
		assert.equal(archive.length, entry.size, `Public asset size mismatch: ${entry.platform}`);
		assert.equal(createHash("sha256").update(archive).digest("hex"), entry.sha256, `Public asset digest mismatch: ${entry.platform}`);
	}
	return published;
}

function newer(version, previous) {
	const next = version.split(".").map(BigInt);
	const old = previous.split(".").map(BigInt);
	const difference = next.findIndex((part, index) => part !== old[index]);
	return difference !== -1 && next[difference] > old[difference];
}

export async function updateHomebrewTap(approved, { token, request = fetch, publicRequest = fetch, manifestBytes } = {}) {
	// Snapshot caller-owned input before the first await so verification and writes
	// cannot observe different manifests.
	const manifest = structuredClone(validateHomebrewManifest(approved));
	assert(typeof token === "string" && token.trim() === token && token.length > 0 && !/[\r\n]/.test(token), "HOMEBREW_TAP_TOKEN is required");
	await verifyPublicHomebrewAssets(manifest, { request: publicRequest, manifestBytes });
	const api = async (method, path, body, allowMissing = false) => {
		assert(path === "/installation/repositories?per_page=100" || path.startsWith(`${REPOSITORY_API}/`), "Disallowed GitHub API path");
		const response = await request(`${API}${path}`, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(30000),
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		if (allowMissing && response.status === 404) return null;
		assert(response.status >= 200 && response.status < 300, `Tap GitHub API ${method} failed (${response.status})`);
		return response.json();
	};
	// This endpoint requires an installation token. Refuse user/PAT credentials
	// and tokens currently able to access anything other than this one tap repo.
	// The issuer must additionally request only contents/pull_requests write.
	const installation = await api("GET", "/installation/repositories?per_page=100");
	assert(installation.total_count === 1 && installation.repositories?.length === 1 && installation.repositories[0].full_name === TAP_REPOSITORY, "GitHub App token must be scoped only to diffexai/homebrew-tap");
	const branch = `automation/diffex-v${manifest.version}`;
	const content = {
		"Formula/diffex.rb": generateHomebrewFormula(manifest),
		"homebrew-manifest.json": manifestBytes ? Buffer.from(manifestBytes).toString("utf8") : `${JSON.stringify(manifest, null, 2)}\n`,
	};
	const contents = async (file, ref, allowMissing = false) => {
		assert(TAP_FILES.includes(file), "Disallowed tap file");
		const result = await api("GET", `${REPOSITORY_API}/contents/${file}?ref=${encodeURIComponent(ref)}`, undefined, allowMissing);
		if (!result) return null;
		assert(result.type === "file" && result.encoding === "base64", "Unexpected tap file encoding");
		return Buffer.from(result.content, "base64").toString("utf8");
	};
	const previousBytes = await contents("homebrew-manifest.json", "main", true);
	if (previousBytes) {
		const previous = validateHomebrewManifest(JSON.parse(previousBytes));
		if (previous.version === manifest.version) {
			assert(isDeepStrictEqual(previous, manifest), "Published tap version has different approved inputs");
			assert.equal(await contents("Formula/diffex.rb", "main"), content["Formula/diffex.rb"], "Published formula differs from canonical generation");
			return { status: "unchanged", branch };
		}
		assert(newer(manifest.version, previous.version), "Refusing to downgrade the Homebrew tap");
	}
	const base = await api("GET", `${REPOSITORY_API}/git/ref/heads/main`);
	assert.match(base.object?.sha ?? "", /^[a-f0-9]{40}$/);
	const existing = await api("GET", `${REPOSITORY_API}/git/ref/heads/${branch}`, undefined, true);
	if (existing) {
		for (const file of TAP_FILES)
			assert.equal(await contents(file, branch), content[file], "Existing deterministic branch has unexpected content; manual review required");
		const comparison = await api("GET", `${REPOSITORY_API}/compare/main...${branch}`);
		assert(comparison.status === "ahead" && comparison.files?.length > 0 && comparison.files.length <= TAP_FILES.length, "Existing tap branch is not a narrow forward update");
		for (const file of comparison.files)
			assert(TAP_FILES.includes(file.filename) && ["added", "modified"].includes(file.status) && !file.previous_filename, "Existing branch modifies disallowed files");
	} else {
		const commit = await api("GET", `${REPOSITORY_API}/git/commits/${base.object.sha}`);
		assert.match(commit.tree?.sha ?? "", /^[a-f0-9]{40}$/);
		const tree = [];
		for (const path of TAP_FILES) {
			const blob = await api("POST", `${REPOSITORY_API}/git/blobs`, { content: content[path], encoding: "utf-8" });
			assert.match(blob.sha ?? "", /^[a-f0-9]{40}$/);
			tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
		}
		const updated = await api("POST", `${REPOSITORY_API}/git/trees`, { base_tree: commit.tree.sha, tree });
		assert.match(updated.sha ?? "", /^[a-f0-9]{40}$/);
		const created = await api("POST", `${REPOSITORY_API}/git/commits`, { message: `Update diffex to ${manifest.version}`, tree: updated.sha, parents: [base.object.sha] });
		assert.match(created.sha ?? "", /^[a-f0-9]{40}$/);
		await api("POST", `${REPOSITORY_API}/git/refs`, { ref: `refs/heads/${branch}`, sha: created.sha });
	}
	const pulls = await api("GET", `${REPOSITORY_API}/pulls?state=all&head=diffexai:${branch}&base=main&per_page=100`);
	assert(Array.isArray(pulls) && pulls.length <= 1, "Ambiguous tap update pull requests");
	if (pulls.length) {
		assert(pulls[0].state === "open" && pulls[0].head?.ref === branch && pulls[0].head?.repo?.full_name === TAP_REPOSITORY && pulls[0].base?.ref === "main", "Existing tap update PR requires manual review");
		return { status: "existing", branch, number: pulls[0].number };
	}
	const pull = await api("POST", `${REPOSITORY_API}/pulls`, {
		title: `Update diffex to ${manifest.version}`,
		head: branch,
		base: "main",
		body: `Updates only the canonical formula and approved Homebrew manifest.\n\nRelease: https://github.com/diffexai/diffex/releases/tag/v${manifest.version}\nSource commit: ${manifest.sourceCommit}\n\nAll four public asset sizes and SHA-256 digests were checked against the retained approved manifest before this PR was created.\n\nInstall: brew install diffexai/tap/diffex\n`,
		maintainer_can_modify: false,
	});
	return { status: "created", branch, number: pull.number };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [flag, path, ...extra] = process.argv.slice(2);
	assert(flag === "--manifest" && path && !extra.length, "Usage: node scripts/update-homebrew-tap.mjs --manifest PATH");
	const manifestBytes = readHomebrewFile(path, MAX_MANIFEST_SIZE);
	const result = await updateHomebrewTap(JSON.parse(manifestBytes.toString("utf8")), {
		token: process.env.HOMEBREW_TAP_TOKEN,
		manifestBytes,
	});
	console.log(JSON.stringify(result));
}
