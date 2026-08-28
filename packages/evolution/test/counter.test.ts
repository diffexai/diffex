import { describe, expect, it } from "vitest";
import {
	COUNTER_OBSERVATION_SCHEMA_VERSION,
	COUNTER_REPORT_SCHEMA_VERSION,
	DisabledPreReflectionStage,
	EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION,
	type EvolutionMemoryItem,
	SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION,
	SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION,
} from "../src/index.ts";

const HARNESS_VERSION = `sha256:${"1".repeat(64)}`;

describe("reserved counter contracts", () => {
	it("versions memory and skill lifecycle records independently", () => {
		expect(EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION).toBe(1);
		expect(COUNTER_OBSERVATION_SCHEMA_VERSION).toBe(1);
		expect(COUNTER_REPORT_SCHEMA_VERSION).toBe(1);
		expect(SKILL_LIFECYCLE_OBSERVATION_SCHEMA_VERSION).toBe(1);
		expect(SKILL_LIFECYCLE_REPORT_SCHEMA_VERSION).toBe(1);
	});

	it("keeps stable memory identity outside rendered memory", () => {
		const item: EvolutionMemoryItem = {
			schemaVersion: EVOLUTION_MEMORY_ITEM_SCHEMA_VERSION,
			memoryItemId: "memory-item-1",
			contentDigest: `sha256:${"2".repeat(64)}`,
			creationRevision: HARNESS_VERSION,
			supersessionRevision: null,
			ledger: {
				origin: "evolution",
				creationEventId: "ledger-event-1",
				supersessionEventId: null,
			},
		};

		expect(item.memoryItemId).toBe("memory-item-1");
		expect(item).not.toHaveProperty("content");
	});

	it("returns no report from the disabled stage", async () => {
		const counter = new DisabledPreReflectionStage();

		await expect(counter.run()).resolves.toBeNull();
	});
});
