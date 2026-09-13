import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://6b24afa849f8254ab5e6e2d1956239cc.r2.cloudflarestorage.com";

export function verifyReleaseCredentialScope(target, execute) {
	if (!["production", "staging"].includes(target)) throw new Error("Expected production or staging credential scope");
	const allowed = target === "production" ? "diffex-artifacts" : "diffex-artifacts-staging";
	return ["diffex-artifacts", "diffex-artifacts-staging", "image-converter"].map((bucket) => {
		const result = execute([
			"s3api",
			"list-objects-v2",
			"--bucket",
			bucket,
			"--endpoint-url",
			ENDPOINT,
			"--prefix",
			"releases/v1/",
			"--max-keys",
			"1",
		]);
		const denied = result.status !== 0 && /An error occurred \(AccessDenied\)/.test(result.stderr ?? "");
		if (result.error || (bucket === allowed ? result.status !== 0 : !denied))
			throw new Error(`${target}: unexpected bucket scope for ${bucket}; provider diagnostics withheld`);
		return { bucket, access: bucket === allowed ? "allowed" : "denied" };
	});
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 3 || !["--production", "--staging"].includes(process.argv[2]))
		throw new Error("Usage: node scripts/verify-release-credentials.mjs <--production|--staging>");
	if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
		throw new Error("Dedicated release publication credentials are required");
	const scope = verifyReleaseCredentialScope(process.argv[2].slice(2), (args) =>
		spawnSync("aws", args, {
			encoding: "utf8",
			timeout: 60000,
			env: { ...process.env, AWS_DEFAULT_REGION: "auto", AWS_EC2_METADATA_DISABLED: "true", AWS_PAGER: "" },
		}),
	);
	console.log(JSON.stringify({ checkedAt: new Date().toISOString(), scope }, null, 2));
}
