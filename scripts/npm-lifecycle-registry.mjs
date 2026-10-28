import { createHash } from "node:crypto";
import { createServer } from "node:http";

export function createLifecycleRegistry({ metadata, bytes, getMode, onArchive }) {
	const server = createServer((request, reply) => {
		// npm can do synchronous dependency graph work between metadata and archive requests.
		// Do not leave an idle socket available for reuse after the server's keep-alive deadline.
		reply.setHeader("connection", "close");
		const path = decodeURIComponent(request.url);
		const mode = getMode();
		if (path === `/${metadata.name}`) {
			const pkg = {
				...metadata,
				dist: {
					tarball: `http://127.0.0.1:${server.address().port}/diffex.tgz`,
					integrity: `sha512-${createHash("sha512")
						.update(mode === "corrupt" ? "wrong bytes" : bytes)
						.digest("base64")}`,
				},
			};
			reply.setHeader("content-type", "application/json");
			reply.end(
				JSON.stringify({
					name: metadata.name,
					"dist-tags": { latest: metadata.version },
					time: { [metadata.version]: "2020-01-01T00:00:00.000Z" },
					versions: { [metadata.version]: pkg },
				}),
			);
		} else if (path === "/diffex.tgz") {
			onArchive(mode, reply);
			// Interrupt at the request boundary, without sending headers or archive bytes.
			if (mode === "interrupt") return;
			reply.end(bytes);
		} else {
			reply.writeHead(404).end();
		}
	});
	return server;
}
