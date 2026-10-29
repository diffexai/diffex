import assert from "node:assert/strict";
import test from "node:test";
import { homebrewFixture } from "./fixtures/homebrew.mjs";
import { generateHomebrewFormula } from "./homebrew-formula.mjs";
import { TAP_FILES, updateHomebrewTap, verifyPublicHomebrewAssets } from "./update-homebrew-tap.mjs";

function fixture(options = {}) {
	const { manifest, assets, manifestBytes } = homebrewFixture();
	const events = [];
	const mutations = [];
	const branch = `automation/diffex-v${manifest.version}`;
	const content = { "Formula/diffex.rb": generateHomebrewFormula(manifest), "homebrew-manifest.json": manifestBytes.toString() };
	let index = 0;
	const publicRequest = async (url, init) => {
		events.push({ kind: "public", url, init });
		assert.equal(init.headers, undefined, "Public requests must never carry tap credentials");
		if (url.endsWith("/homebrew-manifest.json")) return new Response(options.publicManifest ?? manifestBytes, { status: options.publicStatus ?? 200 });
		const entry = manifest.platforms.find((entry) => url.endsWith(`/${entry.filename}`));
		assert(entry, `Unexpected public URL: ${url}`);
		return new Response(options.badAsset ? Buffer.from("untrusted") : assets.get(entry.platform));
	};
	const request = async (url, init) => {
		events.push({ kind: "api", url, init });
		assert.equal(init.headers.Authorization, "Bearer fixture-installation-token");
		assert.equal(init.redirect, "error");
		assert(url.startsWith("https://api.github.com/"));
		const path = new URL(url).pathname;
		const body = init.body ? JSON.parse(init.body) : undefined;
		if (init.method !== "GET") mutations.push({ path, body });
		let result;
		if (path === "/installation/repositories") {
			result = options.installation ?? { total_count: 1, repositories: [{ full_name: "diffexai/homebrew-tap" }] };
		} else {
			assert(path.startsWith("/repos/diffexai/homebrew-tap/"), "Credential may only be sent to the fixed tap repository");
			const local = path.slice("/repos/diffexai/homebrew-tap/".length);
			if (local.startsWith("contents/")) {
				const file = local.slice("contents/".length);
				assert(TAP_FILES.includes(file));
				const ref = new URL(url).searchParams.get("ref");
				if (ref === "main" && !options.previous) return new Response(null, { status: 404 });
				const bytes = ref === "main" ? (file === "homebrew-manifest.json" ? JSON.stringify(options.previous) : content[file]) : (options.branchContent?.[file] ?? content[file]);
				result = { type: "file", encoding: "base64", content: Buffer.from(bytes).toString("base64") };
			} else if (local === "git/ref/heads/main") result = { object: { sha: "1".repeat(40) } };
			else if (local === `git/ref/heads/${branch}`) {
				if (!options.existingBranch) return new Response(null, { status: 404 });
				result = { object: { sha: "2".repeat(40) } };
			} else if (local.startsWith("git/commits/") && init.method === "GET") result = { tree: { sha: "3".repeat(40) } };
			else if (local === `compare/main...${branch}`) result = options.comparison ?? { status: "ahead", files: TAP_FILES.map((filename) => ({ filename, status: "modified" })) };
			else if (local === "pulls" && init.method === "GET") result = options.pulls ?? [];
			else if (local === "pulls" && init.method === "POST") result = { number: 12 };
			else if (init.method === "POST" && ["git/blobs", "git/trees", "git/commits", "git/refs"].includes(local)) result = { sha: String(++index).repeat(40) };
			else assert.fail(`Unexpected GitHub operation: ${init.method} ${local}`);
		}
		return Response.json(result);
	};
	return { manifest, manifestBytes, content, assets, events, mutations, branch, publicRequest, request };
}

const run = (value) => updateHomebrewTap(value.manifest, { token: "fixture-installation-token", request: value.request, publicRequest: value.publicRequest, manifestBytes: value.manifestBytes });

test("public verifier compares retained manifest bytes and every approved asset size/hash anonymously", async () => {
	const value = fixture();
	await verifyPublicHomebrewAssets(value.manifest, { request: value.publicRequest, manifestBytes: value.manifestBytes });
	assert.equal(value.events.length, 5);
	assert(value.events.every((event) => event.kind === "public"));
});

