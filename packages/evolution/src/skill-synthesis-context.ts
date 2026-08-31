import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EvolutionInputSnapshot, InstructionDocumentSnapshot } from "./contracts.ts";

export function applicableSkillInstructions(
	input: EvolutionInputSnapshot,
	proposedName: string,
): readonly InstructionDocumentSnapshot[] {
	const repositoryRoot = resolve(input.repository.rootPath);
	const skillPath = resolve(repositoryRoot, ".agents", "skills", proposedName, "SKILL.md");
	return input.instructions
		.filter((instruction) => {
			const instructionPath = resolve(instruction.path);
			const relativeToRepository = relative(repositoryRoot, instructionPath);
			if (
				relativeToRepository === ".." ||
				relativeToRepository.startsWith(`..${sep}`) ||
				isAbsolute(relativeToRepository)
			) {
				return true;
			}
			const relativeToInstruction = relative(dirname(instructionPath), skillPath);
			return (
				relativeToInstruction !== ".." &&
				!relativeToInstruction.startsWith(`..${sep}`) &&
				!isAbsolute(relativeToInstruction)
			);
		})
		.sort(
			(left, right) =>
				left.precedence - right.precedence ||
				left.path.localeCompare(right.path) ||
				left.contentDigest.localeCompare(right.contentDigest),
		);
}
