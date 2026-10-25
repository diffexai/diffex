import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { Agent, get } from "node:http";
import test from "node:test";
import { createLifecycleRegistry } from "./npm-lifecycle-registry.mjs";

const metadata = { name: "@diffexai/diffex", version: "1.2.3", description: "local fixture" };
const bytes = Buffer.from([0x1f, 0x8b, 0, 0xff, 0x0a, 0x80, 0x42]);
const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

async function fixture(t, getMode = () => "valid", onArchive = () => {}) {
	const server = createLifecycleRegistry({ metadata, bytes, getMode, onArchive });
	const agent = new Agent({ keepAlive: true, maxSockets: 1 });
	t.after(async () => {
		agent.destroy();
		server.closeAllConnections();
		await new Promise((done) => server.close(done));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return { server, agent, url: `http://127.0.0.1:${server.address().port}` };
}

async function request(url, agent) {
	let socket;
	let closed;
	const response = await new Promise((done, reject) => {
		const req = get(url, { agent }, (reply) => {
			const chunks = [];
			reply.on("data", (chunk) => chunks.push(chunk));
			reply.on("end", () => done({ status: reply.statusCode, headers: reply.headers, body: Buffer.concat(chunks) }));
			reply.on("error", reject);
		});
		req.on("socket", (value) => {
			socket = value;
			closed = once(socket, "close");
		});
		req.on("error", reject);
	});
	await closed;
	assert(socket.destroyed, "The server must close the socket, even with a keep-alive client");
	return { ...response, socket };
}

test("metadata and exact archive bytes use closed, distinct sockets", { timeout: 5000 }, async (t) => {
	let archiveRequests = 0;
	const { url, agent } = await fixture(t, undefined, (mode) => {
		assert.equal(mode, "valid");
		archiveRequests++;
	});
	const manifest = await request(`${url}/@diffexai%2fdiffex`, agent);
	assert.equal(manifest.status, 200);
	assert.equal(manifest.headers.connection, "close");
	assert.equal(manifest.headers["content-type"], "application/json");
	const parsed = JSON.parse(manifest.body);
	assert.deepEqual(parsed["dist-tags"], { latest: metadata.version });
	assert.equal(parsed.name, metadata.name);
	const pkg = parsed.versions[metadata.version];
	assert.deepEqual(pkg, { ...metadata, dist: { tarball: `${url}/diffex.tgz`, integrity } });
	assert.equal(archiveRequests, 0);
	const archive = await request(pkg.dist.tarball, agent);
	assert.equal(archive.status, 200);
	assert.equal(archive.headers.connection, "close");
	assert.deepEqual(archive.body, bytes);
	assert.notEqual(archive.socket, manifest.socket);
	assert.equal(archiveRequests, 1);
	const missing = await request(`${url}/missing`, agent);
	assert.equal(missing.status, 404);
	assert.equal(missing.headers.connection, "close");
});

test("corrupt mode changes only metadata integrity, never archive bytes", { timeout: 5000 }, async (t) => {
	let mode = "corrupt";
	const { url, agent } = await fixture(t, () => mode);
	const manifest = await request(`${url}/@diffexai/diffex`, agent);
	assert.equal(manifest.headers.connection, "close");
	const pkg = JSON.parse(manifest.body).versions[metadata.version];
	assert.equal(pkg.dist.integrity, `sha512-${createHash("sha512").update("wrong bytes").digest("base64")}`);
	assert.notEqual(pkg.dist.integrity, integrity);
	const archive = await request(pkg.dist.tarball, agent);
	assert.equal(archive.headers.connection, "close");
	assert.deepEqual(archive.body, bytes);
	mode = "valid";
	const repaired = await request(`${url}/@diffexai/diffex`, agent);
	assert.equal(JSON.parse(repaired.body).versions[metadata.version].dist.integrity, integrity);
});

test("interrupt callback runs before headers or body; cleanup closes the held request", { timeout: 5000 }, async (t) => {
	let reachBoundary;
	const boundary = new Promise((done) => {
		reachBoundary = done;
	});
	let callbacks = 0;
	const { server, url, agent } = await fixture(t, () => "interrupt", (mode, reply) => {
		assert.equal(mode, "interrupt");
		assert.equal(reply.getHeader("connection"), "close");
		assert.equal(reply.headersSent, false);
		assert.equal(reply.writableLength, 0);
		assert.equal(reply.writableEnded, false);
		callbacks++;
		reachBoundary(reply);
	});
	let receivedResponse = false;
	const req = get(`${url}/diffex.tgz`, { agent }, () => {
		receivedResponse = true;
	});
	const failed = once(req, "error");
	const closed = new Promise((done) => req.once("close", done));
	const reply = await boundary;
	assert.equal(callbacks, 1);
	assert.equal(reply.headersSent, false);
	assert.equal(reply.writableEnded, false);
	server.closeAllConnections();
	await new Promise((done) => server.close(done));
	const [error] = await failed;
	assert.equal(error.code, "ECONNRESET");
	await closed;
	assert.equal(receivedResponse, false);
	assert.equal(server.listening, false);
});
