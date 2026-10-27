import { appendFileSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

// Kept self-contained: installed.py copies this extension beside installed node_modules.
function openRecording() {
	const requested = process.env.DIFFEX_BEHAVIOR_RECORD;
	if (!requested) throw new Error("DIFFEX_BEHAVIOR_RECORD is required");
	if (requested.includes("\0") || requested.split(/[\\/]/).includes("..")) {
		throw new Error("Invalid behavior recording path");
	}
	const absolute = resolve(requested);
	// These are filesystem boundaries, not env-controlled TMPDIR or record dirname.
	const roots = [realpathSync(process.cwd()), realpathSync("/tmp")];
	const lexicalRoots = [...roots, process.cwd(), "/tmp"];
	if (process.platform === "darwin") {
		roots.push(realpathSync("/private/var/folders"));
		lexicalRoots.push("/var/folders", "/private/var/folders");
	}
	const lexicalRoot = lexicalRoots.find((entry) => absolute.startsWith(`${entry}${sep}`));
	if (!lexicalRoot || !absolute.startsWith(`${lexicalRoot}${sep}`)) {
		throw new Error("Unauthorized behavior recording destination");
	}
	const parent = realpathSync(dirname(absolute));
	const recordPath = resolve(parent, basename(absolute));
	const root = roots.find((entry) => recordPath.startsWith(`${entry}${sep}`));
	if (!root || !recordPath.startsWith(`${root}${sep}`)) {
		throw new Error("Unauthorized behavior recording destination");
	}
	const uid = process.getuid();
	for (let directory = parent; ; directory = dirname(directory)) {
		const info = lstatSync(directory);
		// Permit OS-owned sticky temp roots, but not writable/shared intermediate dirs.
		if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0) ||
			((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) {
			throw new Error("Unsafe behavior recording directory");
		}
		if (directory === root) break;
	}
	// Open without truncation before inspecting the file; never trust a path precheck.
	const fd = openSync(recordPath, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
	try {
		const opened = fstatSync(fd);
		const current = lstatSync(recordPath);
		if (
			!opened.isFile() || opened.nlink !== 1 || opened.uid !== uid || (opened.mode & 0o022) !== 0 || !current.isFile() ||
			opened.dev !== current.dev || opened.ino !== current.ino ||
			realpathSync(parent) !== parent
		) throw new Error("Behavior recording changed while opening");
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

// Observes the installed provider transport; never supplies a model response.
export default function (diffex) {
	const recordFd = openRecording();
	let requests;
	try {
		requests = readFileSync(recordFd, "utf8").trim().split("\n").filter((line) => line && JSON.parse(line).type === "request").length;
	} catch (error) {
		closeSync(recordFd);
		throw error;
	}
	diffex.on("session_shutdown", () => closeSync(recordFd));
	const record = (event) => {
		const serialized = JSON.stringify(event);
		const key = process.env.OPENAI_API_KEY;
		appendFileSync(recordFd, `${key ? serialized.replaceAll(key, "[REDACTED]") : serialized}\n`);
	};
	const originalFetch = globalThis.fetch;
	const started = Number(process.env.DIFFEX_BEHAVIOR_STARTED);
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.href === "https://api.diffex.ai/api/latest-version")
			return Response.json({ error: "no_published_release" }, { status: 404 });
		if (url.origin !== "https://api.openai.com" || !url.pathname.startsWith("/v1/"))
			throw new Error("Unexpected live provider destination");
		if (++requests > 6 || Date.now() - started > 180_000) throw new Error("Live request budget exceeded");
		const body = JSON.parse(await request.text());
		if (url.pathname.endsWith("/responses")) body.max_output_tokens = 512;
		else body.max_completion_tokens = 512;
		record({ type: "request", request: requests, path: url.pathname, maxOutputTokens: 512 });
		try {
			const response = await originalFetch(new Request(request, {
				body: JSON.stringify(body), signal: AbortSignal.any([request.signal, AbortSignal.timeout(180_000 - (Date.now() - started))]),
			}));
			const actualStatus = response.status;
			const status = Number(actualStatus);
			if (typeof actualStatus !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
				throw new Error("Invalid live HTTP response status");
			}
			record({ type: "response", status });
			return response;
		} catch (error) {
			record({ type: "provider-error", error: error instanceof Error ? error.name : "UnknownError" });
			throw error;
		}
	};
	diffex.on("tool_result", (event) => record({ type: "tool_result", toolName: event.toolName, content: event.content, isError: event.isError }));
	diffex.on("message_update", (event) => {
		if (event.assistantMessageEvent.type === "text_delta") record({ type: "streamed-text", delta: event.assistantMessageEvent.delta });
	});
	diffex.on("agent_end", (event) => record({ type: "agent_end", messages: event.messages }));
	diffex.on("agent_settled", () => record({ type: "settled" }));
}
