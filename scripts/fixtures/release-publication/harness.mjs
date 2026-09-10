import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "../../release-packages.mjs";

const publisher = fileURLToPath(new URL("../../publish-release-announcement.mjs", import.meta.url));
const registry = fileURLToPath(new URL("./registry.mjs", import.meta.url));
export function createPublicationFixture({ staging = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "diffex-publication-test-"));
	const statePath = join(directory, "storage.json");
	const fixturePath = join(directory, "registry.json");
	writeFileSync(statePath, JSON.stringify({ objects: {}, calls: [] }));
	mkdirSync(join(directory, "bin"));
	const aws = join(directory, "bin/aws");
	copyFileSync(fileURLToPath(new URL("./aws.mjs", import.meta.url)), aws);
	chmodSync(aws, 0o700);
	const packages = getPublicWorkspacePackages();
	const bucket = staging ? "diffex-artifacts-staging" : "fixture-releases";
	const endpoint = staging
		? "https://6b24afa849f8254ab5e6e2d1956239cc.r2.cloudflarestorage.com"
		: "https://storage.example.invalid";
	return {
		directory,
		bucket,
		endpoint,
		packageCount: packages.length,
		state: () => JSON.parse(readFileSync(statePath, "utf8")),
		seed: (objects, failure) => writeFileSync(statePath, JSON.stringify({ objects, failure, calls: [] })),
		run(version, { failure, credentials = true, commit = "a".repeat(40) } = {}) {
			const manifests = packages.map((pkg, index) => {
				const target = join(directory, "packages", `package-${index}`);
				mkdirSync(target, { recursive: true });
				const manifest = { name: pkg.name, version };
				writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
				return manifest;
			});
			writeFileSync(fixturePath, JSON.stringify({ packages: manifests, failure }));
			const env = {
				PATH: staging ? process.env.PATH : `${join(directory, "bin")}:${process.env.PATH}`,
				AWS_ACCESS_KEY_ID: credentials ? (staging ? process.env.AWS_ACCESS_KEY_ID : "fixture-access") : "",
				AWS_SECRET_ACCESS_KEY: credentials ? (staging ? process.env.AWS_SECRET_ACCESS_KEY : "fixture-secret") : "",
				AWS_SESSION_TOKEN: staging ? (process.env.AWS_SESSION_TOKEN ?? "") : "",
				AWS_CONFIG_FILE: join(directory, "no-aws-config"),
				AWS_SHARED_CREDENTIALS_FILE: join(directory, "no-aws-credentials"),
				AWS_EC2_METADATA_DISABLED: "true",
				DIFFEX_PUBLICATION_FIXTURE: fixturePath,
				DIFFEX_PUBLICATION_STORAGE: statePath,
			};
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					registry,
					publisher,
					"--version",
					version,
					"--bucket",
					bucket,
					"--endpoint",
					endpoint,
					"--source-commit",
					commit,
				],
				{ cwd: directory, env, encoding: "utf8", timeout: staging ? 180000 : 30000 },
			);
			assert.ifError(result.error);
			return result;
		},
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}
