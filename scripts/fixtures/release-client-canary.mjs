import assert from "node:assert/strict";
import { endpoint, reproduce } from "../../packages/coding-agent/test/fixtures/version-update-client.ts";

export async function checkStagingClient(name, options, expected) {
	const result = await reproduce({ ...options, staging: true });
	assert.equal(result.code, expected.code, result.output);
	const requests = result.events.filter((event) => event.type === "request" && event.url === endpoint);
	const interceptedOtherRequests = result.events.filter((event) => event.type === "request" && event.url !== endpoint);
	for (const request of interceptedOtherRequests) {
		// Install telemetry is a separate migration; the preload returns 503 without forwarding it.
		assert.match(request.url, /^https:\/\/pi\.dev\/api\/report-install\?version=[0-9.]+$/);
	}
	const connections = result.events.filter((event) => event.type === "staging-connect");
	assert.equal(connections.length > 0, expected.requests > 0);
	for (const connection of connections) {
		assert.equal(connection.host, "diffex-public-api-staging.yibai14651.workers.dev");
		assert.equal(connection.port, 443);
	}
	assert.equal(requests.length, expected.requests);
	for (const request of requests) {
		assert.equal(request.url, endpoint);
		assert.equal(request.method, "GET");
		assert.equal(request.redirect, "manual");
		assert.match(request.userAgent, /^diffex\//);
	}
	const responses = result.events.filter((event) => event.type === "staging-response");
	assert.equal(responses.length, expected.requests);
	for (const response of responses) {
		assert.equal(response.url, "https://diffex-public-api-staging.yibai14651.workers.dev/api/latest-version");
		assert.equal(response.status, expected.status);
		assert.equal(response.cacheControl, "no-store");
		assert.match(response.contentType, /^application\/json\b/);
		assert.deepEqual(JSON.parse(response.body), expected.body);
	}
	const commands = result.events.filter((event) => event.type === "spawn");
	assert.deepEqual(
		commands,
		expected.installVersion
			? [
					{
						type: "spawn",
						command: "npm",
						args: [
							"--prefix",
							result.prefix,
							"install",
							"-g",
							"--ignore-scripts",
							"--min-release-age=0",
							`@diffexai/diffex@${expected.installVersion}`,
						],
					},
				]
			: [],
	);
	if (expected.message) assert.ok(result.output.includes(expected.message), result.output);
	if (options.interactive) {
		assert.equal(result.quitSent, true);
		assert.doesNotMatch(
			result.output,
			/New version|Could not determine latest|update service|No published Diffex release|Refusing self-update/,
		);
	}
	console.log(
		JSON.stringify({
			canary: name,
			code: result.code,
			requests,
			responses,
			interceptedOtherRequests,
			connections,
			commands: commands.map((command) => ({
				...command,
				args: command.args.map((arg) => (arg === result.prefix ? "<isolated-prefix>" : arg)),
			})),
			terminalExited: result.quitSent,
			message: expected.message ?? null,
			cleanup: "verified",
		}),
	);
}
