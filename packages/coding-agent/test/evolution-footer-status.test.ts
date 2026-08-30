import type { HarnessVersion } from "@earendil-works/diffex-harness-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvolutionHarnessVersionInfo, EvolutionOverview } from "#evolution";
import type { EvolutionRuntimeEvent } from "../src/core/evolution-runtime.ts";
import {
	EvolutionFooterStatus,
	type EvolutionFooterStatusClient,
} from "../src/modes/interactive/components/evolution-footer-status.ts";

const rootVersion = `sha256:${"a".repeat(64)}` as HarnessVersion;
const evolvedVersion = `sha256:${"b".repeat(64)}` as HarnessVersion;

function overview(
	currentHarnessVersion: HarnessVersion,
	activeJob: EvolutionOverview["activeJob"] = null,
): EvolutionOverview {
	return {
		scope: { repositoryId: "repository", scopeId: "repository" },
		processedEvidenceCursor: 0,
		ingestionHighWaterCursor: 0,
		unprocessedEstimatedTokens: 0,
		settledInvocationCount: 0,
		automaticTokenThreshold: 1_000_000,
		automaticMinimumInvocations: 5,
		lastEvolutionAt: null,
		cooldownRemainingMs: 0,
		automaticEligibility: { eligible: false, reason: "insufficient-tokens" },
		activeJob,
		newestResumableJob: null,
		currentHarnessVersion,
		observedHarnessVersion: currentHarnessVersion,
		nextPromptWillRefresh: false,
		rollbackAction: null,
	};
}

function activeJob(): NonNullable<EvolutionOverview["activeJob"]> {
	return {
		jobId: "job-active",
		trigger: "automatic",
		stage: "reflecting",
		outcome: "active",
		reasonCode: null,
		analysisStatus: "processing",
		candidateGeneration: {
			status: "not-applicable",
			stage: null,
			updatedAt: null,
			attempt: 0,
			retryNotBefore: null,
			failureMessage: null,
		},
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:01:00.000Z",
		terminalAt: null,
		resumable: false,
		cancellable: true,
	};
}

