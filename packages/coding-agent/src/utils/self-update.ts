import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import type { SelfUpdateCommand } from "../config.ts";
import { spawnProcess } from "./child-process.ts";

const MAX_OUTPUT_LENGTH = 32 * 1024;

interface UpdateOutput {
	write(text: string): unknown;
	isTTY?: boolean;
	columns?: number;
}

export class SelfUpdateError extends Error {
	readonly output: string;

	constructor(message: string, output: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SelfUpdateError";
		this.output = output;
	}
}

/** Keep package-manager diagnostics actionable without deleting caches or user data. */
export function getSelfUpdateFailureHints(error: unknown): string[] {
	const message = error instanceof Error ? error.message : String(error);
	const output = error instanceof SelfUpdateError ? error.output : "";
	const details = `${message}\n${output}`;
	if (/\bENOTEMPTY\b/.test(details)) {
		return [
			"An interrupted npm update may have left a partial installation or backup. Retry the exact command below first.",
			"If ENOTEMPTY persists, move only the Diffex package directory or the exact .diffex-... backup reported by npm to a separate backup directory, then retry. Do not remove your npm prefix or ~/.diffex.",
		];
	}
	if (/\bEACCES\b|\bEPERM\b/.test(details)) {
		return [
			"The installation directory is not writable. Use the Node version manager or user-writable prefix that owns this installation; do not change permissions on unrelated packages.",
		];
	}
	if (/\bEBADENGINE\b|ERR_PNPM_UNSUPPORTED_ENGINE/.test(details)) {
		return [
			"Diffex requires Node.js 22.19.0 or newer. Check node --version and the Node installation used by your package manager, then retry.",
		];
	}
	if (/\bENOSPC\b/.test(details)) {
		return ["The download cache or installation disk is full. Free disk space and retry the exact command below."];
	}
	if (/ERR_PNPM_NO_GLOBAL_BIN_DIR/.test(details)) {
		return [
			"Run pnpm setup, open a new terminal so PNPM_HOME is on PATH, and retry using the same pnpm installation.",
		];
	}
	if (/ERR_PNPM_NO_MATCHING_VERSION|\bETARGET\b/.test(details)) {
		return [
			"The verified release is not available from your configured registry or mirror. Check its registry metadata and retry after the mirror refreshes; do not install an unverified version.",
		];
	}
	if (/\bEINTEGRITY\b|ERR_PNPM_TARBALL_INTEGRITY/.test(details)) {
		return [
			"Package integrity verification failed. Retry using a trusted registry or refreshed mirror; do not disable integrity checks.",
		];
	}
	if (
		/\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND)\b|ERR_PNPM_(?:META_FETCH_FAIL|FETCH_)/.test(details)
	) {
		return [
			"Check your network, proxy, and package registry, then retry the exact command below. An interrupted replacement may need the same command to repair it.",
		];
	}
	return [];
}

/** Native manager output in logs; one honest indeterminate activity line in terminals. */
export async function runSelfUpdate(
	command: SelfUpdateCommand,
	options: { stdout?: UpdateOutput; stderr?: UpdateOutput } = {},
): Promise<void> {
	const stdout = options.stdout ?? process.stdout;
	const stderr = options.stderr ?? process.stderr;
	for (const step of command.steps ?? [command]) {
		const manager = basename(step.command).replace(/\.(?:cmd|exe)$/i, "");
		// Configured wrappers and other managers retain inherited terminal semantics.
		const captureOutput = manager === "npm" || manager === "pnpm";
		const interactive = stdout.isTTY === true && process.env.TERM !== "dumb" && captureOutput;
		let output = "";
		let errorOutput = "";
		let standardOutput = "";
		let frame = 0;
		const started = Date.now();
		const render = () => {
			const frames = ["-", "\\", "|", "/"];
			const text = `  ${frames[frame++ % frames.length]} Downloading and installing with ${manager} (${Math.floor((Date.now() - started) / 1000)}s)`;
			stdout.write(`\r\u001b[2K${chalk.dim(text.slice(0, Math.max(1, (stdout.columns ?? 80) - 1)))}`);
		};
		if (interactive) render();
		else stdout.write(captureOutput ? `Downloading and installing with ${manager}...\n` : `Running ${manager}...\n`);
		const timer = interactive ? setInterval(render, 100) : undefined;
		let failure: unknown;
		try {
			await new Promise<void>((resolve, reject) => {
				const child = spawnProcess(step.command, step.args, {
					stdio: captureOutput ? ["inherit", "pipe", "pipe"] : "inherit",
					env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false" },
				});
				let interrupted: NodeJS.Signals | undefined;
				const forwardSignal = (signal: NodeJS.Signals) => {
					interrupted = signal;
					child.kill(signal);
				};
				const interrupt = () => forwardSignal("SIGINT");
				const terminate = () => forwardSignal("SIGTERM");
				process.on("SIGINT", interrupt);
				process.on("SIGTERM", terminate);
				const cleanup = () => {
					process.removeListener("SIGINT", interrupt);
					process.removeListener("SIGTERM", terminate);
				};
				const receive = (chunk: string, destination: UpdateOutput) => {
					const text = stripVTControlCharacters(chunk);
					output = (output + text).slice(-MAX_OUTPUT_LENGTH);
					if (destination === stderr) errorOutput = (errorOutput + text).slice(-MAX_OUTPUT_LENGTH);
					else standardOutput = (standardOutput + text).slice(-MAX_OUTPUT_LENGTH);
					if (!interactive) destination.write(chunk);
				};
				child.stdout?.setEncoding("utf8");
				child.stderr?.setEncoding("utf8");
				child.stdout?.on("data", (chunk: string) => receive(chunk, stdout));
				child.stderr?.on("data", (chunk: string) => receive(chunk, stderr));
				child.once("error", (error) => {
					cleanup();
					reject(new SelfUpdateError(`Could not start ${manager}: ${error.message}`, output, error));
				});
				child.once("close", (code, signal) => {
					cleanup();
					if (code === 0 && !interrupted) resolve();
					else
						reject(
							new SelfUpdateError(
								signal || interrupted
									? `${manager} terminated by signal ${signal ?? interrupted}`
									: `${manager} exited with code ${code ?? "unknown"}`,
								output,
							),
						);
				});
			});
		} catch (error) {
			failure = error;
		} finally {
			if (timer) clearInterval(timer);
			if (interactive) stdout.write("\r\u001b[2K");
		}
		if (interactive) {
			if (failure) stderr.write(`${output.trimEnd()}\n`);
			else {
				if (errorOutput) stderr.write(`${errorOutput.trimEnd()}\n`);
				const warnings = standardOutput
					.split(/\r?\n/)
					.filter((line) => /\bwarn(?:ing)?\b|deprecated|vulnerabilit|security/i.test(line));
				if (warnings.length) stderr.write(`${warnings.join("\n")}\n`);
			}
		}
		if (failure) throw failure;
	}
}
