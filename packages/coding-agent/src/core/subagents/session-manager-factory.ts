import { SessionManager } from "../session-manager.ts";
import type { SubagentSpawnOrigin } from "./types.ts";

export interface SubagentSessionManagerRequest {
	readonly childName: string;
	readonly sourceSessionManager: SessionManager;
	readonly cwd: string;
	readonly parentSessionId: string;
	readonly origin: SubagentSpawnOrigin;
}

export interface SubagentSessionManagerFactory {
	create(request: SubagentSessionManagerRequest): SessionManager;
}

export class RootLocalEphemeralSubagentSessionManagerFactory implements SubagentSessionManagerFactory {
	create(request: SubagentSessionManagerRequest): SessionManager {
		// Future context inheritance will be opt-in and use request.origin.contextEntryId with request.sourceSessionManager.forkBranch().
		// Future persistence will replace or extend this internal manager factory, add root metadata, and implement restoration without changing controller scheduling.
		return SessionManager.inMemory(request.cwd, { parentSession: request.parentSessionId });
	}
}
