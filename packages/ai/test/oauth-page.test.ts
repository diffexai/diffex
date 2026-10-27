import { describe, expect, it } from "vitest";
import { oauthErrorHtml, oauthSuccessHtml } from "../src/auth/oauth/oauth-page.ts";

describe("OAuth callback presentation", () => {
	it("escapes dynamic copy in both page variants", () => {
		const input = `<script a="'">&`;
		for (const html of [oauthSuccessHtml(input), oauthErrorHtml(input, input)]) {
			expect(html).toContain("&lt;script a=&quot;&#39;&quot;&gt;&amp;");
			expect(html).not.toContain(input);
			expect(html.replaceAll('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(
				/<(script|link|img)\b|https?:\/\//,
			);
		}
	});
});
