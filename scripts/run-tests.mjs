import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const codingAgent = "@diffexai/diffex";

export function testCommands(group = "all", args = []) {
	if (group === "coding-agent") return [["test", `--workspace=${codingAgent}`, "--", ...args]];
	if (group === "all" && args.length === 0) return [["test"]];
	if (group !== "other") throw new Error(`Unknown test group: ${group}. Use all, coding-agent, or other.`);
	const shard = args.length === 1 ? /^--shard=([1-9]\d*)\/([1-9]\d*)$/.exec(args[0]) : undefined;
	if (args.length > 0 && !shard) throw new Error("The other group only accepts --shard=N/T.");
	const shardIndex = shard ? Number(shard[1]) : 1;
	const shardCount = shard ? Number(shard[2]) : 1;
	if (!Number.isSafeInteger(shardCount) || shardIndex > shardCount) throw new Error("Invalid workspace shard.");

	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const workspaces = globSync(manifest.workspaces.map((pattern) => `${pattern}/package.json`), { cwd: root })
		.map((path) => JSON.parse(readFileSync(resolve(root, path), "utf8")))
		.filter((workspace) => workspace.scripts?.test && workspace.name !== codingAgent)
		.map((workspace) => `--workspace=${workspace.name}`)
		.sort();
	const selected = workspaces.filter((_, index) => index % shardCount === shardIndex - 1);
	if (selected.length === 0) throw new Error("No test workspaces found in this shard.");
	return [...(shardIndex === 1 ? [["run", "test:scripts"]] : []), ["test", ...selected]];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [group, ...args] = process.argv.slice(2);
	for (const command of testCommands(group, args)) {
		const result = spawnSync("npm", command, {
			cwd: root,
			stdio: "inherit",
			shell: process.platform === "win32",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
}