test("public verification failure never reaches the credentialed API", async () => {
	for (const options of [
		{ publicStatus: 404 },
		{ publicManifest: JSON.stringify(homebrewFixture("9.9.9").manifest) },
		{ publicManifest: "{}" },
		{ publicManifest: JSON.stringify(homebrewFixture().manifest) }, // Equivalent JSON is not exact retained bytes.
		{ badAsset: true },
	]) {
		const value = fixture(options);
		await assert.rejects(run(value));
		assert.equal(value.events.filter((event) => event.kind === "api").length, 0);
	}
	const oversize = fixture();
	oversize.manifest.platforms[0].size = 1;
	await assert.rejects(verifyPublicHomebrewAssets(oversize.manifest, {
		request: async (url) => new Response(url.endsWith(".json") ? JSON.stringify(oversize.manifest) : "too large"),
	}), /exceeds approved size/);
	const digest = fixture();
	await assert.rejects(verifyPublicHomebrewAssets(digest.manifest, {
		request: async (url) => new Response(url.endsWith(".json") ? digest.manifestBytes : Buffer.alloc(digest.manifest.platforms[0].size)),
	}), /digest mismatch/);
});

test("public downloads manually follow only approved CDN hops without credentials and share one deadline", async () => {
	const value = fixture();
	const hops = [];
	const publicRequest = async (url, init) => {
		hops.push({ url, init });
		assert.equal(init.redirect, "manual");
		assert.equal(init.credentials, "omit");
		assert.equal(init.referrerPolicy, "no-referrer");
		assert.equal(init.headers, undefined);
		assert(!url.includes("fixture-installation-token"));
		const parsed = new URL(url);
		if (parsed.hostname === "github.com")
			return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/asset?source=${encodeURIComponent(url)}` } });
		if (parsed.hostname === "release-assets.githubusercontent.com")
			return new Response(null, { status: 307, headers: { location: `https://objects.githubusercontent.com/asset?source=${encodeURIComponent(parsed.searchParams.get("source"))}` } });
		assert.equal(parsed.hostname, "objects.githubusercontent.com");
		return value.publicRequest(parsed.searchParams.get("source"), init);
	};
	await updateHomebrewTap(value.manifest, { token: "fixture-installation-token", request: value.request, publicRequest, manifestBytes: value.manifestBytes });
	assert.equal(hops.length, 15);
	for (let index = 0; index < hops.length; index += 3) {
		assert.equal(hops[index].init.signal, hops[index + 1].init.signal);
		assert.equal(hops[index].init.signal, hops[index + 2].init.signal);
	}
});

test("untrusted redirect intermediaries are rejected before any request or credentialed API call", async () => {
	for (const location of [
		"https://evil.invalid/intermediary",
		"http://release-assets.githubusercontent.com/asset",
		"https://release-assets.githubusercontent.com.evil.invalid/asset",
		"https://user:password@release-assets.githubusercontent.com/asset",
		"https://release-assets.githubusercontent.com:443/asset",
		"https://objects.githubusercontent.com:8443/asset",
		"https://objects.githubusercontent.com/asset#fragment",
		"https://objects.githubusercontent.com/asset#",
		"https://github.com/diffexai/diffex/releases/download/other",
		"/relative-redirect",
		null,
	]) {
		const value = fixture();
		const requested = [];
		let cancelled = 0;
		await assert.rejects(updateHomebrewTap(value.manifest, {
			token: "fixture-installation-token",
			request: async () => assert.fail("Unverified redirect must not reach the authenticated API"),
			publicRequest: async (url, init) => {
				requested.push(url);
				assert.equal(init.redirect, "manual");
				assert.equal(init.credentials, "omit");
				assert.equal(init.headers, undefined);
				assert(!url.includes("fixture-installation-token"));
				const target = requested.length === 1 ? "https://release-assets.githubusercontent.com/intermediary" : location;
				return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
					status: 302, headers: target ? { location: target } : {},
				});
			},
		}), /Unexpected public asset redirect/);
		assert.equal(requested.length, 2, "Disallowed target must never be requested");
		assert.equal(cancelled, 2, "Redirect response bodies must be cancelled");
	}
});

test("public download redirect chains are limited to three hops", async () => {
	const value = fixture();
	let requests = 0;
	await assert.rejects(verifyPublicHomebrewAssets(value.manifest, {
		request: async (_, init) => {
			requests++;
			assert.equal(init.redirect, "manual");
			return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/loop" } });
		},
	}), /Too many public asset redirects/);
	assert.equal(requests, 4);
});

