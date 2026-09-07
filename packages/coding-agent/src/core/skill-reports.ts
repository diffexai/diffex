import type { AgentLoopConfig, StreamFn } from "@earendil-works/diffex-agent-core";
import type { AssistantMessage, Tool } from "@earendil-works/diffex-ai";
import {
	computeHarnessSkillId,
	type HarnessVersion,
	type HarnessVersionBundle,
	type HarnessWorkspaceIdentity,
} from "@earendil-works/diffex-harness-state";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { EvolutionScope, SkillScoreIdentity } from "#evolution";
import { createPrivateReportContinuation } from "./private-report.ts";
import type { SkillCatalog } from "./skills.ts";

export const SKILL_REPORT_PROMPT =
	"From your evolved skills, report only skills you used during this run that were helpful or harmful. Return their skill names and helpful/harmful judgments. Omit all other skills; return an empty list if none qualify. Submit the report using report_skill_usage.";

export const SKILL_REPORT_TOOL = {
	name: "report_skill_usage",
	description: "Privately report only helpful or harmful evolved skills used during this run.",
	parameters: Type.Object(
		{
			skills: Type.Array(
				Type.Object(
					{
						skillName: Type.String({ minLength: 1 }),
						signal: Type.Union([Type.Literal("helpful"), Type.Literal("harmful")]),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	constrainedSampling: { type: "json_schema", strict: "prefer" },
} satisfies Tool;

/** Ephemeral scoring input, never a session/evolution artifact. Item 3 owns neutral inference and point updates. */
export interface ValidatedSkillReport {
	readonly outputId: string;
	readonly scope: EvolutionScope;
	readonly workspace: HarnessWorkspaceIdentity;
	readonly harnessRevision: HarnessVersion;
	readonly activeSkills: readonly SkillScoreIdentity[];
	readonly judgments: readonly {
		readonly item: SkillScoreIdentity;
		readonly signal: "helpful" | "harmful";
	}[];
}

export function resolveSkillReport(
	message: AssistantMessage,
	binding: Omit<ValidatedSkillReport, "judgments">,
	catalog: SkillCatalog,
): ValidatedSkillReport | undefined {
	if (message.stopReason !== "toolUse") return undefined;
	const calls = message.content.filter((part) => part.type === "toolCall");
	const call = calls[0];
	if (calls.length !== 1 || call?.name !== SKILL_REPORT_TOOL.name) return undefined;
	if (!Check(SKILL_REPORT_TOOL.parameters, call.arguments)) return undefined;
	const seen = new Set<string>();
	const judgments: ValidatedSkillReport["judgments"][number][] = [];
	for (const entry of call.arguments.skills) {
		// Only exposed names/aliases count. An installed skill's unsuffixed name never identifies its evolved alias.
		const matches = catalog.skills.filter((skill) => skill.name === entry.skillName);
		const skill = matches[0];
		if (
			matches.length !== 1 ||
			skill?.sourceKind !== "evolved" ||
			skill.harnessRevision !== binding.harnessRevision
		) {
			return undefined;
		}
		const item = binding.activeSkills.find(
			(item) =>
				item.skillId === skill.skillId &&
				item.packageVersion === skill.version &&
				item.contentDigest === skill.contentDigest,
		);
		if (!item || seen.has(item.skillId)) return undefined;
		seen.add(item.skillId);
		judgments.push({ item, signal: entry.signal });
	}
	return { ...binding, judgments };
}

export function createSkillReportContinuation(options: {
	getBundle: () => HarnessVersionBundle | undefined;
	getCatalog: () => SkillCatalog;
	getOutputId: () => string;
	workspace: HarnessWorkspaceIdentity;
	/** Raw model-runtime transport, not the agent/extension-instrumented stream function. */
	stream: StreamFn;
	/** Private scoring boundary; reports are discarded when no consumer is installed. */
	consume?: (report: ValidatedSkillReport) => Promise<void>;
}): NonNullable<AgentLoopConfig["preparePrivateContinuation"]> {
	return (context, model) => {
		const bundle = options.getBundle();
		const workspace = { ...options.workspace };
		if (!bundle || workspace.directoryId === undefined) return undefined;
		const activeSkills = bundle.state.skills
			.filter(
				(skill) =>
					skill.workspace.repositoryId === workspace.repositoryId &&
					skill.workspace.directoryId === workspace.directoryId,
			)
			.map(
				(skill): SkillScoreIdentity => ({
					skillId: computeHarnessSkillId(workspace, skill.path),
					packageVersion: skill.packageVersion,
					contentDigest: skill.contentHash,
					workspace,
				}),
			);
		if (activeSkills.length === 0) return undefined;
		// Bind before the main request. Neither pointer changes nor catalog reloads can redirect a pending report.
		const catalog = structuredClone(options.getCatalog());
		const binding = {
			outputId: options.getOutputId(),
			scope: { repositoryId: workspace.repositoryId, scopeId: workspace.directoryId },
			workspace,
			harnessRevision: bundle.manifest.version,
			activeSkills,
		};
		return createPrivateReportContinuation({
			context,
			model,
			stream: options.stream,
			prompt: SKILL_REPORT_PROMPT,
			tool: SKILL_REPORT_TOOL,
			consume: async (response) => {
				const report = resolveSkillReport(response, binding, catalog);
				if (report) await options.consume?.(report);
			},
		});
	};
}
