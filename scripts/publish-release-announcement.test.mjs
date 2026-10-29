import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createPublicationFixture } from "./fixtures/release-publication/harness.mjs";
import { advanceLatestRelease, compareReleaseVersions, verifyAnnouncementChannels } from "./publish-release-announcement.mjs";
import { HOMEBREW_TARGETS } from "./homebrew-policy.mjs";

test("announcement channel actions always validate policy and cannot bypass enabled Homebrew verification", async () => {
	const policy = {
		status: "approved", sourceRepository: "diffexai/diffex", publicRegistry: "https://registry.npmjs.org", publicHosting: "npmjs",
		channels: { npmjs: "enable", homebrew: "enable", standalone: "defer" },
		homebrewApproval: { status: "approved", reviewedAt: "2026-10-23", publicRepository: "diffexai/diffex", tapRepository: "diffexai/homebrew-tap",
			redistribution: "approved", nativeAcceptance: HOMEBREW_TARGETS, quarantine: "accepted", daytona: "accepted" },
	};
	const options = { homebrewArtifacts: "/retained/homebrew", version: "1.2.3", sourceCommit: "a".repeat(40) };
	let calls = 0;
	const verifyHomebrew = async (directory, identity) => {
		calls++;
		assert.equal(directory, options.homebrewArtifacts);
		assert.deepEqual(identity, { version: options.version, sourceCommit: options.sourceCommit });
	};
	await verifyAnnouncementChannels(policy, options, verifyHomebrew);
	assert.equal(calls, 1);
	await assert.rejects(verifyAnnouncementChannels(policy, { ...options, homebrewArtifacts: undefined }, verifyHomebrew), /require retained/);
	await assert.rejects(verifyAnnouncementChannels(policy, options, async () => { throw new Error("public byte mismatch"); }), /public byte mismatch/);
	for (const channel of ["constructor", "__proto__", "unexpected", undefined]) {
		const invalid = structuredClone(policy); invalid.channels.homebrew = channel;
		await assert.rejects(verifyAnnouncementChannels(invalid, options, verifyHomebrew), /Unapproved/);
	}
	const invalid = structuredClone(policy); invalid.homebrewApproval.redistribution = "pending";
	await assert.rejects(verifyAnnouncementChannels(invalid, options, verifyHomebrew), /publication requires/);
	const deferred = structuredClone(policy); deferred.channels.homebrew = "defer";
	await verifyAnnouncementChannels(deferred, options, verifyHomebrew);
	assert.equal(calls, 1);
});

test("compares stable release versions numerically", () => {
	assert.ok(compareReleaseVersions("0.85.0", "0.84.9") > 0);
	assert.ok(compareReleaseVersions("0.84.10", "0.84.9") > 0);
	assert.equal(compareReleaseVersions("0.84.0", "0.84.0"), 0);
	assert.throws(() => compareReleaseVersions("0.85.0-beta.1", "0.84.0"));
});

test("does not regress an existing newer release marker", async () => {
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => ({ etag: '"newer"', version: "0.85.0" }),
		async () => {
			writeCount++;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 0);
});

test("retries a lost conditional update and preserves a racing newer marker", async () => {
	let readCount = 0;
	let writeCount = 0;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => {
			readCount++;
			return readCount === 1 ? { etag: '"previous"', version: "0.83.0" } : { etag: '"newer"', version: "0.85.0" };
		},
		async (condition) => {
			writeCount++;
			assert.deepEqual(condition, { etag: '"previous"' });
			return false;
		},
	);

	assert.deepEqual(result, { advanced: false, version: "0.85.0" });
	assert.equal(writeCount, 1);
});

test("creates a missing marker with an if-none-match condition", async () => {
	let condition;
	const result = await advanceLatestRelease(
		"0.84.0",
		async () => undefined,
		async (value) => {
			condition = value;
			return true;
		},
	);

	assert.deepEqual(result, { advanced: true, version: "0.84.0" });
	assert.deepEqual(condition, { missing: true });
});

// Exercise the exact release-CI command with isolated manifests, npm, and storage.
test("publisher rejects missing credentials before package verification or storage", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", { credentials: false });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /AWS_ACCESS_KEY_ID.*AWS_SECRET_ACCESS_KEY/);
		assert.doesNotMatch(result.stdout, /available from npm/);
		assert.deepEqual(fixture.state().calls, []);
	} finally {
		fixture.cleanup();
	}
});