test("requires a narrow installation token and rejects invalid inputs before writes", async () => {
	for (const installation of [
		{ total_count: 2, repositories: [{ full_name: "diffexai/homebrew-tap" }, { full_name: "diffexai/diffex" }] },
		{ total_count: 1, repositories: [{ full_name: "foreign/tap" }] },
		{ total_count: 1, repositories: [] },
	]) {
		const value = fixture({ installation });
		await assert.rejects(run(value), /scoped only/);
		assert.equal(value.mutations.length, 0);
	}
	const value = fixture();
	await assert.rejects(updateHomebrewTap(value.manifest, { token: "", publicRequest: value.publicRequest }), /TOKEN/);
	assert.equal(value.events.length, 0);
	const malformed = fixture();
	malformed.manifest.url = "https://evil.invalid";
	await assert.rejects(run(malformed));
	assert.equal(malformed.events.length, 0);
});

test("creates one atomic allowlisted commit on deterministic branch and opens a PR, never pushes main or merges", async () => {
	const value = fixture();
	assert.deepEqual(await run(value), { status: "created", branch: value.branch, number: 12 });
	assert.deepEqual(value.events.slice(0, 5).map((event) => event.kind), Array(5).fill("public"));
	const blobs = value.mutations.filter((item) => item.path.endsWith("/git/blobs"));
	assert.deepEqual(blobs.map((item) => item.body.content), TAP_FILES.map((file) => value.content[file]));
	const tree = value.mutations.find((item) => item.path.endsWith("/git/trees"));
	assert.equal(tree.body.base_tree, "3".repeat(40));
	assert.deepEqual(tree.body.tree.map((item) => item.path), TAP_FILES);
	const ref = value.mutations.find((item) => item.path.endsWith("/git/refs"));
	assert.equal(ref.body.ref, `refs/heads/${value.branch}`);
	assert(value.mutations.every((item) => !item.body.force));
	const pull = value.mutations.find((item) => item.path.endsWith("/pulls"));
	assert.equal(pull.body.base, "main");
	assert.equal(pull.body.head, value.branch);
	assert.equal(pull.body.maintainer_can_modify, false);
	assert.match(pull.body.body, /brew install diffexai\/tap\/diffex/);
	assert(!JSON.stringify(value.mutations).includes("fixture-installation-token"));
});

test("existing matching branch and PR are idempotent with no mutations", async () => {
	const value = fixture({ existingBranch: true, pulls: [{ state: "open", number: 12, head: { ref: "automation/diffex-v1.2.3", repo: { full_name: "diffexai/homebrew-tap" } }, base: { ref: "main" } }] });
	assert.deepEqual(await run(value), { status: "existing", branch: value.branch, number: 12 });
	assert.equal(value.mutations.length, 0);
});

test("refuses branch collisions, unrelated file changes, divergent histories, and closed PRs", async () => {
	for (const options of [
		{ branchContent: { "Formula/diffex.rb": "unexpected" } },
		{ comparison: { status: "ahead", files: [{ filename: ".github/workflows/evil.yml", status: "added" }] } },
		{ comparison: { status: "ahead", files: [{ filename: "Formula/diffex.rb", status: "renamed", previous_filename: "secret.txt" }] } },
		{ comparison: { status: "diverged", files: [{ filename: "Formula/diffex.rb", status: "modified" }] } },
		{ pulls: [{ state: "closed" }] },
	]) {
		const value = fixture({ existingBranch: true, ...options });
		await assert.rejects(run(value));
		assert.equal(value.mutations.length, 0);
	}
});

test("merged identical versions are no-ops, older versions and same-version input changes fail closed", async () => {
	const equal = fixture({ previous: homebrewFixture().manifest });
	assert.equal((await run(equal)).status, "unchanged");
	assert.equal(equal.mutations.length, 0);
	for (const previous of [homebrewFixture("1.2.4").manifest, { ...homebrewFixture().manifest, sourceCommit: "c".repeat(40) }]) {
		const value = fixture({ previous });
		await assert.rejects(run(value));
		assert.equal(value.mutations.length, 0);
	}
});

test("credentialed GitHub requests fail closed on redirects and withhold server error text", async () => {
	const value = fixture();
	await assert.rejects(updateHomebrewTap(value.manifest, {
		token: "fixture-installation-token",
		publicRequest: value.publicRequest,
		request: async (_, init) => {
			assert.equal(init.redirect, "error");
			return new Response("secret server diagnostics", { status: 403 });
		},
	}), (error) => !error.message.includes("secret server diagnostics") && /403/.test(error.message));
});
