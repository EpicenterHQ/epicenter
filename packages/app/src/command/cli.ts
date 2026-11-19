/**
 * The `epicenter` command: a client of the Epicenter's serve, which alone loads
 * app code (ADR-0961). It finds its Epicenter once, by walking up. The
 * listing feeds bare `epicenter`, `epicenter <app>` and an action's
 * `--help`; a call goes to serve as a page's does, with the action's name
 * and the input as typed, and serve reads the input and runs the action.
 * `serve` is the process. Every command ends in one answer,
 * `{ data, error }`, which `runCli` presents in one place (ADR-0953). Serve
 * prints no answer while it runs.
 */

import { realpathSync } from 'node:fs';
import { extractErrorMessage } from 'wellcrafted/error';
import packageJson from '../../package.json' with { type: 'json' };
import { ActionError, type Answer, Err, isName, Ok } from '../index.ts';
import { presentAnswer, writeErr } from './output.ts';
import { unknownApp } from './protocol.ts';
import { appReport, helpReport, missingAction, rootReport } from './report.ts';
import { epicenterRoot } from './root.ts';
import { callAction, fetchListing } from './send.ts';

/** The commands `epicenter` keeps for itself: each one's usage, and what its `--help` says beneath it. */
const SERVE = {
	usage: 'epicenter serve',
	help: `Offers every app's actions over MCP at /, each app at /apps/<app>/ (its
built UI, then its fetch), and each action at POST /actions/<app>/<action>,
on 127.0.0.1 at the port EPICENTER.md
names, which every Epicenter must. It starts in the Epicenter's folder. An
Epicenter has one serve, and only serve loads app code: epicenter <app> and
bare epicenter ask it, and are refused while it is stopped. Serve loads every
app, AGENTS.md and routines/ once, when it starts, and runs each call to its
end from that load, keeping nothing about it. Restart serve after editing an
app's code. It runs the
Epicenter's routines: a routines/<name>.md
declares cron: "0 8 * * *", action: "<app> <action>" and an optional
input: {...}. Serve reads them when it starts, refuses one whose action or
input does not fit, and once a minute runs each routine whose schedule had
an occurrence since its last check, as a call. epicenter on its own lists
them. Serve commits nothing: Git stores the Epicenter, and its owner commits
it. It has no sign-in and answers only this computer. To reach it from your
other devices, run a private proxy such as:
tailscale serve --bg 4747`,
};

const HELP = `epicenter                              your apps and routines
epicenter <app>                        what an app can do
epicenter <app> <action> [<input>]
${SERVE.usage}
epicenter --version

Acts on the Epicenter it runs in: the nearest folder at or above this one
that holds EPICENTER.md. serve starts in that folder, and every other
command asks it.
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
		const [app, ...rest] = words;
		// No word starts with -: names are lowercase and an input is {...}, or - alone for stdin.
		const flag = words.find((word) => word.startsWith('-') && word !== '-');
		if (version && app !== undefined)
			return usage('--version stands alone', 'epicenter --help');
		if (app === 'serve') {
			if (help) return Ok(`${SERVE.usage}\n${SERVE.help}`);
			if (flag || rest.length)
				return usage(`Usage: ${SERVE.usage}`, 'epicenter serve --help');
			if (json)
				return usage(
					'serve prints no answer; --json does not apply',
					'epicenter serve --help',
				);
		} else if (flag)
			return usage(
				`${flag} is not an option; the options are --json, --help and --version`,
				'epicenter --help',
			);
		if (app === undefined) {
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
		// serve loads what the other commands do not, so only it imports it.
		if (app === 'serve') {
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
		// A word that is no name names no app, and would not reach POST /actions/<app>/<action>: `..` is `/`.
		if (app !== undefined && !isName(app)) return unknownApp(app);
		if (app === undefined || !rest.length) {
			const { data: listing, error } = await fetchListing(root);
			if (error) return Err(error);
			return app === undefined
				? Ok(rootReport(listing, root, json))
				: appReport(listing, root, app, json);
		}
		// The action is one name; the input after it is {...} or -, never one.
		const [action = '', ...after] = rest;
		if (!isName(action))
			return usage(
				`Name an action of ${app} before its input`,
				`epicenter ${app}`,
			);
		if (help) {
			const { data: listing, error } = await fetchListing(root);
			if (error) return Err(error);
			return helpReport(listing, app, action, json);
		}
		if (after.length > 1)
			return usage(
				'The input is one argument, a JSON object; quote it whole',
				`epicenter ${app} ${action} --help`,
			);
		// Only this process can read its stdin, so it reads `-` and sends the text.
		const [typed = '{}'] = after;
		const input = typed === '-' ? await Bun.stdin.text() : typed;
		// Each update is one line of JSON on stderr, as it arrives.
		const onUpdate = (value: unknown) => writeErr(JSON.stringify(value));
		// Serve reads the input and runs the action; this process only sends the call.
		sent = true;
		const answered = await callAction(root, app, action, input, onUpdate);
		// Serve's refusal of a missing action carries the app's actions; the command lists them as commands.
		const actions = (answered.error as { actions?: string[] } | null)?.actions;
		return actions ? missingAction(app, action, actions) : answered;
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
