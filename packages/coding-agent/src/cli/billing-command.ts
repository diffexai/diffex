import { DiffexAccountAuthError, HostedDiffexAccountAuth } from "../core/diffex-account-auth.ts";

const help =
	"Usage: diffex billing <plans|status> [--json]\n\nRead confirmed organization billing using your Diffex account.\nSign in with /login in the interactive CLI first.\n";
type Client = Pick<HostedDiffexAccountAuth, "readBilling">;
type Output = { out: (text: string) => void; error: (text: string) => void };

/** Returns null when these arguments belong to the normal agent CLI. */
export async function runBillingCommand(
	args: string[],
	client?: Client,
	output: Output = {
		out: (text) => {
			process.stdout.write(text);
		},
		error: (text) => {
			process.stderr.write(text);
		},
	},
): Promise<number | null> {
	if (args[0] !== "billing") return null;
	if (args.length === 1 || (args.length === 2 && ["--help", "-h"].includes(args[1]))) {
		output.out(help);
		return 0;
	}
	const command = args[1];
	if (!["plans", "status"].includes(command) || args.length > 3 || (args.length === 3 && args[2] !== "--json")) {
		output.error(help);
		return 2;
	}
	try {
		const data = await (client ?? new HostedDiffexAccountAuth()).readBilling(
			command === "plans" ? "plans" : "subscription",
		);
		const result = parseBillingView(data, command);
		if (args[2] === "--json") output.out(`${JSON.stringify(result)}\n`);
		else if (result.plans !== undefined) {
			output.out(
				result.plans.length === 0
					? "No purchasable plans are available.\n"
					: result.plans.map((plan) => `${plan.key}@${plan.revision}: ${JSON.stringify(plan.name)}\n`).join(""),
			);
		} else {
			output.out(`Organization: ${result.organization_id}\n`);
			output.out(
				result.subscription
					? `Plan: ${result.subscription.plan_key}@${result.subscription.plan_revision}\nStatus: ${result.subscription.status}\nPeriod ends: ${result.subscription.current_period_ends_at ?? "Not available"}\nCancel at period end: ${result.subscription.cancel_at_period_end ? "yes" : "no"}\n`
					: "No current subscription.\n",
			);
		}
		return 0;
	} catch (error) {
		output.error(
			`${error instanceof DiffexAccountAuthError ? error.message : "The billing service returned an invalid response."}\n`,
		);
		return 1;
	}
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid record");
	return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
	if (typeof value !== "string" || value.length > 1000 || !pattern.test(value)) throw new Error("Invalid text");
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error("Invalid revision");
	return value;
}
const key = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function parseBillingView(value: unknown, command: string) {
	const body = record(value);
	if (command === "plans") {
		if (!Array.isArray(body.plans) || body.plans.length > 1000) throw new Error("Invalid plans");
		return {
			plans: body.plans.map((entry: unknown) => {
				const plan = record(entry);
				return {
					key: text(plan.key, key),
					revision: revision(plan.revision),
					name: text(plan.name, /^[^\p{Cc}]*$/u),
				};
			}),
		};
	}
	const organization_id = text(body.organization_id, uuid);
	if (body.subscription === null) return { organization_id, subscription: null };
	const sub = record(body.subscription),
		purchase = record(sub.purchase);
	if (typeof sub.cancel_at_period_end !== "boolean") throw new Error("Invalid cancellation");
	const ends =
		sub.current_period_ends_at === null
			? null
			: text(sub.current_period_ends_at, /^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/u);
	if (ends !== null && !Number.isFinite(Date.parse(ends))) throw new Error("Invalid period");
	return {
		organization_id,
		subscription: {
			id: text(sub.id, uuid),
			plan_key: text(purchase.plan_key, key),
			plan_revision: revision(purchase.plan_revision),
			status: text(sub.status, /^(?:pending|active|delinquent|paused)$/u),
			current_period_ends_at: ends,
			cancel_at_period_end: sub.cancel_at_period_end,
		},
	};
}