for (const failure of ["package", "tarball", "integrity", "bytes"]) {
	test(`publisher leaves both records untouched when ${failure} verification fails`, () => {
		const fixture = createPublicationFixture();
		try {
			const objects = { "releases/v1/latest.json": JSON.stringify({ version: "0.0.2" }) };
			fixture.seed(objects);
			const result = fixture.run("0.0.3", { failure });
			assert.equal(result.status, 1);
			assert.match(result.stderr, /Timed out waiting/);
			assert.deepEqual(fixture.state().objects, objects);
			assert.deepEqual(fixture.state().calls, []);
		} finally {
			fixture.cleanup();
		}
	});
}

test("publisher safely creates, repeats, and orders verified announcements", () => {
	const fixture = createPublicationFixture();
	try {
		let result = fixture.run("0.0.3");
		assert.equal(result.status, 0, result.stderr);
		const first = fixture.state().objects;
		assert.equal(first["releases/v1/latest.json"], first["releases/v1/releases/0.0.3.json"]);
		result = fixture.run("0.0.3");
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(fixture.state().objects, first);
		result = fixture.run("0.0.2");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(fixture.state().objects["releases/v1/latest.json"], first["releases/v1/latest.json"]);
		assert.ok(fixture.state().objects["releases/v1/releases/0.0.2.json"]);
	} finally {
		fixture.cleanup();
	}
});

test("retry after an interrupted announcement reuses the immutable record", () => {
	const fixture = createPublicationFixture();
	try {
		const first = fixture.run("0.0.3");
		assert.equal(first.status, 0, first.stderr);
		const key = "releases/v1/releases/0.0.3.json";
		const record = JSON.parse(fixture.state().objects[key]);
		record.publishedAt = "2025-01-01T00:00:00.000Z";
		const body = JSON.stringify(record);
		fixture.seed({ [key]: body });
		const retry = fixture.run("0.0.3");
		assert.equal(retry.status, 0, retry.stderr);
		assert.equal(fixture.state().objects["releases/v1/latest.json"], body);
	} finally {
		fixture.cleanup();
	}
});

test("publisher rejects conflicting immutable release identity", () => {
	const fixture = createPublicationFixture();
	try {
		const first = fixture.run("0.0.3");
		assert.equal(first.status, 0, first.stderr);
		const objects = fixture.state().objects;
		const retry = fixture.run("0.0.3", { commit: "b".repeat(40) });
		assert.equal(retry.status, 1);
		assert.match(retry.stderr, /conflict/i);
		assert.deepEqual(fixture.state().objects, objects);
	} finally {
		fixture.cleanup();
	}
});

test("publisher redacts storage failures and never treats denied access as a missing record", () => {
	const fixture = createPublicationFixture();
	try {
		fixture.seed({}, "AccessDenied");
		const result = fixture.run("0.0.3");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /R2 rejected publication credentials/);
		assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret/);
		assert.deepEqual(fixture.state().objects, {});
	} finally {
		fixture.cleanup();
	}
});

test("publisher fails closed when the existing latest record is malformed", () => {
	const fixture = createPublicationFixture();
	try {
		fixture.seed({ "releases/v1/latest.json": "malformed fixture-secret" });
		const result = fixture.run("0.0.3");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /not valid JSON/);
		assert.doesNotMatch(result.stderr + result.stdout, /fixture-secret/);
		assert.equal(fixture.state().objects["releases/v1/latest.json"], "malformed fixture-secret");
	} finally {
		fixture.cleanup();
	}
});

test("pointer contention has a bounded retry limit", async () => {
	let attempts = 0;
	await assert.rejects(
		advanceLatestRelease(
			"0.0.3",
			async () => undefined,
			async () => {
				attempts++;
				return false;
			},
		),
		/after 5 attempts/,
	);
	assert.equal(attempts, 5);
});

test("version comparison rejects noncanonical versions and avoids numeric precision loss", () => {
	for (const value of ["01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3+build", "1.2.3-beta.1"]) {
		assert.throws(() => compareReleaseVersions(value, "1.2.3"));
	}
	assert.equal(compareReleaseVersions("9007199254740993.0.0", "9007199254740992.0.0"), 1);
});

test("publisher rejects a noncanonical source commit before storing records", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", { commit: "not-a-commit" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Artifact source|Invalid release record/);
		assert.deepEqual(fixture.state().objects, {});
	} finally {
		fixture.cleanup();
	}
});

