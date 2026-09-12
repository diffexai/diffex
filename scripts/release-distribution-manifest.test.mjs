import assert from "node:assert/strict";
import { test } from "node:test";
import { createDistributionManifest } from "./release-distribution-manifest.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const candidate = () => ({
	packages: getPublicWorkspacePackages(),
	sourceCommit: "a".repeat(40),
	policy: { status: "pending-owner-review" },
});

test("derives all public packages and excludes source from upload assets", () => {
	const manifest = createDistributionManifest(candidate());
	assert.equal(manifest.packages.length, 11);
	assert(manifest.packages.some((pkg) => pkg.name === "@diffexai/diffex-coding-agent-server"));
	assert.equal(manifest.publicAssets.filter((name) => name.endsWith(".tar.gz") || name.endsWith(".zip")).length, 0);
	assert(!manifest.publicAssets.some((name) => name.includes("source")));
	assert.equal(manifest.source.commit, "a".repeat(40));
	assert.equal(manifest.disclosurePolicy.status, "pending-owner-review");
});

test("rejects incomplete, private, duplicate, and mixed-version package inventories", () => {
	for (const mutate of [
		(value) => value.packages.pop(),
		(value) => {
			value.packages[0] = { ...value.packages[0], name: "@diffexai/diffex-evolution" };
		},
		(value) => {
			value.packages[0] = value.packages[1];
		},
		(value) => {
			value.packages[0] = { ...value.packages[0], version: "9.9.9" };
		},
		(value) => {
			value.sourceCommit = "main";
		},
	]) {
		const value = candidate();
		mutate(value);
		assert.throws(() => createDistributionManifest(value));
	}
});
