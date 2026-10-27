/** A provider confirmed that this renewable session cannot be used again. */
export class OAuthSessionExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthSessionExpiredError";
	}
}
