import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
} from "@diffexai/diffex-agent-core";
import type { SettingsManager } from "./settings-manager.ts";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.DIFFEX_TELEMETRY,
): boolean {
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}

const SKILL_OBSERVATION_ATTRIBUTES = {
	"diffex.skill.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Stable skill source identity",
	},
	"diffex.skill.version": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Immutable skill version admitted for the request",
	},
	"diffex.skill.content_digest": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Digest of the admitted skill content",
	},
	"diffex.skill.source_kind": {
		type: "string",
		required: true,
		values: ["installed", "evolved"],
		description: "Skill source kind",
	},
	"diffex.skill.source": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Catalog source that supplied the skill",
	},
	"diffex.skill.scope": {
		type: "string",
		required: true,
		values: ["global", "workspace"],
		description: "Skill installation or evolution scope",
	},
	"diffex.skill.harness_revision": {
		type: "string",
		required: false,
		cardinality: "high",
		description: "Harness revision that owns an evolved skill artifact",
	},
	"diffex.workspace.repository_id": {
		type: "string",
		required: false,
		cardinality: "high",
		description: "Active workspace repository identity",
	},
	"diffex.workspace.directory_id": {
		type: "string",
		required: false,
		cardinality: "high",
		description: "Active workspace directory identity",
	},
	"diffex.harness.version": {
		type: "string",
		required: false,
		cardinality: "high",
		description: "Harness revision pinned to the request",
	},
} as const;

