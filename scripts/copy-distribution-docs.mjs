import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { distributionDocs } from "./cli-distribution.mjs";

const [source, target] = process.argv.slice(2);
if (!source || !target) throw new Error("Usage: copy-distribution-docs.mjs SOURCE TARGET");
for (const file of distributionDocs) {
	mkdirSync(dirname(join(target, file)), { recursive: true });
	cpSync(join(source, file), join(target, file));
}
