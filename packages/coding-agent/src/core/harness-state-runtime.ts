import { HarnessStateStore, type HarnessVersionBundle } from "@earendil-works/diffex-harness-state";

export interface LoadedHarnessState {
	store: HarnessStateStore;
	bundle: HarnessVersionBundle | undefined;
	warning: string | undefined;
}

/**
 * Initialize the global harness store and load its selected revision.
 * Invalid selected state is deliberately left untouched so `/version` can repair it.
 */
export async function loadGlobalHarnessState(agentDir: string): Promise<LoadedHarnessState> {
	const store = new HarnessStateStore(agentDir);
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