export const CODING_AGENT_TELEMETRY_SCHEMA = {
	version: 4,
	spans: {
		"diffex.coding_agent.diagnostic": {
			description: "One runtime diagnostic surfaced to the process user",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.diagnostic.severity": {
					type: "string",
					required: true,
					values: ["info", "warning", "error"],
					description: "Diagnostic severity",
				},
				"diffex.diagnostic.message": {
					type: "string",
					required: true,
					cardinality: "high",
					sensitive: true,
					description: "Exact surfaced diagnostic message",
				},
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: "The diagnostic has error severity" },
		},
		"diffex.coding_agent.operation": {
			description: "One user-visible coding-agent session operation",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Operation-local stable id",
				},
				"diffex.task.lineage.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Stable lineage id shared by evidence from one prompt task",
				},
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Owning session id",
				},
				"diffex.operation.kind": {
					type: "string",
					required: true,
					values: ["prompt", "compaction", "navigation", "abort", "queue", "bash", "export"],
					description: "Session operation kind",
				},
			},
			endAttributes: {
				"diffex.operation.outcome": {
					type: "string",
					values: ["completed", "queued", "handled", "declined", "failed", "aborted"],
					description: "Terminal operation outcome",
				},
				"diffex.skill.references": {
					type: "string[]",
					cardinality: "high",
					description: "Exact skill id and version pairs explicitly loaded for the operation",
				},
			},
			events: {
				"diffex.skill.available": {
					description: "One immutable skill version available when the request was admitted",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
				"diffex.skill.listed": {
					description: "One skill version listed in the system prompt sent to the model",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
				"diffex.skill.selected": {
					description: "One skill version returned by an automatic selector",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
				"diffex.skill.explicitly_referenced": {
					description: "One skill version explicitly referenced in the admitted user request",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
				"diffex.skill.read": {
					description: "One skill version successfully read through the model-callable read tool",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
				"diffex.skill.force_loaded": {
					description: "One skill version force-loaded from a versioned skill-selector reference",
					attributes: SKILL_OBSERVATION_ATTRIBUTES,
				},
			},
			status: { default: "ok", errorWhen: "The operation fails or is aborted" },
		},
		"diffex.coding_agent.retry": {
			description: "One coding-agent retry decision and delay",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Owning session id",
				},
				"diffex.retry.kind": {
					type: "string",
					required: true,
					values: ["provider", "compaction", "branch_summary"],
					description: "Retrying operation kind",
				},
				"diffex.retry.attempt": {
					type: "number",
					required: true,
					description: "One-based retry attempt",
				},
				"diffex.retry.max_attempts": {
					type: "number",
					required: false,
					description: "Configured retry limit",
				},
				"diffex.retry.delay_ms": {
					type: "number",
					required: false,
					description: "Scheduled delay before retry",
				},
			},
			endAttributes: {
				"diffex.retry.outcome": {
					type: "string",
					values: ["scheduled", "resumed", "cancelled", "failed"],
					description: "Retry transition outcome",
				},
			},
			status: { default: "ok", errorWhen: "The retry transition fails" },
		},
		"diffex.coding_agent.extension_hook": {
			description: "One extension hook invocation",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.extension.hook": {
					type: "string",
					required: true,
					description: "Extension hook name",
				},
				"diffex.extension.path": {
					type: "string",
					required: true,
					cardinality: "high",
					sensitive: true,
					description: "Loaded extension path",
				},
			},
			endAttributes: {
				"diffex.extension.outcome": {
					type: "string",
					values: ["completed", "blocked", "failed"],
					description: "Terminal hook outcome",
				},
			},
			status: { default: "ok", errorWhen: "The extension hook throws" },
		},
		"diffex.coding_agent.subagent": {
			description: "One child-agent lifecycle action",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.subagent.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Stable child-agent id",
				},
				"diffex.subagent.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Caller-assigned child-agent name",
				},
				"diffex.subagent.action": {
					type: "string",
					required: true,
					values: ["spawn", "run", "wait", "retry", "interrupt", "message"],
					description: "Child-agent lifecycle action",
				},
			},
			endAttributes: {
				"diffex.subagent.outcome": {
					type: "string",
					values: ["completed", "failed", "interrupted", "timed_out", "queued"],
					description: "Terminal child-agent action outcome",
				},
			},
			status: { default: "ok", errorWhen: "The child-agent action fails or is interrupted" },
		},
		"diffex.coding_agent.terminal": {
			description: "One user-invoked terminal execution",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Owning session id",
				},
			},
			endAttributes: {
				"diffex.terminal.exit_code": { type: "number", description: "Process exit code" },
				"diffex.terminal.outcome": {
					type: "string",
					values: ["completed", "failed", "cancelled"],
					description: "Terminal execution outcome",
				},
			},
			status: { default: "ok", errorWhen: "The terminal execution fails or is cancelled" },
		},
		"diffex.coding_agent.artifact": {
			description: "One session artifact written to disk",
			parents: { kind: "any" },
			startAttributes: {
				"diffex.session.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Owning session id",
				},
				"diffex.artifact.kind": {
					type: "string",
					required: true,
					values: ["html", "jsonl"],
					description: "Written artifact format",
				},
			},
			endAttributes: {
				"diffex.artifact.path": {
					type: "string",
					cardinality: "high",
					sensitive: true,
					description: "Resolved artifact path",
				},
				"diffex.artifact.outcome": {
					type: "string",
					values: ["written", "failed"],
					description: "Artifact write outcome",
				},
			},
			status: { default: "ok", errorWhen: "The artifact write fails" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

export type CodingAgentSpanName = TelemetrySchemaSpanName<typeof CODING_AGENT_TELEMETRY_SCHEMA>;
export type CodingAgentSpanStartAttributes<Name extends CodingAgentSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof CODING_AGENT_TELEMETRY_SCHEMA,
	Name
>;
export type CodingAgentSpanEndAttributes<Name extends CodingAgentSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof CODING_AGENT_TELEMETRY_SCHEMA,
	Name
>;
export type CodingAgentTelemetrySpan<Name extends CodingAgentSpanName> = SchemaTelemetrySpan<
	typeof CODING_AGENT_TELEMETRY_SCHEMA,
	Name
>;
export type CodingAgentSpan = TelemetrySchemaSpanUnion<typeof CODING_AGENT_TELEMETRY_SCHEMA>;

export function startCodingAgentSpan<
	Name extends CodingAgentSpanName,
	const Attributes extends CodingAgentSpanStartAttributes<Name>,
	Result,
>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<CodingAgentSpanStartAttributes<Name>, Attributes>,
	callback: (span: CodingAgentTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	return telemetryContext.startSpan({ name, attributes }, (span) => callback(span as CodingAgentTelemetrySpan<Name>));
}
