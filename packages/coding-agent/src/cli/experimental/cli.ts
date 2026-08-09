import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type DiffexCommandContext, diffexCommand } from "./commands/diffex.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

export type ExperimentalCliContext = DiffexCommandContext & ServerCommandContext & ClientCommandContext;

export const experimentalCli = diffexCommand.command(serverCommand).command(clientCommand);
