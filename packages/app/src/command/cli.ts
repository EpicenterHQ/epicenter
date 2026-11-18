/**
 * The `epicenter` command: a client of the Epicenter's serve, which alone loads
 * app code (ADR-0961). It finds its Epicenter once, by walking up, and sends
 * what it was typed: the listing feeds bare `epicenter` and `epicenter
 * <app>`, and the words after an app's name go to serve as they are, which
 * finds the action, reads the input, and runs it. `check` reads the apps in
 * this process; `serve` is the process. Every command ends in one answer,
 * `{ data, error }`, which `runCli` presents in one place (ADR-0953). Serve
 * prints no answer while it runs.
 */

import { realpathSync } from 'node:fs';
import { extractErrorMessage } from 'wellcrafted/error';
import packageJson from '../../package.json' with { type: 'json' };
import { ActionError, type Answer, Err, isName, Ok } from '../index.ts';
import { actionHelp, appReport, isActionTool, rootReport } from './listing.ts';
import { presentAnswer, writeErr } from './output.ts';
import { epicenterRoot } from './root.ts';
import { fetchListing, sendWords } from './send.ts';

/** The commands `epicenter` keeps for itself: each one's usage, and what its `--help` says beneath it. */
const CHECK = {
	usage: 'epicenter check [<app>] [--json]',
	help: `Reads every data key of every app, or one app's, and reports each file that
does not fit its key's fields. Each key shows how many files it holds and how
many have problems, then each file's problems. Many files with one kind of
problem usually mean the declaration is too narrow, not the files. It reads
only, and loads each app's code as it is on disk, so it tries changed code
before serve restarts. An app whose local/ has no .gitignore is listed with
the command that adds one. Exit 0 when nothing has a problem, 1 when a file
or an app has one, and 2 when a named app does not load.`,
};
const SERVE = {
	usage: 'epicenter serve',
	help: `Offers every app's actions over MCP at /, each app's UI at /<app>/, and each
action to its UI at POST /<app>/<action>, on 127.0.0.1 at the port in
EPICENTER.md (default 4747). It starts in the Epicenter's folder. An
Epicenter has one serve, and only serve loads app code: epicenter <app> and
bare epicenter ask it, and are refused while it is stopped. Each call runs
from the app's code as it is on disk then, to its end, and serve keeps
nothing about it. It runs the Epicenter's routines: a routines/<name>.md
declares cron: "0 8 * * *" and run: [executable, ...arguments], and once a
minute serve starts each routine whose schedule had an occurrence since its
last check. It records nothing about them, and epicenter on its own lists
them. Serve commits nothing: Git stores the Epicenter, and its owner commits
it. It has no sign-in and answers only this computer. To reach it from your
other devices, run a private proxy such as:
tailscale serve --bg 4747`,
};

const HELP = `epicenter                              your apps and routines
epicenter <app>                        what an app can do
epicenter <app> <action> [<input>]
${CHECK.usage}
${SERVE.usage}
epicenter --version

Acts on the Epicenter it runs in: the nearest folder at or above this one
that holds EPICENTER.md. serve starts in that folder, and every command but
check asks it.
An action's input is one JSON object, such as '{"title":"Call the bank"}',
or - to read it from stdin; null removes a field that takes it.
--json prints every command's answer as one JSON value, {"data": ..., "error": ...},
and --help (-h) explains anything; both go anywhere.
Exit codes: 0 done, 1 failed, ran in part or may have run, 2 did not run.`;

