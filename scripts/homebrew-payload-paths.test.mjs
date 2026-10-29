import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Homebrew Python payload tools enforce trusted paths and link containment", () => {
	execFileSync("python3", ["-m", "unittest", "discover", "-s", "scripts", "-p", "test_homebrew_payload_paths.py"], {
		cwd: fileURLToPath(new URL("../", import.meta.url)),
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		stdio: "inherit",
		timeout: 30_000,
	});
});
