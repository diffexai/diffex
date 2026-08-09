export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.DIFFEX_EXPERIMENTAL === "1";
}
