import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertBootstrapPackageStates,
	BOOTSTRAP_DIST_TAG,
	createPublishArgs,
	createTrustedPublisherCommands,
	parsePublishArgs,
} from "./npm-publish-plan.mjs";

describe("npm publish planning", () => {
	it("parses normal, dry-run, and bootstrap modes", () => {
		assert.deepEqual(parsePublishArgs([]), { bootstrap: false, dryRun: false });
		assert.deepEqual(parsePublishArgs(["--dry-run"]), { bootstrap: false, dryRun: true });
		assert.deepEqual(parsePublishArgs(["--bootstrap", "--dry-run"]), { bootstrap: true, dryRun: true });
	});

	it("rejects unknown arguments", () => {
		assert.throws(() => parsePublishArgs(["--force"]), /Usage: node scripts\/publish\.mjs/);
	});

	it("uses provenance for releases and a non-default tag for bootstrap publication", () => {
		assert.deepEqual(createPublishArgs({ bootstrap: false }), [
			"publish",
			"--access",
			"public",
			"--provenance",
			"--ignore-scripts",
		]);
		assert.deepEqual(createPublishArgs({ bootstrap: true }), [
			"publish",
			"--access",
			"public",
			"--tag",
			BOOTSTRAP_DIST_TAG,
			"--ignore-scripts",
		]);
	});

	it("allows new and already-completed bootstrap packages", () => {
		assert.doesNotThrow(() =>
			assertBootstrapPackageStates([
				{ name: "@scope/new", version: "0.2.0", registered: false, published: false },
				{ name: "@scope/done", version: "0.2.0", registered: true, published: true },
			]),
		);
	});

	it("rejects bootstrap publication over an established package", () => {
		assert.throws(
			() =>
				assertBootstrapPackageStates([
					{ name: "@scope/existing", version: "0.2.0", registered: true, published: false },
				]),
			/@scope\/existing@0\.2\.0/,
		);
	});

	it("builds the trusted-publisher command for the release workflow", () => {
		assert.deepEqual(createTrustedPublisherCommands(["@scope/package"]), [
			"npm trust github @scope/package --file build-binaries.yml --repo diffexai/diffex --env npm-publish --allow-publish --yes",
		]);
	});
});

it("requires exactly one artifact directory and rejects ambiguous options", () => {
	assert.deepEqual(parsePublishArgs(["--artifacts", "/tmp/approved", "--dry-run"]), {
		bootstrap: false,
		dryRun: true,
		artifacts: "/tmp/approved",
	});
	for (const args of [
		["--artifacts"],
		["--artifacts", "--bootstrap"],
		["--artifacts", "a", "--artifacts", "b"],
		["--bootstrap", "--bootstrap"],
	])
		assert.throws(() => parsePublishArgs(args));
});
