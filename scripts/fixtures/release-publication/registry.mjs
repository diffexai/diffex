import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

// Only the child publisher loads this fixture. Never contact npm or a provider.
const fixture = JSON.parse(readFileSync(process.env.DIFFEX_PUBLICATION_FIXTURE, "utf8"));
const deny = () => {
	throw new Error("Unmocked network access in publication fixture");
};
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
syncBuiltinESMExports();
let now = Date.now();
Date.now = () => {
	now += 11 * 60 * 1000;
	return now;
};
globalThis.fetch = async (input, options) => {
	const url = new URL(input);
	if (url.origin === "https://registry.npmjs.org") {
		const pkg = fixture.packages.find((pkg) => url.pathname === `/${encodeURIComponent(pkg.name)}/${pkg.version}`);
		if (!pkg || options?.method === "HEAD") throw new Error("Unexpected registry request");
		if (fixture.failure === "package" && pkg.name === fixture.packages.at(-1).name)
			return new Response(null, { status: 404 });
		return Response.json({
			name: pkg.name,
			version: pkg.version,
			dist: {
				tarball: `https://tarballs.example.invalid/${encodeURIComponent(pkg.name)}/${pkg.version}.tgz`,
				integrity: `sha512-${"A".repeat(86)}==`,
			},
		});
	}
	if (url.origin === "https://tarballs.example.invalid" && options?.method === "HEAD") {
		return new Response(null, { status: fixture.failure === "tarball" ? 503 : 200 });
	}
	throw new Error("Unexpected publication fixture request");
};
