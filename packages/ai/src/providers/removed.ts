/** Explain removed providers without loading their former integrations. */
export function getRemovedProviderMessage(providerId: string): string | undefined {
	return providerId.trim().toLowerCase() === "radius"
		? "Radius support has been removed. Remove its configuration and select another provider."
		: undefined;
}
