import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { homebrewFixture } from "./fixtures/homebrew.mjs";
import { assertHomebrewPublicationPolicy, HOMEBREW_TARGETS } from "./homebrew-policy.mjs";
import { assertEnabledChannels, readReleaseArtifacts } from "./release-artifacts.mjs";
import { readRetainedFile, releaseFilePath, resolveReleaseDirectory, writeRetainedFile } from "./homebrew-release-paths.mjs";
import {
	collectHomebrewRelease, downloadHomebrewAsset, homebrewReleaseUrl, publishHomebrewRelease,
	promoteHomebrewLatest, readHomebrewRelease, runHomebrewReleaseCommand, signHomebrewRelease, trustedHomebrewKeys, verifyPublicHomebrewRelease,
} from "./homebrew-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const configuration = { schemaVersion: 1, keys: [{
	publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
	sha256: hash(pair.publicKey.export({ type: "spki", format: "der" })),
}] };
const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const policy = {
	status: "approved", sourceRepository: "diffexai/diffex", publicRegistry: "https://registry.npmjs.org", publicHosting: "npmjs",
	channels: { npmjs: "enable", homebrew: "enable", standalone: "defer" },
	homebrewApproval: {
		status: "approved", reviewedAt: "2026-10-23", publicRepository: "diffexai/diffex", tapRepository: "diffexai/homebrew-tap",
		redistribution: "approved", nativeAcceptance: HOMEBREW_TARGETS, quarantine: "accepted", daytona: "accepted",
	},
};

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "diffex-homebrew-release-"));
	const { manifest, assets } = homebrewFixture();
	const input = join(root, "input");
	const directory = join(root, "public");
	const records = new Map();
	for (const entry of manifest.platforms) {
		const target = join(input, entry.platform);
		mkdirSync(target, { recursive: true });
		const record = { ...entry, version: manifest.version, sourceCommit: manifest.sourceCommit, nodeVersion: manifest.nodeVersion, npmVersion: manifest.npmVersion };
		records.set(entry.filename, record);
		writeFileSync(join(target, entry.filename), assets.get(entry.platform));
		writeFileSync(join(target, entry.filename.replace(".tar.gz", ".json")), JSON.stringify(record));
	}
	// Mocked inspector only: real archive safety is covered by homebrew-archive tests.
	const release = { version: manifest.version, source: { commit: manifest.sourceCommit } };
	collectHomebrewRelease(input, directory, release, (file) => records.get(basename(file)));
	signHomebrewRelease(directory, privateKey, configuration);
	const request = async (url) => {
		assert(url.startsWith(`https://github.com/diffexai/diffex/releases/download/v${manifest.version}/`));
		return new Response(readFileSync(join(directory, basename(new URL(url).pathname))));
	};
	return { root, input, directory, manifest, records, release, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("Homebrew remains gated on owner review; unrelated channels cannot be enabled", () => {
	assert.doesNotThrow(() => assertEnabledChannels(policy));
	for (const mutate of [
		(p) => { p.homebrewApproval.redistribution = "pending"; },
		(p) => { p.homebrewApproval.nativeAcceptance = ["linux-x64"]; },
		(p) => { p.homebrewApproval.quarantine = "pending"; },
		(p) => { p.homebrewApproval.daytona = "pending"; },
		(p) => { p.homebrewApproval.publicRepository = "elsewhere/release"; },
		(p) => { p.channels.standalone = "enable"; },
	]) {
		const changed = structuredClone(policy); mutate(changed);
		assert.throws(() => assertEnabledChannels(changed));
		assert.throws(() => assertHomebrewPublicationPolicy(changed));
	}
});

test("collect binds all platform bytes, source identities and inspection before signing", () => {
	const f = fixture();
	try {
		assert.deepEqual(readHomebrewRelease(f.directory, { configuration }), f.manifest);
		assert.throws(() => collectHomebrewRelease(f.input, f.directory, f.release,
			(file) => f.records.get(basename(file))), /already exists/);
		assert.throws(() => collectHomebrewRelease(f.input, join(f.root, "bad"), f.release,
			() => ({ version: "8.0.0" })), /differs/);
		assert.throws(() => readHomebrewRelease(f.directory, { configuration, version: "9.0.0" }), /mismatch/);
		assert.throws(() => signHomebrewRelease(f.directory, privateKey, { schemaVersion: 1, keys: [] }), /No reviewed/);
		writeFileSync(join(f.directory, f.manifest.platforms[0].filename), "tampered");
		assert.throws(() => readHomebrewRelease(f.directory, { configuration }), /identity mismatch/);
	} finally { f.cleanup(); }
});

test("retained public files cannot be links, oversized metadata or extra unreviewed files", () => {
	const f = fixture();
	try {
		const archive = join(f.directory, f.manifest.platforms[0].filename);
		const outside = join(f.root, "outside");
		writeFileSync(outside, readFileSync(archive));
		rmSync(archive); symlinkSync(outside, archive);
		assert.throws(() => readHomebrewRelease(f.directory, { configuration }), /ELOOP|symbolic link|regular retained/);
		rmSync(archive); writeFileSync(archive, readFileSync(outside));
		writeFileSync(join(f.directory, "auth.json"), "must not upload");
		assert.throws(() => readHomebrewRelease(f.directory, { configuration }), /Unexpected files/);
		rmSync(join(f.directory, "auth.json"));
		writeFileSync(join(f.directory, "homebrew-manifest.json"), Buffer.alloc(64 * 1024 + 1));
		assert.throws(() => readHomebrewRelease(f.directory, { configuration }), /regular retained/);
	} finally { f.cleanup(); }
});

test("trusted directory and file validation rejects outside roots, unsafe names and symlink parents", () => {
	const f = fixture();
	try {
		for (const directory of ["/etc/diffex-release", "/", "", undefined, "bad\0directory"])
			assert.throws(() => resolveReleaseDirectory(directory));
		for (const name of ["../auth.json", "auth/name", "auth\\name", ".", "..", "bad\0name"])
			assert.throws(() => releaseFilePath(f.directory, name));
		const linked = join(f.root, "linked");
		symlinkSync(f.directory, linked);
		assert.throws(() => readHomebrewRelease(linked, { configuration }), /symlink/);
		assert.throws(() => collectHomebrewRelease(f.input, join(linked, "new"), f.release), /symlink/);
		assert.throws(() => readReleaseArtifacts(linked), /symlink/);
		const npm = join(f.root, "npm"); mkdirSync(npm);
		symlinkSync(join(f.directory, "homebrew-manifest.json"), join(npm, "manifest.json"));
		assert.throws(() => readReleaseArtifacts(npm), /ELOOP|symbolic link/);
		assert.throws(() => writeRetainedFile(f.directory, "SHA256SUMS", "replacement"), { code: "EEXIST" });
		assert.throws(() => readRetainedFile(f.directory, "homebrew-manifest.json", 1), /regular retained/);
	} finally { f.cleanup(); }
});

test("collection inspects and copies private snapshots rather than reopening mutable input archives", () => {
	const f = fixture();
	try {
		const output = join(f.root, "snapshot");
		collectHomebrewRelease(f.input, output, f.release, (file) => {
			const record = f.records.get(basename(file));
			writeFileSync(join(f.input, record.platform, record.filename), "changed after inspection snapshot");
			return record;
		});
		assert.deepEqual(readHomebrewRelease(output, { signature: false }), f.manifest);
		assert.throws(() => collectHomebrewRelease(f.input, join(f.root, "invalid"),
			{ version: "../../outside", source: f.release.source }), /release identity/);
	} finally { f.cleanup(); }
});

test("signature creation is exclusive, idempotent, and does not follow an existing signature link", () => {
	const f = fixture();
	try {
		assert.deepEqual(signHomebrewRelease(f.directory, privateKey, configuration), f.manifest);
		const signature = join(f.directory, "SHA256SUMS.sig");
		const outside = join(f.root, "outside-signature");
		const bytes = readFileSync(signature); writeFileSync(outside, bytes);
		rmSync(signature); symlinkSync(outside, signature);
		assert.throws(() => signHomebrewRelease(f.directory, privateKey, configuration), /ELOOP|symbolic link/);
		assert.deepEqual(readFileSync(outside), bytes);
	} finally { f.cleanup(); }
});

test("fixed CLI actions reject inherited names and retain the sign publication policy gate", async () => {
	for (const command of ["constructor", "__proto__", "toString", "unknown"])
		await assert.rejects(runHomebrewReleaseCommand(command, "/etc/unused"), /Unknown/);
	const f = fixture();
	try {
		await assert.rejects(runHomebrewReleaseCommand("sign", f.directory), /publication requires/);
	} finally { f.cleanup(); }
});

test("release CLIs reject untrusted argv directories before artifact reads or remote actions", () => {
	for (const [script, args, expected] of [
		["homebrew-release.mjs", ["verify", "/etc/diffex-release"], /inside the workspace/],
		["homebrew-release.mjs", ["constructor", "/etc/diffex-release"], /Unknown/],
		["release-artifacts.mjs", ["verify", "/etc/diffex-release"], /inside the workspace/],
		["release-artifacts.mjs", ["constructor", "/etc/diffex-release"], /Usage/],
	]) {
		const result = spawnSync(process.execPath, [fileURLToPath(new URL(`./${script}`, import.meta.url)), ...args],
			{ encoding: "utf8", timeout: 10_000 });
		assert.ifError(result.error);
		assert.equal(result.status, 1);
		assert.match(result.stderr, expected);
	}
});

test("signature validation requires pinned RSA3072 identity and rejects tampering", () => {
	assert.throws(() => trustedHomebrewKeys({ schemaVersion: 1, keys: [] }), /No reviewed/);
	assert.throws(() => trustedHomebrewKeys({ ...configuration, keys: [{ ...configuration.keys[0], sha256: "a".repeat(64) }] }), /fingerprint/);
	const f = fixture();
	try {
		writeFileSync(join(f.directory, "SHA256SUMS.sig"), Buffer.alloc(384));
		assert.throws(() => readHomebrewRelease(f.directory, { configuration }), /signature/);
	} finally { f.cleanup(); }
});

test("public byte verification checks all seven retained assets anonymously", async () => {
	const f = fixture();
	try {
		let calls = 0;
		await verifyPublicHomebrewRelease(f.directory, { configuration, request: async (...args) => { calls++; return f.request(...args); } });
		assert.equal(calls, 7);
		await assert.rejects(verifyPublicHomebrewRelease(f.directory, { configuration,
			request: async () => new Response("wrong") }), /size|truncated|exceeds|conflicts/);
	} finally { f.cleanup(); }
});

test("bounded downloader permits only GitHub asset CDN redirects and exact sizes", async () => {
	const url = homebrewReleaseUrl("1.2.3", "homebrew-manifest.json");
	let calls = 0;
	assert.equal((await downloadHomebrewAsset(url, 2, async () => ++calls === 1
		? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/asset?signature=not-logged" } })
		: new Response("ok"))).toString(), "ok");
	for (const location of ["http://github.com/x", "https://evil.test/a", "https://user:pass@release-assets.githubusercontent.com/a", "https://github.com/unrelated/a", "https://release-assets.githubusercontent.com:444/a"]) {
		await assert.rejects(downloadHomebrewAsset(url, 2, async () => new Response(null, { status: 302, headers: { location } })), /origin/);
	}
	for (const initial of ["https://evil.test/a", "https://github.com/diffexai/diffex/releases/download/v1.2.3/auth.json",
		`${url}?query=unexpected`, "https://github.com/diffexai/diffex/releases/download/v1.2.3/%2e%2e%2fauth.json"]) {
		let requested = false;
		await assert.rejects(downloadHomebrewAsset(initial, 2, async () => { requested = true; return new Response("ok"); }));
		assert.equal(requested, false);
	}
	for (const response of [new Response("x"), new Response("xxx"), new Response("ok", { headers: { "content-length": "3" } }), new Response(null, { status: 404 })])
		await assert.rejects(downloadHomebrewAsset(url, 2, async () => response), /size|truncated|exceeds|unavailable/);
	assert.throws(() => homebrewReleaseUrl("1.2.3", "../../auth.json"));
	assert.throws(() => homebrewReleaseUrl("v1.2.3", "SHA256SUMS"));
});

test("publisher never clobbers conflicting public assets or uploads before existing-byte verification", async () => {
	const f = fixture();
	try {
		const mutations = [];
		const release = { tag_name: "v1.2.3", draft: false, prerelease: false, assets: [
			{ name: f.manifest.platforms[0].filename, size: f.manifest.platforms[0].size },
		] };
		const runGh = (args) => {
			if (args[1]?.includes("/commits/")) return JSON.stringify({ sha: f.manifest.sourceCommit });
			if (args[0] === "api") return JSON.stringify([release]);
			mutations.push(args); return "";
		};
		await assert.rejects(publishHomebrewRelease(f.directory, { configuration, policy, runGh,
			request: async () => new Response(Buffer.alloc(release.assets[0].size)) }), /conflicts/);
		assert.deepEqual(mutations, []);
		await assert.rejects(publishHomebrewRelease(f.directory, { configuration, policy, request: f.request,
			runGh: () => JSON.stringify({ sha: "b".repeat(40) }) }), /immutable approved source/);
		assert.deepEqual(mutations, []);
		await publishHomebrewRelease(f.directory, { configuration, policy, runGh, request: f.request });
		assert.equal(mutations.length, 6);
		assert(mutations.every((args) => args[1] === "upload" && !args.includes("--clobber")));
	} finally { f.cleanup(); }
});

test("new GitHub publication starts nonlatest and retries matching retained bytes without another upload", async () => {
	const f = fixture();
	try {
		let release;
		const mutations = [];
		const runGh = (args) => {
			if (args[0] === "api") {
				if (args[1].includes("/commits/")) return JSON.stringify({ sha: f.manifest.sourceCommit });
				if (args[1].includes("/releases/tags/")) return JSON.stringify(release);
				return JSON.stringify(release ? [release] : []);
			}
			mutations.push(args);
			if (args[1] === "create") release = { tag_name: "v1.2.3", draft: false, prerelease: false, assets: [] };
			else if (args[1] === "upload") release.assets.push({ name: basename(args[3]), size: readFileSync(args[3]).length });
			else assert.fail("Unexpected GitHub mutation");
			return "";
		};
		const options = { configuration, policy, runGh, request: f.request };
		await publishHomebrewRelease(f.directory, options);
		assert(mutations[0].includes("--latest=false"));
		assert.equal(mutations.length, 8);
		await publishHomebrewRelease(f.directory, options);
		assert.equal(mutations.length, 8, "Complete recovery must only verify existing bytes");
		assert(!mutations.some((args) => args.includes("--clobber")));
	} finally { f.cleanup(); }
});

test("GitHub latest promotion verifies public bytes and cannot displace a newer release", async () => {
	const f = fixture();
	try {
		const calls = [];
		const runGh = (args) => { calls.push(args); return args[0] === "api" ? JSON.stringify([{ tag_name: "v1.2.4", draft: false, prerelease: false }]) : ""; };
		assert.equal(await promoteHomebrewLatest(f.directory, { configuration, runGh, request: f.request }), false);
		assert.equal(calls.length, 1);
	} finally { f.cleanup(); }
});
