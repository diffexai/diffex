import { SessionManager } from "../session-manager.ts";
import { ParentOwnedSubagentSessionStore } from "./persistence.ts";
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
		if (request.sourceSessionManager.isPersisted()) {
			return new ParentOwnedSubagentSessionStore(request.sourceSessionManager).createChild(request.childName);
		}
		return SessionManager.inMemory(request.cwd, { parentSession: request.parentSessionId });
	}
}
