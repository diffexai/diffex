import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { testCommands } from "./run-tests.mjs";

test("CI groups include every npm test workspace exactly once", () => {
	const workspaceScripts = JSON.parse(execFileSync("npm", ["pkg", "get", "scripts.test", "--workspaces"], {
		encoding: "utf8",
		shell: process.platform === "win32",
	}));
	const expected = Object.entries(workspaceScripts)
		.filter(([, script]) => typeof script === "string")
		.map(([name]) => name)
		.sort();
	const commands = [
		...testCommands("coding-agent"),
		...testCommands("other", ["--shard=1/2"]),
		...testCommands("other", ["--shard=2/2"]),
	];
	const actual = commands.flat().filter((arg) => arg.startsWith("--workspace=")).map((arg) => arg.slice(12)).sort();
	assert.deepEqual(actual, expected);
	assert.equal(commands.filter((command) => command.includes("test:scripts")).length, 1);
});

test("default invocation keeps the complete suite and coding-agent forwards shard options", () => {
	assert.deepEqual(testCommands(), [["test"]]);
	assert.deepEqual(testCommands("coding-agent", ["--shard=2/4", "--maxWorkers=1"]), [
		["test", "--workspace=@diffexai/diffex", "--", "--shard=2/4", "--maxWorkers=1"],
	]);
	assert.throws(() => testCommands("missing"), /Unknown test group/);
	assert.throws(() => testCommands("other", ["--pool=threads"]), /only accepts --shard/);
	assert.throws(() => testCommands("other", ["--shard=0/2"]), /only accepts --shard/);
	assert.throws(() => testCommands("other", ["--shard=3/2"]), /Invalid workspace shard/);
	assert.throws(() => testCommands("other", ["--shard=999/999"]), /No test workspaces/);
});
