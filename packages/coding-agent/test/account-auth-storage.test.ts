import { describe, expect, it, vi } from "vitest";
import {
	type DiffexAccountSession,
	KeyringDiffexAccountAuthStorage,
	type KeyringEntry,
} from "../src/core/account-auth-storage.ts";

const apiOrigin = "https://api.diffex.ai";
const session: DiffexAccountSession = {
	version: 1,
	apiOrigin,
	accessToken: "access_secret",
	refreshToken: "refresh_secret",
	tokenType: "Bearer",
	expiresAt: 1_800_000,
	context: { user: { id: "user-diffex-1" } },
};

function createFakeKeyring(initial: string | null = null) {
	let value = initial;
	const entry: KeyringEntry = {
		setPassword: vi.fn(async (password) => {
			value = password;
		}),
		getPassword: vi.fn(async () => value),
		deleteCredential: vi.fn(async () => {
			const existed = value !== null;
			value = null;
			return existed;
		}),
	};
	return { entry, value: () => value };
}

describe("Diffex account keyring storage", () => {
	it("stores, reads, and deletes the complete session as one keyring credential", async () => {
		const fake = createFakeKeyring();
		const createEntry = vi.fn(async () => fake.entry);
		const storage = new KeyringDiffexAccountAuthStorage(createEntry);

		expect(createEntry).not.toHaveBeenCalled();
		await storage.write(session);
		expect(JSON.parse(fake.value() ?? "{}")).toEqual(session);
		await expect(storage.read(apiOrigin)).resolves.toEqual(session);
		await storage.delete(apiOrigin);
		await expect(storage.read(apiOrigin)).resolves.toBeUndefined();
		expect(createEntry).toHaveBeenCalledWith("ai.diffex.cli", apiOrigin);
	});

	it("treats the native keyring's null result as a missing credential", async () => {
		const fake = createFakeKeyring(null);
		const storage = new KeyringDiffexAccountAuthStorage(() => fake.entry);

		await expect(storage.read(apiOrigin)).resolves.toBeUndefined();
	});

	it("rejects malformed keyring data without returning partial credentials", async () => {
		const fake = createFakeKeyring(JSON.stringify({ accessToken: "partial_secret" }));
		const storage = new KeyringDiffexAccountAuthStorage(() => fake.entry);

		await expect(storage.read(apiOrigin)).rejects.toThrow("Stored Diffex credentials are invalid");
	});

	it("reports a safe error when the native keyring cannot be loaded", async () => {
		const storage = new KeyringDiffexAccountAuthStorage(async () => {
			throw new Error("native loader detail");
		});

		await expect(storage.read(apiOrigin)).rejects.toThrow("Unable to read Diffex credentials from the OS keychain");
	});
});
