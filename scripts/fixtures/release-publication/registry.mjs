import { integrity } from "../../release-registry.mjs";
import { readFileSync, writeFileSync } from "node:fs";
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
	if (options?.redirect !== "error") throw new Error("Registry and tarballs must reject redirects");
	const state = JSON.parse(readFileSync(process.env.DIFFEX_PUBLICATION_STORAGE, "utf8"));
	state.registryCalls ??= [];
	state.registryCalls.push({ url: url.href, method: options?.method ?? "GET" });
	writeFileSync(process.env.DIFFEX_PUBLICATION_STORAGE, JSON.stringify(state));
	if (url.origin !== "https://registry.npmjs.org") throw new Error("Unexpected publication fixture origin");
	const inventory = fixture.packages.find((pkg) => url.pathname === `/${encodeURIComponent(pkg.name)}`);
	if (inventory) {
		if (fixture.missing && !state.published?.includes(inventory.name)) return new Response(null, { status: 404 });
		return Response.json({
			name: inventory.name,
			"dist-tags": {
				...(state.bootstrap?.includes(inventory.name)
					? { bootstrap: fixture.wrongBootstrap ? "0.0.1" : inventory.version }
					: {}),
				...(state.automaticLatest?.[inventory.name] ? { latest: state.automaticLatest[inventory.name] } : {}),
				...(fixture.latest ? { latest: fixture.latest } : {}),
			},
		});
	}
	const pkg = fixture.packages.find((pkg) => url.pathname === `/${encodeURIComponent(pkg.name)}/${pkg.version}`);
	if (pkg) {
		if (
			(fixture.failure === "package" && pkg.name === fixture.packages.at(-1).name) ||
			(fixture.missing && !state.published?.includes(pkg.name))
		)
			return new Response(null, { status: 404 });
		return Response.json({
			name: pkg.name,
			version: pkg.version,
			dist: {
				tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`,
				integrity:
					fixture.failure === "integrity" ? integrity("wrong bytes") : integrity(`approved ${pkg.name}@${pkg.version}`),
			},
		});
	}
	const artifact = fixture.packages.find(
		(pkg) => url.pathname === `/${pkg.name}/-/${pkg.name.split("/").pop()}-${pkg.version}.tgz`,
	);
	if (!artifact || options?.method === "HEAD")
		throw new Error("Unexpected tarball request: downloaded bytes are required");
	return new Response(
		fixture.failure === "bytes" ? "different public bytes" : `approved ${artifact.name}@${artifact.version}`,
		{ status: fixture.failure === "tarball" ? 503 : 200 },
	);
};
