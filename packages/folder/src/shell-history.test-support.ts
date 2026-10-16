/**
 * The Epicenter shell's history commands, answered in this process, for
 * tests and stand-ins that have no shell. The desktop app runs each as one
 * `epicenter` child (`apps/epicenter/src-tauri/src/history.rs`); here the
 * same engine, `runHistory`, runs with the CLI's own author.
 */

import { type HistoryOptions, historyExitCode, runHistory } from './bun.js';
import { GitMissingError } from './git/native-host.js';
import {
	decodeHistory,
	encodeHistory,
	type HistoryRequest,
} from './history-wire.js';

/** One history command of the Epicenter shell, with the arguments a page sends. */
export type ShellHistoryCommand =
	| { readonly command: 'status' }
	| { readonly command: 'history'; readonly depth: number }
	| { readonly command: 'save_version'; readonly message: string | null }
	| {
			readonly command: 'sync';
			readonly remote: string | null;
			readonly allowUnrelated: boolean;
	  }
	| {
			readonly command: 'settle_sync';
			readonly attempt: string;
			/** The choices in the history encoding, as the page sends them. */
			readonly choices: string;
	  };

/** The request a shell history command makes of the CLI. */
export function historyRequestOf(shell: ShellHistoryCommand): HistoryRequest {
	switch (shell.command) {
		case 'status':
			return { op: 'status' };
		case 'history':
			return { op: 'log', depth: shell.depth };
		case 'save_version':
			return { op: 'saveVersion', message: shell.message ?? undefined };
		case 'sync':
			return {
				op: 'sync',
				connect: shell.remote ?? undefined,
				allowUnrelatedHistories: shell.allowUnrelated,
			};
		case 'settle_sync':
			return {
				op: 'settle',
				attempt: shell.attempt,
				choices: decodeHistory(shell.choices),
			};
	}
}

/** Who the CLI commits as where Git's configuration names nobody. */
const CLI_AUTHOR = { name: 'Epicenter', email: 'epicenter@localhost' };

/**
 * What the shell answers a page for `shell`, run in this process: the
 * `epicenter` child's exit code and reply line, as the CLI prints it.
 */
export async function answerShellHistory(
	root: string,
	shell: ShellHistoryCommand,
	options: Partial<HistoryOptions> = {},
): Promise<{ code: number; reply: string | null; stderr: string }> {
	try {
		const reply = await runHistory(root, historyRequestOf(shell), {
			author: CLI_AUTHOR,
			...options,
		});
		return {
			code: historyExitCode(reply),
			reply: encodeHistory(reply),
			stderr: '',
		};
	} catch (cause) {
		if (cause instanceof GitMissingError)
			return {
				code: 2,
				reply: encodeHistory({
					error: 'GitMissing',
					message: cause.message,
					install: cause.install,
				}),
				stderr: cause.message,
			};
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			code: 2,
			reply: encodeHistory({ error: message }),
			stderr: message,
		};
	}
}
