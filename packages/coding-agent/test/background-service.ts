import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

export interface ServiceAddress {
	pid: number;
	port: number;
}

export function createBackgroundService(directory: string, options?: { noisy?: boolean }) {
	const source = join(directory, "service.cjs");
	const addressFile = join(directory, "service.json");
	writeFileSync(
		source,
		`
const fs = require("node:fs");
const server = require("node:net").createServer(socket => socket.end("service-ok"));
process.stdout.on("error", () => {});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(${JSON.stringify(addressFile)}, JSON.stringify({ pid: process.pid, port: server.address().port })));
${options?.noisy ? 'setInterval(() => process.stdout.write("background output\\n"), 10);' : ""}
`,
	);
	const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
	return {
		command: `nohup ${quote(process.execPath)} ${quote(source)} ${options?.noisy ? "" : ">/dev/null 2>&1"} & while [ ! -f ${quote(addressFile)} ]; do sleep 0.01; done`,
		address(): ServiceAddress {
			return JSON.parse(readFileSync(addressFile, "utf8"));
		},
		cleanup() {
			if (!existsSync(addressFile)) return;
			const address: ServiceAddress = JSON.parse(readFileSync(addressFile, "utf8"));
			try {
				process.kill(address.pid, "SIGKILL");
			} catch {}
		},
	};
}

export function queryBackgroundService(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let response = "";
		socket.setEncoding("utf8");
		socket.setTimeout(2_000, () => socket.destroy(new Error("Service query timed out")));
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.on("end", () => resolve(response));
		socket.on("error", reject);
	});
}
