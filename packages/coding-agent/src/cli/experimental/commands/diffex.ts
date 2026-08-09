import type { Args } from "../../args.ts";
import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

export interface DiffexCommand {
	readonly command: "diffex";
	readonly auth?: AuthInput;
	readonly options: Args;
	readonly listen?: readonly TransportAddress[];
}

export interface DiffexCommandContext {
	runDiffex(command: DiffexCommand): void | Promise<void>;
}

const listenOption = transportOption("--listen");

export const diffexCommand = new Command<DiffexCommand, DiffexCommandContext>("diffex")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { options, errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors];
		if (options.unknownFlags.has("connect")) errors.push("--connect is only valid for client mode");
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "diffex",
				options,
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	.action((command, context) => context.runDiffex(command));
