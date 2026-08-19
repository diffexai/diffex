import type { PreReflectionStage } from "./ports.ts";

export class DisabledPreReflectionStage implements PreReflectionStage {
	run(): Promise<null> {
		return Promise.resolve(null);
	}
}
