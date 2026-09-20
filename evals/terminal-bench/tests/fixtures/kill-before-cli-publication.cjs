// Terminate the real launcher at its spawn-to-publication boundary.
const fs = require("node:fs");
const { basename, dirname, join } = require("node:path");

const write = fs.writeFileSync;
fs.writeFileSync = (path, ...args) => {
	if (basename(path) === "cli.json") {
		write(join(dirname(path), "gated-child.json"), ...args);
		process.kill(process.pid, "SIGKILL");
	}
	return write(path, ...args);
};
