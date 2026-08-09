#!/usr/bin/env node
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.DIFFEX_CODING_AGENT = "true";
process.env.AI_AGENT = "diffex";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
