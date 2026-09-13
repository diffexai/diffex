import assert from "node:assert/strict";
import test from "node:test";
import { assertTrustedPublisher, verifyPublicationTrust } from "./npm-publication-trust.mjs";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const expected = {
	type: "github",
	repository: "diffexai/diffex",
	file: "build-binaries.yml",
	environment: "npm-publish",
	permissions: ["createPackage", "createStagedPackage"],
};

test("verifies every public package including the exceptional CLI name", () => {
	const visited = [];
	const results = verifyPublicationTrust(getPublicWorkspacePackages(), (name) => {
		visited.push(name);
		return expected;
	});
	assert.equal(results.length, 1);
	assert.ok(visited.includes("@diffexai/diffex"));
	assert.ok(!visited.includes("@diffexai/diffex-coding-agent-server"));
	assert.ok(!visited.includes("@diffexai/diffex-coding-agent"));
});

for (const invalid of [
	null,
	[],
	{},
	{ ...expected, type: "gitlab" },
	{ ...expected, repository: "other/diffex" },
	{ ...expected, file: "other.yml" },
	{ ...expected, environment: "" },
	{ ...expected, permissions: [] },
	{ ...expected, permissions: ["createPackage", "createStagedPackage", "deletePackage"] },
	{ ...expected, permissions: ["createStagedPackage"] },
]) {
	test("rejects missing, broader, or foreign publication trust", () => {
		assert.throws(() => assertTrustedPublisher(invalid), /Expected exactly/);
	});
}
