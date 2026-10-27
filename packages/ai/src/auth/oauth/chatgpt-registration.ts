import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ChatGPTRegistration {
	clientId: string;
	subject?: string;
	email?: string;
	idToken?: string;
	scopes?: string[];
}

/** Registration metadata survives logout; renewable tokens live in the credential store. */
export class ChatGPTRegistrationStore {
	private readonly directory: string;

	constructor() {
		const configured = process.env.DIFFEX_CODING_AGENT_DIR;
		const directory = configured?.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
		this.directory = join(directory || join(homedir(), ".diffex", "agent"), "chatgpt");
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
	}

	hostId(): string {
		const path = join(this.directory, "host");
		const temporary = join(this.directory, `${randomUUID()}.tmp`);
		// Publish a complete file exclusively when processes first sign in concurrently.
		writeFileSync(temporary, `urn:uuid:${randomUUID()}`, { mode: 0o600, flag: "wx" });
		try {
			try {
				linkSync(temporary, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const host = readFileSync(path, "utf8").trim();
			if (!/^urn:uuid:[0-9a-f-]{36}$/.test(host)) throw new Error("Invalid saved ChatGPT host identity");
			return host;
		} finally {
			unlinkSync(temporary);
		}
	}

	list(): ChatGPTRegistration[] {
		return readdirSync(this.directory)
			.filter((name) => name.endsWith(".json"))
			.map((name) => {
				const value = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as ChatGPTRegistration;
				if (
					!/^oaiapp_[\w-]+$/.test(value.clientId) ||
					(value.subject !== undefined && (typeof value.subject !== "string" || !value.subject)) ||
					(value.email !== undefined && typeof value.email !== "string") ||
					(value.idToken !== undefined && typeof value.idToken !== "string") ||
					(value.scopes !== undefined &&
						(!Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string")))
				) {
					throw new Error("Invalid saved ChatGPT registration");
				}
				return value;
			});
	}

	save(registration: ChatGPTRegistration): void {
		if (!/^oaiapp_[\w-]+$/.test(registration.clientId)) throw new Error("Invalid issued ChatGPT client ID");
		const temporary = join(this.directory, `${randomUUID()}.tmp`);
		try {
			writeFileSync(temporary, JSON.stringify(registration), { mode: 0o600, flag: "wx" });
			renameSync(temporary, join(this.directory, `${registration.clientId}.json`));
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}