test("version record survives an actual pointer-write failure and recovery preserves its bytes", () => {
	const fixture = createPublicationFixture();
	try {
		fixture.seed({}, "PointerFailure");
		const failed = fixture.run("0.0.3");
		assert.equal(failed.status, 1);
		const versionKey = "releases/v1/releases/0.0.3.json";
		const record = fixture.state().objects[versionKey];
		assert.ok(record);
		assert.equal(fixture.state().objects["releases/v1/latest.json"], undefined);
		fixture.seed({ [versionKey]: record });
		const retry = fixture.run("0.0.3");
		assert.equal(retry.status, 0, retry.stderr);
		assert.equal(fixture.state().objects["releases/v1/latest.json"], record);
	} finally {
		fixture.cleanup();
	}
});

test("retained manifest packages return only workspace identities and measured artifact fields", () => {
	const fixture = createPublicationFixture();
	try {
		fixture.run("0.0.3", { credentials: false, mutateManifest: (manifest) => {
			manifest.packages.reverse();
			for (const pkg of manifest.packages) {
				pkg.published = true;
				pkg.registered = true;
				pkg.unreviewed = "must not propagate";
			}
		} });
		const script = `import { readReleaseArtifacts } from ${JSON.stringify(new URL("./release-artifacts.mjs", import.meta.url).href)}; console.log(JSON.stringify(readReleaseArtifacts("artifacts")));`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: fixture.directory,
			env: { PATH: `${join(fixture.directory, "bin")}:${process.env.PATH}`, DIFFEX_PUBLICATION_FIXTURE: join(fixture.directory, "registry.json") },
			encoding: "utf8", timeout: 10_000,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(result.stdout);
		assert.equal(manifest.packages[0].name, "@diffexai/diffex-agent-core", "Return authoritative workspace order, not retained JSON order");
		assert.equal(manifest.packages.length, fixture.packageCount);
		for (const pkg of manifest.packages) {
			assert.deepEqual(Object.keys(pkg).sort(), ["filename", "integrity", "name", "sha256", "size", "version"]);
			assert.equal(pkg.version, "0.0.3");
			assert.equal(pkg.filename, `${pkg.name.replace("@", "").replace("/", "-")}-0.0.3.tgz`);
		}
		assert.deepEqual(fixture.state().calls, []);
		assert.equal(fixture.state().registryCalls, undefined);
	} finally { fixture.cleanup(); }
});

test("untrusted package publication flags cannot skip registry checks or missing-version uploads", () => {
	for (const bootstrap of [false, true]) {
		const fixture = createPublicationFixture();
		try {
			const result = fixture.run("0.0.3", { command: "publish", bootstrap, missing: true,
				mutateManifest: (manifest) => {
					for (const pkg of manifest.packages) { pkg.published = true; pkg.registered = true; }
				} });
			assert.equal(result.status, 0, result.stderr);
			assert.equal(fixture.state().published.length, fixture.packageCount);
			assert.deepEqual(fixture.state().objects, {});
		} finally { fixture.cleanup(); }
	}
});

test("partial npm publication resumes original bytes and never republishes completed versions", () => {
	const fixture = createPublicationFixture();
	try {
		const failed = fixture.run("0.0.3", { command: "publish", missing: true, failPublishAt: "@diffexai/diffex" });
		assert.equal(failed.status, 1, failed.stdout);
		const published = fixture.state().published;
		assert.ok(published.length > 0 && published.length < fixture.packageCount);
		assert.deepEqual(fixture.state().objects, {});
		const retry = fixture.run("0.0.3", { command: "publish", missing: true });
		assert.equal(retry.status, 0, retry.stderr);
		assert.equal(fixture.state().published.length, fixture.packageCount);
		assert.equal(fixture.run("0.0.3", { command: "publish", missing: true }).status, 0);
		assert.equal(fixture.state().published.length, fixture.packageCount);
		assert.equal(fixture.run("0.0.3", { missing: true }).status, 0);
		assert.ok(fixture.state().objects["releases/v1/latest.json"]);
	} finally {
		fixture.cleanup();
	}
});

for (const failure of ["bytes", "integrity", "tarball"])
	test(`existing npm ${failure} failure blocks every publish and announcement`, () => {
		const fixture = createPublicationFixture();
		try {
			const result = fixture.run("0.0.3", { command: "publish", failure });
			assert.equal(result.status, 1);
			assert.equal(fixture.state().published, undefined);
			assert.deepEqual(fixture.state().objects, {});
		} finally {
			fixture.cleanup();
		}
	});

