import type { AgentSessionRuntimeDiagnostic } from "../agent-session-services.ts";
import type { SessionManager } from "../session-manager.ts";

const diagnosticSinks = new WeakMap<SessionManager, AgentSessionRuntimeDiagnostic[]>();

export function registerSubagentRuntimeDiagnosticSink(
	sessionManager: SessionManager,
	diagnostics: AgentSessionRuntimeDiagnostic[],
): void {
	diagnosticSinks.set(sessionManager, diagnostics);
}

export function reportSubagentRuntimeWarning(sessionManager: SessionManager, message: string): void {
	diagnosticSinks.get(sessionManager)?.push({ type: "warning", message });
}
