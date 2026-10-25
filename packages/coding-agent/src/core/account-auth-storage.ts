const KEYRING_SERVICE = "ai.diffex.cli";

export interface DiffexAccountSession {
	version: 1;
	apiOrigin: string;
	accessToken: string;
	refreshToken: string;
	tokenType: "Bearer";
	expiresAt: number;
	context?: Record<string, unknown>;
}

export interface DiffexAccountAuthStorage {
	read(apiOrigin: string, signal?: AbortSignal): Promise<DiffexAccountSession | undefined>;
	write(session: DiffexAccountSession, signal?: AbortSignal): Promise<void>;
	delete(apiOrigin: string, signal?: AbortSignal): Promise<void>;
}

export interface KeyringEntry {
	setPassword(password: string, signal?: AbortSignal): Promise<void>;
	getPassword(signal?: AbortSignal): Promise<string | null>;
	deleteCredential(signal?: AbortSignal): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry | Promise<KeyringEntry>;

export class DiffexAccountStorageError extends Error {
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "DiffexAccountStorageError";
	}
}

export class KeyringDiffexAccountAuthStorage implements DiffexAccountAuthStorage {
	readonly #createEntry: KeyringEntryFactory;

	constructor(createEntry: KeyringEntryFactory = createNativeKeyringEntry) {
		this.#createEntry = createEntry;
	}

	async read(apiOrigin: string, signal?: AbortSignal): Promise<DiffexAccountSession | undefined> {
		try {
			const entry = await this.#entry(apiOrigin);
			const stored = await entry.getPassword(signal);
			return stored === null ? undefined : parseStoredSession(stored, apiOrigin);
		} catch (error) {
			if (isMissingCredentialError(error)) return undefined;
			if (error instanceof DiffexAccountStorageError) throw error;
			throw new DiffexAccountStorageError("Unable to read Diffex credentials from the OS keychain", error);
		}
	}

	async write(session: DiffexAccountSession, signal?: AbortSignal): Promise<void> {
		validateSession(session, session.apiOrigin);
		try {
			const entry = await this.#entry(session.apiOrigin);
			await entry.setPassword(JSON.stringify(session), signal);
		} catch (error) {
			if (error instanceof DiffexAccountStorageError) throw error;
			throw new DiffexAccountStorageError("Unable to save Diffex credentials in the OS keychain", error);
		}
	}

	async delete(apiOrigin: string, signal?: AbortSignal): Promise<void> {
		try {
			const entry = await this.#entry(apiOrigin);
			await entry.deleteCredential(signal);
		} catch (error) {
			if (isMissingCredentialError(error)) return;
			if (error instanceof DiffexAccountStorageError) throw error;
			throw new DiffexAccountStorageError("Unable to remove Diffex credentials from the OS keychain", error);
		}
	}

	async #entry(apiOrigin: string): Promise<KeyringEntry> {
		return this.#createEntry(KEYRING_SERVICE, apiOrigin);
	}
}

async function createNativeKeyringEntry(service: string, account: string): Promise<KeyringEntry> {
	try {
		const { AsyncEntry } = await import("@napi-rs/keyring");
		return new AsyncEntry(service, account);
	} catch (error) {
		throw new DiffexAccountStorageError(
			"OS keychain support is unavailable for Diffex account authentication",
			error,
		);
	}
}

function parseStoredSession(value: string, apiOrigin: string): DiffexAccountSession {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		throw new DiffexAccountStorageError("Stored Diffex credentials are invalid", error);
	}
	return validateSession(parsed, apiOrigin);
}

function validateSession(value: unknown, apiOrigin: string): DiffexAccountSession {
	if (!isRecord(value)) throw new DiffexAccountStorageError("Stored Diffex credentials are invalid");
	if (
		value.version !== 1 ||
		value.apiOrigin !== apiOrigin ||
		typeof value.accessToken !== "string" ||
		value.accessToken.length === 0 ||
		typeof value.refreshToken !== "string" ||
		value.refreshToken.length === 0 ||
		value.tokenType !== "Bearer" ||
		typeof value.expiresAt !== "number" ||
		!Number.isFinite(value.expiresAt) ||
		(value.context !== undefined && !isRecord(value.context))
	) {
		throw new DiffexAccountStorageError("Stored Diffex credentials are invalid");
	}

	return {
		version: 1,
		apiOrigin,
		accessToken: value.accessToken,
		refreshToken: value.refreshToken,
		tokenType: "Bearer",
		expiresAt: value.expiresAt,
		...(value.context === undefined ? {} : { context: value.context }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingCredentialError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const normalized = error.message.toLowerCase();
	return normalized.includes("noentry") || normalized.includes("no entry");
}