function client(
	initialOverview: EvolutionOverview,
	initialVersionInfo: readonly EvolutionHarnessVersionInfo[],
): {
	client: EvolutionFooterStatusClient;
	emit: (event: EvolutionRuntimeEvent) => void;
	setEnabled: (value: boolean) => void;
	setOverview: (value: EvolutionOverview) => void;
	setVersionInfo: (value: readonly EvolutionHarnessVersionInfo[]) => void;
	unsubscribed: ReturnType<typeof vi.fn>;
} {
	let enabled = true;
	let currentOverview = initialOverview;
	let currentVersionInfo = initialVersionInfo;
	let listener: ((event: EvolutionRuntimeEvent) => void) | undefined;
	const unsubscribed = vi.fn();
	return {
		client: {
			getEnabled: () => enabled,
			subscribe: (next) => {
				listener = next;
				return unsubscribed;
			},
			overview: async () => currentOverview,
			listHarnessVersionInfo: async () => currentVersionInfo,
		},
		emit: (event) => listener?.(event),
		setEnabled: (value) => {
			enabled = value;
		},
		setOverview: (value) => {
			currentOverview = value;
		},
		setVersionInfo: (value) => {
			currentVersionInfo = value;
		},
		unsubscribed,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("EvolutionFooterStatus", () => {
	it("hydrates the active harness metadata", async () => {
		const fixture = client(overview(evolvedVersion), [
			{
				version: evolvedVersion,
				kind: "evolved",
				evolvedAt: "2026-08-20T12:48:00.000Z",
				evolvedIn: "/projects/diffex",
			},
		]);
		const status = new EvolutionFooterStatus({
			client: fixture.client,
			getActiveHarnessVersion: () => evolvedVersion,
			requestRender: () => {},
		});

		await status.refresh();

		expect(status.getSnapshot()).toMatchObject({
			loaded: true,
			running: false,
			activeVersionInfo: { version: evolvedVersion, kind: "evolved" },
		});
		status.dispose();
		expect(fixture.unsubscribed).toHaveBeenCalledOnce();
	});

	it("animates the inline spinner while an evolution job is active", async () => {
		vi.useFakeTimers();
		const fixture = client(overview(rootVersion), [
			{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
		]);
		const requestRender = vi.fn();
		const status = new EvolutionFooterStatus({
			client: fixture.client,
			getActiveHarnessVersion: () => rootVersion,
			requestRender,
			spinnerIntervalMs: 80,
		});
		await status.refresh();
		fixture.setOverview(overview(rootVersion, activeJob()));

		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T00:00:00.000Z",
			type: "started",
			stage: "snapshotting",
		});
		const initialFrame = status.getSnapshot().spinnerFrame;
		vi.advanceTimersByTime(80);

		expect(status.getSnapshot().running).toBe(true);
		expect(status.getSnapshot().spinnerFrame).not.toBe(initialFrame);
		expect(requestRender).toHaveBeenCalled();
		status.dispose();
	});

	it("stops animating an active evolution job when evolution is disabled", async () => {
		vi.useFakeTimers();
		const fixture = client(overview(rootVersion, activeJob()), [
			{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
		]);
		const requestRender = vi.fn();
		const status = new EvolutionFooterStatus({
			client: fixture.client,
			getActiveHarnessVersion: () => rootVersion,
			requestRender,
			spinnerIntervalMs: 80,
		});

		await status.refresh();
		vi.advanceTimersByTime(80);
		expect(status.getSnapshot().running).toBe(true);
		const activeFrame = status.getSnapshot().spinnerFrame;

		fixture.setEnabled(false);
		fixture.emit({ type: "enabled-changed", enabled: false });
		vi.advanceTimersByTime(160);

		expect(status.getSnapshot().running).toBe(false);
		expect(status.getSnapshot().spinnerFrame).toBe(activeFrame);
		expect(requestRender).toHaveBeenCalled();
		status.dispose();
	});

	it("activates a newly selected evolved harness after completion", async () => {
		let activeVersion: HarnessVersion = rootVersion;
		const fixture = client(overview(rootVersion), [
			{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
		]);
		const selected = vi.fn(async (version: string) => {
			activeVersion = version as HarnessVersion;
		});
		const status = new EvolutionFooterStatus({
			client: fixture.client,
			getActiveHarnessVersion: () => activeVersion,
			requestRender: () => {},
			onSelectedHarnessChange: selected,
		});
		await status.refresh();
		fixture.setOverview(overview(evolvedVersion));
		fixture.setVersionInfo([
			{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null },
			{
				version: evolvedVersion,
				kind: "evolved",
				evolvedAt: "2026-08-20T12:48:00.000Z",
				evolvedIn: "/projects/diffex",
			},
		]);

		fixture.emit({
			jobId: "job-active",
			emittedAt: "2026-08-20T12:48:00.000Z",
			type: "completed",
			stage: "completed",
		});
		await vi.waitFor(() => expect(selected).toHaveBeenCalledWith(evolvedVersion));

		expect(status.getSnapshot().activeVersionInfo?.version).toBe(evolvedVersion);
		status.dispose();
	});

	it("reloads harness metadata when completion races with an in-flight refresh", async () => {
		let listener: ((event: EvolutionRuntimeEvent) => void) | undefined;
		let resolveOverview: ((value: EvolutionOverview) => void) | undefined;
		let activeVersion: HarnessVersion = rootVersion;
		const evolvedOverview = overview(evolvedVersion);
		const evolvedInfo: EvolutionHarnessVersionInfo = {
			version: evolvedVersion,
			kind: "evolved",
			evolvedAt: "2026-08-20T12:48:00.000Z",
			evolvedIn: "/projects/diffex",
		};
		const overviewClient = vi
			.fn<() => Promise<EvolutionOverview>>()
			.mockResolvedValueOnce(overview(rootVersion))
			.mockImplementationOnce(
				() =>
					new Promise<EvolutionOverview>((resolve) => {
						resolveOverview = resolve;
					}),
			)
			.mockResolvedValue(evolvedOverview);
		const listHarnessVersionInfo = vi
			.fn<() => Promise<readonly EvolutionHarnessVersionInfo[]>>()
			.mockResolvedValueOnce([{ version: rootVersion, kind: "default", evolvedAt: null, evolvedIn: null }])
			.mockResolvedValue([evolvedInfo]);
		const selected = vi.fn(async (version: string) => {
			activeVersion = version as HarnessVersion;
		});
		const status = new EvolutionFooterStatus({
			client: {
				getEnabled: () => true,
				subscribe: (next) => {
					listener = next;
					return () => {};
				},
				overview: overviewClient,
				listHarnessVersionInfo,
			},
			getActiveHarnessVersion: () => activeVersion,
			requestRender: () => {},
			onSelectedHarnessChange: selected,
		});
		await vi.waitFor(() => expect(status.getSnapshot().loaded).toBe(true));

		const staleRefresh = status.refresh();
		await vi.waitFor(() => expect(overviewClient).toHaveBeenCalledTimes(2));
		listener?.({
			jobId: "job-active",
			emittedAt: "2026-08-20T12:48:00.000Z",
			type: "completed",
			stage: "completed",
		});
		if (resolveOverview === undefined) throw new Error("Expected an in-flight overview request");
		resolveOverview(evolvedOverview);
		await staleRefresh;

		await vi.waitFor(() => expect(status.getSnapshot().activeVersionInfo).toEqual(evolvedInfo));
		expect(selected).toHaveBeenCalledWith(evolvedVersion);
		expect(listHarnessVersionInfo).toHaveBeenCalledTimes(2);
		status.dispose();
	});
});
