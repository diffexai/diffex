import assert from "node:assert/strict";
import test from "node:test";
import { verifyReleaseCredentialScope } from "./verify-release-credentials.mjs";

for (const target of ["production", "staging"]) {
	test(`${target} credentials require own-bucket access and explicit denial elsewhere`, () => {
		const bucket = target === "production" ? "diffex-artifacts" : "diffex-artifacts-staging";
		const calls = [];
		const results = verifyReleaseCredentialScope(target, (args) => {
			calls.push(args);
			return args[3] === bucket ? { status: 0 } : { status: 1, stderr: "An error occurred (AccessDenied)" };
		});
		assert.equal(results.filter(({ access }) => access === "allowed").length, 1);
		assert.ok(calls.every((args) => args[1] === "list-objects-v2"));
		assert.throws(() => verifyReleaseCredentialScope(target, () => ({ status: 0 })), /unexpected bucket scope/);
		for (const stderr of ["An error occurred (NoSuchBucket)", "timeout", "An error occurred (InvalidAccessKeyId)"]) {
			assert.throws(
				() =>
					verifyReleaseCredentialScope(target, (args) => (args[3] === bucket ? { status: 0 } : { status: 1, stderr })),
				/unexpected bucket scope/,
			);
		}
	});
}

test("rejects unknown scope before invoking storage", () => {
	assert.throws(() => verifyReleaseCredentialScope("other", () => assert.fail("unexpected storage")));
});
