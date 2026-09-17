/**
 * Production system prompt construction and project context loading.
 * The development prompt lives in system-prompt.ts.
 */

import { formatSkillsForPrompt } from "./skills.ts";
import type { BuildSystemPromptOptions } from "./system-prompt.ts";

/** Build the system prompt with tools, guidelines, and context */
export function buildProductionSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		evolutionMemory,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const evolutionSection = evolutionMemory?.memory
		? `\n\n<evolution_memory version="${evolutionMemory.version}">\n${evolutionMemory.memory}\n</evolution_memory>`
		: "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}
		prompt += evolutionSection;

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills section (only if read tool is available)
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		prompt += `\nCurrent working directory: ${promptCwd}`;

		return prompt;
	}

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const tools = selectedTools || ["read", "bash", "edit", "write", "update_plan"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// Preserve each active tool's guidelines and deduplicate only within that tool.
	const guidelinesByTool = new Map(Object.entries(promptGuidelines ?? {}));
	const guidelineGroups: string[] = [];
	for (const name of new Set(tools)) {
		const toolGuidelines = new Set<string>();
		if (name === "bash" && !hasGrep && !hasFind && !hasLs) {
			toolGuidelines.add("Use bash for file operations like ls, rg, find");
		}
		for (const guideline of guidelinesByTool.get(name) ?? []) {
			const normalized = guideline.trim();
			if (normalized) toolGuidelines.add(normalized);
		}
		if (toolGuidelines.size > 0) {
			const bullets = [...toolGuidelines].map((guideline) => `  - ${guideline.replace(/\r?\n/g, "\n    ")}`);
			guidelineGroups.push(`- ${name}:\n${bullets.join("\n")}`);
		}
	}
	const guidelines = guidelineGroups.length > 0 ? guidelineGroups.join("\n") : "(none)";

	let prompt = `You are Diffex, a coding agent. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom project-related tools.

Tool usage guidelines:
${guidelines}

Conversational Style:
- Keep responses concise and direct, adapting detail and terminology to the user.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!").
- Show file paths clearly when working with files

Quality:
- Follow repository instructions, conventions, and existing tooling.

Diffex documentation (read the documentation website only when the user asks about Diffex itself, its SDK, extensions, or skills):
- Documentation website: https://diffex.ai/docs/overview/
- When working on Diffex topics, read the docs before implementing`;

	if (appendSection) {
		prompt += appendSection;
	}
	prompt += evolutionSection;

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills section (only if read tool is available)
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
