import { createHash } from "node:crypto";
import { HOMEBREW_PLATFORMS } from "../homebrew-formula.mjs";

export function homebrewFixture(version = "1.2.3") {
	const assets = new Map(HOMEBREW_PLATFORMS.map((platform) => [platform, Buffer.from(`reviewed fixture ${platform} ${version}`)]));
	const manifest = {
		schemaVersion: 1,
		product: "@diffexai/diffex",
		version,
		sourceCommit: "a".repeat(40),
		nodeVersion: "22.23.4",
		npmVersion: "10.9.9",
		platforms: HOMEBREW_PLATFORMS.map((platform) => ({
			platform,
			filename: `diffex-${version}-${platform}.tar.gz`,
			size: assets.get(platform).length,
			sha256: createHash("sha256").update(assets.get(platform)).digest("hex"),
			inventorySha256: "b".repeat(64),
			osBaseline: platform.startsWith("darwin-") ? "macos-15" : "ubuntu-24.04",
		})),
	};
	return { manifest, assets, manifestBytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) };
}
