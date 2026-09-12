import assert from "node:assert/strict";
import { integrity, sha256 } from "../../release-registry.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "../../release-packages.mjs";

const publisher = fileURLToPath(new URL("../../publish-release-announcement.mjs", import.meta.url));
const npmPublisher = fileURLToPath(new URL("../../publish.mjs", import.meta.url));
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
	for (const command of ["git", "npm"]) {
		const file = join(directory, "bin", command);
		copyFileSync(fileURLToPath(new URL(`./${command}.mjs`, import.meta.url)), file);
		chmodSync(file, 0o700);
	}
	const policy = JSON.parse(
		readFileSync(new URL("../../../docs/release/distribution-policy.json", import.meta.url), "utf8"),
	);
	mkdirSync(join(directory, "docs/release"), { recursive: true });
	writeFileSync(join(directory, "docs/release/distribution-policy.json"), JSON.stringify(policy));
	writeFileSync(join(directory, "package-lock.json"), "fixture locked inputs");
	const artifactDirectory = join(directory, "artifacts");
	mkdirSync(artifactDirectory);
	writeFileSync(join(artifactDirectory, "source.tar.gz"), "fixture frozen source");
	if (staging) rmSync(aws);
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
		run(
			version,
			{
				failure,
				credentials = true,
				commit = "a".repeat(40),
				command = "announce",
				missing = false,
				failPublishAt,
				mutateManifest,
				mutatePolicy,
			} = {},
		) {
			writeFileSync(join(directory, "package.json"), JSON.stringify({ version, private: true }));
			writeFileSync(
				join(directory, "docs/release/distribution-policy.json"),
				JSON.stringify(mutatePolicy ? mutatePolicy(structuredClone(policy)) : policy),
			);
			const manifests = packages.map((pkg, index) => {
				const target = join(directory, "packages", `package-${index}`);
				mkdirSync(target, { recursive: true });
				const manifest = { name: pkg.name, version };
				writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
				return manifest;
			});
			const artifactPackages = manifests.map((pkg) => {
				const bytes = Buffer.from(`approved ${pkg.name}@${pkg.version}`);
				const artifact = {
					...pkg,
					filename: `${pkg.name.replace("@", "").replace("/", "-")}-${version}.tgz`,
					sha256: sha256(bytes),
					integrity: integrity(bytes),
					size: bytes.length,
				};
				writeFileSync(join(artifactDirectory, artifact.filename), bytes);
				return artifact;
			});
			const manifest = {
				schemaVersion: 1,
				version,
				source: {
					repository: "diffexai/diffex",
					commit,
					tree: "c".repeat(40),
					lockSha256: sha256(readFileSync(join(directory, "package-lock.json"))),
					policySha256: sha256(readFileSync(join(directory, "docs/release/distribution-policy.json"))),
				},
				modelData: [{ path: "fixture.json", sha256: sha256("fixture models") }],
				snapshot: { filename: "source.tar.gz", sha256: sha256("fixture frozen source") },
				packages: artifactPackages,
			};
			const { schemaVersion, packages: artifacts, ...inputs } = manifest;
			writeFileSync(join(artifactDirectory, "inputs.json"), JSON.stringify(inputs));
			if (mutateManifest) mutateManifest(manifest);
			writeFileSync(join(artifactDirectory, "manifest.json"), JSON.stringify(manifest));
			writeFileSync(fixturePath, JSON.stringify({ packages: manifests, failure, commit, missing, failPublishAt }));
			const env = {
				PATH: `${join(directory, "bin")}:${process.env.PATH}`,
				DIFFEX_FIXTURE_REAL_AWS: staging ? "true" : "",
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
					...(command === "publish"
						? [npmPublisher, "--artifacts", artifactDirectory]
						: [
								publisher,
								"--artifacts",
								artifactDirectory,
								"--version",
								version,
								"--bucket",
								bucket,
								"--endpoint",
								endpoint,
								"--source-commit",
								commit,
							]),
				],
				{ cwd: directory, env, encoding: "utf8", timeout: staging ? 180000 : 30000 },
			);
			assert.ifError(result.error);
			return result;
		},
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}