const usage = (message: string, next: string) =>
	ActionError.NotStarted({ cause: 'usage', message, next });

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	let json = false;
	let help = false;
	let version = false;
	const words: string[] = [];
	for (const token of argv) {
		if (token === '--json') json = true;
		else if (token === '--help' || token === '-h') help = true;
		else if (token === '--version' || token === '-V') version = true;
		else words.push(token);
	}
	// A throw after a command began is `Threw`; after an action call was sent, its outcome is unknown.
	let begun = false;
	let sent = false;
	async function answer(): Promise<Answer | undefined> {
		const [name, ...rest] = words;
		// No word starts with -: names are lowercase and an input is {...}, or - alone for stdin.
		const flag = words.find((word) => word.startsWith('-') && word !== '-');
		if (version && name !== undefined)
			return usage('--version stands alone', 'epicenter --help');
		if (name === 'check' || name === 'serve') {
			const command = name === 'check' ? CHECK : SERVE;
			if (help) return Ok(`${command.usage}\n${command.help}`);
			const misused = usage(
				`Usage: ${command.usage}`,
				`epicenter ${name} --help`,
			);
			if (flag || rest.length > (name === 'check' ? 1 : 0)) return misused;
			if (name === 'serve' && json)
				return usage(
					'serve prints no answer; --json does not apply',
					'epicenter serve --help',
				);
		} else if (flag)
			return usage(
				`${flag} is not an option; the options are --json, --help and --version`,
				'epicenter --help',
			);
		if (name === undefined) {
			if (version)
				return Ok(
					json
						? { version: packageJson.version }
						: `epicenter ${packageJson.version}`,
				);
			if (help) return Ok(HELP);
		}
		const { data: root, error: noRoot } = epicenterRoot();
		if (noRoot) return Err(noRoot);
		// check and serve load what the other commands do not, so only they import it.
		if (name === 'check') {
			const { checkCommand } = await import('./check.ts');
			begun = true;
			return checkCommand(root, rest[0], json);
		}
		if (name === 'serve') {
			// Bun reads .env from the folder a process starts in, so serve starts in the root's (ADR-0965).
			if (realpathSync(process.cwd()) !== root.folder)
				return usage(
					`serve starts in your Epicenter's folder, ${root.folder}`,
					`cd ${root.folder} && epicenter serve`,
				);
			const { serveHttp } = await import('./serve.ts');
			begun = true;
			return serveHttp(root);
		}
		// A word that is no name names no app, and would not reach POST /<app>: `..` is `/`.
		if (name !== undefined && !isName(name))
			return usage(`Unknown app "${name}"`, 'epicenter');
		if (name === undefined || !rest.length) {
			const { data: listing, error } = await fetchListing(root);
			if (error) return Err(error);
			return name === undefined
				? Ok(rootReport(listing, root, json))
				: appReport(listing, root, name, json);
		}
		if (help) {
			const { data: tool, error } = await sendWords(root, name, rest, {
				help: true,
			});
			if (error) return Err(error);
			if (!isActionTool(tool))
				return ActionError.Unreachable({
					message: 'serve sent an invalid action',
				});
			return Ok(json ? tool : actionHelp(tool));
		}
		// Only this process can read its stdin, so it reads `-` and sends the text.
		const typed =
			rest.at(-1) === '-'
				? [...rest.slice(0, -1), await Bun.stdin.text()]
				: rest;
		// Each update is one line of JSON on stderr, as it arrives.
		const onUpdate = (value: unknown) => writeErr(JSON.stringify(value));
		// Serve runs every action; this process only sends the call.
		sent = true;
		return sendWords(root, name, typed, { help: false, onUpdate });
	}
	let answered: Answer | undefined;
	try {
		answered = await answer();
	} catch (cause) {
		const message = extractErrorMessage(cause);
		if (sent)
			answered = ActionError.Unreachable({
				message: `serve took the action, but its outcome could not be reported: ${message}`,
			});
		else if (begun) answered = ActionError.Threw({ message });
		else answered = ActionError.NotStarted({ cause: 'internal', message });
	}
	if (answered === undefined) return 0;
	try {
		return presentAnswer(answered, json);
	} catch (cause) {
		if (!sent) throw cause;
		// Stdout may be what failed, so nothing more goes there.
		writeErr(
			`serve took the action, but its outcome could not be reported: ${extractErrorMessage(cause)}`,
		);
		return 1;
	}
}