for (const mutateManifest of [
	(manifest) => {
		manifest.source.commit = "b".repeat(40);
	},
	(manifest) => {
		manifest.source.lockSha256 = "b".repeat(64);
	},
	(manifest) => {
		manifest.packages[0].sha256 = "b".repeat(64);
	},
	(manifest) => {
		manifest.packages[0].name = "@elsewhere/unapproved";
	},
	(manifest) => {
		manifest.packages[0].version = "0.0.3/../../auth.json";
	},
	(manifest) => {
		manifest.packages[0].filename = "../auth.json";
	},
	(manifest) => {
		manifest.snapshot.sha256 = "b".repeat(64);
	},
	(manifest) => {
		manifest.packages.pop();
	},
	(manifest) => {
		manifest.version = "0.0.4";
	},
])
	test("artifact source, inventory, and byte tampering fail before network or storage", () => {
		const fixture = createPublicationFixture();
		try {
			const result = fixture.run("0.0.3", { mutateManifest });
			assert.equal(result.status, 1);
			assert.equal(fixture.state().registryCalls, undefined);
			assert.deepEqual(fixture.state().calls, []);
		} finally {
			fixture.cleanup();
		}
	});

test("enabling public binary assets without an availability gate fails before promotion", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", {
			mutatePolicy: (policy) => {
				policy.channels.standalone = "enable";
				return policy;
			},
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /public asset verification/);
		assert.equal(fixture.state().registryCalls, undefined);
		assert.deepEqual(fixture.state().objects, {});
	} finally {
		fixture.cleanup();
	}
});

test("an enabled Homebrew channel cannot announce without retained public archive verification", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", {
			mutatePolicy: (policy) => {
				policy.channels.homebrew = "enable";
				policy.homebrewApproval = { status: "approved", reviewedAt: "2026-10-23", redistribution: "approved",
					nativeAcceptance: ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"], quarantine: "accepted", daytona: "accepted",
					publicRepository: "diffexai/diffex", tapRepository: "diffexai/homebrew-tap" };
				return policy;
			},
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /require retained archive verification/);
		assert.equal(fixture.state().registryCalls, undefined);
		assert.deepEqual(fixture.state().objects, {});
	} finally { fixture.cleanup(); }
});

test("bootstrap dry run writes nothing and completion verifies all packages without latest or R2", () => {
	const fixture = createPublicationFixture();
	try {
		const options = { command: "publish", missing: true, bootstrap: true };
		const dry = fixture.run("0.0.3", { ...options, dryRun: true });
		assert.equal(dry.status, 0, dry.stderr);
		assert.equal(fixture.state().published, undefined);
		const partial = fixture.run("0.0.3", { ...options, failPublishAt: "@diffexai/diffex" });
		assert.equal(partial.status, 1);
		assert.ok(fixture.state().published.length > 0);
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = fixture.run("0.0.3", options);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(fixture.state().published.length, fixture.packageCount);
			assert.equal(fixture.state().bootstrap.length, fixture.packageCount);
			assert.deepEqual(fixture.state().automaticLatest, {});
			assert.equal(fixture.state().removedLatest.length, fixture.packageCount);
			assert.deepEqual(fixture.state().objects, {});
			assert.deepEqual(fixture.state().calls, []);
		}
	} finally {
		fixture.cleanup();
	}
});

test("bootstrap rejects established latest tags before publishing", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", { command: "publish", bootstrap: true, latest: "0.0.3" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /bootstrap requires no latest/);
		assert.equal(fixture.state().published, undefined);
		assert.deepEqual(fixture.state().objects, {});
	} finally {
		fixture.cleanup();
	}
});

test("bootstrap cannot claim completion when registry tags disagree", () => {
	const fixture = createPublicationFixture();
	try {
		const result = fixture.run("0.0.3", { command: "publish", bootstrap: true, missing: true, wrongBootstrap: true });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /bootstrap tag verification failed/);
		assert.doesNotMatch(result.stdout, /Bootstrap publication is complete/);
		assert.deepEqual(fixture.state().objects, {});
	} finally {
		fixture.cleanup();
	}
});

for (const options of [{ newLatest: "0.0.4" }, { failTagRemoval: true }]) {
	test("bootstrap stops after the first upload when automatic tag cleanup is unsafe or fails", () => {
		const fixture = createPublicationFixture();
		try {
			const result = fixture.run("0.0.3", { command: "publish", bootstrap: true, missing: true, ...options });
			assert.equal(result.status, 1);
			assert.equal(fixture.state().published.length, 1);
			assert.equal(fixture.state().removedLatest, undefined);
			assert.deepEqual(fixture.state().objects, {});
			assert.deepEqual(fixture.state().calls, []);
			assert.doesNotMatch(result.stdout, /Bootstrap publication is complete/);
		} finally {
			fixture.cleanup();
		}
	});
}
