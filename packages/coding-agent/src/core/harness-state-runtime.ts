import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	HarnessStateStore,
	type HarnessVersionBundle,
	type HarnessWorkspaceIdentity,
	harnessWorkspaceSelectionFileName,
} from "@diffexai/diffex-harness-state";

export interface ResolvedHarnessWorkspace {
	readonly workspace: HarnessWorkspaceIdentity;
	readonly rootPath: string;
}

export async function resolveHarnessWorkspace(cwd: string): Promise<ResolvedHarnessWorkspace> {
	const rootPath = await realpath(cwd).catch(() => resolve(cwd));
	const directory = await stat(rootPath, { bigint: true });
	const identity =
		directory.ino === 0n
			? JSON.stringify({ kind: "canonical-path-v1", rootPath })
			: JSON.stringify({
					device: directory.dev.toString(),
					inode: directory.ino.toString(),
					kind: "filesystem-directory-v1",
				});
	const directoryId = `sha256:${createHash("sha256").update(identity).digest("hex")}`;
	return { workspace: { repositoryId: "global", directoryId }, rootPath };
}

export function resolveEvolutionWorkspaceStateDirectory(agentDir: string, workspace: HarnessWorkspaceIdentity): string {
	return join(
		resolve(agentDir),
		"evolution-workspaces",
		harnessWorkspaceSelectionFileName(workspace).slice(0, -".json".length),
	);
}

export interface LoadedHarnessState {
	store: HarnessStateStore;
	bundle: HarnessVersionBundle | undefined;
	warning: string | undefined;
}

/**
 * Initialize the shared harness revision store and load this workspace's selected revision.
 * Invalid selected state is deliberately left untouched so `/version` can repair it.
 */
export async function loadWorkspaceHarnessState(
	agentDir: string,
	workspace: HarnessWorkspaceIdentity,
): Promise<LoadedHarnessState> {
	const store = new HarnessStateStore(agentDir, { workspace });
	try {
		await store.initialize();
		return { store, bundle: await store.loadCurrent(), warning: undefined };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			store,
			bundle: undefined,
			warning: `Harness state could not be activated: ${message}. Continuing with the built-in harness.`,
		};
	}
}
