import { readReleaseArtifacts } from "./release-artifacts.mjs";
import { prepareHomebrewArchive } from "./homebrew-archive.mjs";

const [releaseDirectory, outputDirectory, ...extra] = process.argv.slice(2);
if (!releaseDirectory || !outputDirectory || extra.length)
	throw new Error("Usage: node scripts/prepare-homebrew-archive.mjs RETAINED_NPM_DIRECTORY OUTPUT_DIRECTORY");
const manifest = readReleaseArtifacts(releaseDirectory, { sourceCommit: process.env.DIFFEX_SOURCE_COMMIT });
const record = await prepareHomebrewArchive({ releaseDirectory, outputDirectory, manifest, runtimeDirectory: process.env.HOMEBREW_RUNTIME_INPUTS });
console.log(`Prepared reviewed Homebrew archive ${record.filename} (${record.sha256})`);
