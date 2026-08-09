import { describe, expect, it } from "vitest";
import { getDiffexUserAgent } from "../src/utils/diffex-user-agent.ts";

describe("getDiffexUserAgent", () => {
	it("formats the user agent expected by the catalog service", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getDiffexUserAgent("1.2.3");

		expect(userAgent).toBe(`diffex/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^diffex\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
