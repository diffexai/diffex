import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	send: (command: { type: string; requestId: string; resolution: string }) => Promise<unknown>;
};

describe("RpcClient task-boundary resolution", () => {
	it.each(["switch", "stay", "cancel"] as const)("sends the %s resolution", async (resolution) => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		const send = vi.fn(async () => ({
			type: "response",
			command: "resolve_task_boundary",
			success: true,
		}));
		privateClient.send = send;

		await client.resolveTaskBoundary("boundary-1", resolution);

		expect(send).toHaveBeenCalledWith({
			type: "resolve_task_boundary",
			requestId: "boundary-1",
			resolution,
		});
	});
});
