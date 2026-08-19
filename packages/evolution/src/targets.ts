import type {
	EvolutionLeaseToken,
	EvolutionTarget,
	HarnessActivationResult,
	MutationBatch,
	MutationWriteResult,
} from "./contracts.ts";

export type EvolutionTargetKind = EvolutionTarget["kind"];

export interface EvolutionTargetWriter {
	readonly kind: EvolutionTargetKind;
	write(
		batch: MutationBatch,
		context: { readonly idempotencyKey: string; readonly lease: EvolutionLeaseToken; readonly signal?: AbortSignal },
	): Promise<MutationWriteResult>;
	activate(
		batch: MutationBatch,
		writeResult: MutationWriteResult,
		context: { readonly idempotencyKey: string; readonly lease: EvolutionLeaseToken; readonly signal?: AbortSignal },
	): Promise<HarnessActivationResult>;
}

export interface EvolutionTargetAdapterRegistryOptions {
	readonly enabledTargetKinds?: readonly EvolutionTargetKind[];
	readonly writers?: readonly EvolutionTargetWriter[];
}

export class EvolutionTargetAdapterRegistry {
	readonly #enabledTargetKinds: ReadonlySet<EvolutionTargetKind>;
	readonly #writers = new Map<EvolutionTargetKind, EvolutionTargetWriter>();

	constructor(options: EvolutionTargetAdapterRegistryOptions = {}) {
		this.#enabledTargetKinds = new Set(options.enabledTargetKinds ?? ["evolution-memory"]);
		for (const writer of options.writers ?? []) this.register(writer);
	}

	register(writer: EvolutionTargetWriter): void {
		if (!this.#enabledTargetKinds.has(writer.kind)) {
			throw new Error(`Evolution target "${writer.kind}" is not enabled`);
		}
		if (this.#writers.has(writer.kind)) {
			throw new Error(`Evolution target writer "${writer.kind}" is already registered`);
		}
		this.#writers.set(writer.kind, writer);
	}

	isEnabled(kind: EvolutionTargetKind): boolean {
		return this.#enabledTargetKinds.has(kind);
	}

	writerFor(kind: EvolutionTargetKind): EvolutionTargetWriter | undefined {
		if (!this.isEnabled(kind)) return undefined;
		return this.#writers.get(kind);
	}
}
