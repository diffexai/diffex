import { Socket } from "node:net";
import { syncBuiltinESMExports } from "node:module";
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
	const options = Array.isArray(args[0]) ? args[0][0] : args[0];
	const host = typeof options === "object" ? options.host : args[1];
	if (host !== "127.0.0.1" && host !== "::1") throw new Error("Artifact acceptance blocked non-loopback socket");
	return connect.apply(this, args);
};
globalThis.fetch = async () => {
	throw new Error("Artifact acceptance blocked fetch");
};
syncBuiltinESMExports();
