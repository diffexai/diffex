import type { SessionManager } from "../session-manager.ts";

const fixedHarnessSessions = new WeakSet<SessionManager>();

export function markFixedHarnessSubagentSession(sessionManager: SessionManager): void {
	fixedHarnessSessions.add(sessionManager);
}

export function hasFixedHarnessSubagentSession(sessionManager: SessionManager): boolean {
	return fixedHarnessSessions.has(sessionManager);
}
