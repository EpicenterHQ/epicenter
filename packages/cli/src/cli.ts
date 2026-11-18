/**
 * Dispatch commands, and send each checked app action to the home's serve,
 * which runs it. Every command ends in one answer, `{ data, error }`, which
 * `runCli` presents in one place (ADR-0953). Serve prints no answer while it
 * runs.
 */
import { ActionError, type Answer, Err, isName, Ok } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { checkCommand } from './check.ts';
import { COMMANDS, type Command, parseWords } from './commands.ts';
import { VERSION } from './engines.ts';
import { exportCommand } from './export.js';
import { discoverAll, loadHomeApp } from './home.ts';
import { serveHttp } from './http.ts';
import { initCommand } from './init.ts';
import { matchAction, readInput, usageLine } from './input.ts';
import {
	actionHelp,
	actionTool,
	homeListing,
	oneAppListing,
} from './listing.ts';
import { newCommand } from './new.ts';
import { presentAnswer, writeErr } from './output.ts';
import { repositoryStatus } from './repository.ts';
import { epicenterDir, epicenterRoot, RootUsageError } from './root.ts';
import { createRoutines } from './routines.ts';
import { sendToServe } from './serve-call.ts';

const HELP = `epicenter                              your apps, routines and repository
epicenter <app>                        what an app can do
epicenter <app> <action> [<input>]
${Object.values(COMMANDS)
	.map(({ usage }) => usage)
	.join('\n')}
epicenter --version

Uses the nearest Epicenter above the current folder, then EPICENTER_ROOT,
then ~/Epicenter. An Epicenter has EPICENTER.md.
An action's input is one JSON object, such as '{"title":"Call the bank"}',
or - to read it from stdin; null removes a field that takes it.
--json prints every command's answer as one JSON value, {"data": ..., "error": ...},
and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 failed, ran in part or may have run, 2 did not run.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

/**
 * What each command in `COMMANDS` does. Each answers once, and `runCli`
 * presents the answer. Serve answers only when it does not start; once it
 * has served, it answers nothing.
 */
const HANDLERS: {
	[K in Command]: (
		words: string[],
		json: boolean,
	) => Promise<Answer | undefined>;
} = {
	init: initCommand,
	new: newCommand,
	export: exportCommand,
	check: checkCommand,
	async serve(words, json) {
		if (json)
			return ActionError.NotStarted({
				cause: 'usage',
				message: 'serve prints no answer; --json does not apply',
				next: 'epicenter serve --help',
			});
		const { error } = parseWords('serve', words, {}, [0, 0]);
		if (error) return Err(error);
		return serveHttp(epicenterRoot().port);
	},
};

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	// --version is read only on its own; anywhere else it is a word the command refuses.
	const onlyGlobals = argv.every((token) => GLOBALS.has(token));
	const tokens: string[] = [];
	let json = false;
	let help = false;
	let version = false;
	let literal = false;
	for (const token of argv) {
		if (literal) tokens.push(token);
		else if (token === '--') {
			literal = true;
			tokens.push(token);
		} else if (token === '--json') json = true;
		else if (token === '--help' || token === '-h') help = true;
		else if ((token === '--version' || token === '-V') && onlyGlobals)
			version = true;
		else tokens.push(token);
	}
	// A throw after a command began is `Threw`; after an action call was sent, its outcome is unknown.
	let begun = false;
	let sent = false;
	async function answer(): Promise<Answer | undefined> {
		if (!tokens.length) {
			if (version)
				return Ok(json ? { version: VERSION } : `epicenter ${VERSION}`);
			if (help) return Ok(HELP);
			epicenterRoot();
			// A report only: it reads the home and starts, fetches and writes nothing.
			const [found, routines, repository] = await Promise.all([
				discoverAll(),
				createRoutines({ folder: epicenterDir() }).list(),
				repositoryStatus(epicenterDir()),
			]);
			return Ok(homeListing(found, { routines, repository }, json));
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (Object.hasOwn(HANDLERS, name)) {
			const command = name as Command;
			if (help)
				return Ok(`${COMMANDS[command].usage}\n${COMMANDS[command].help}`);
			if (command !== 'init') epicenterRoot();
			begun = true;
			return HANDLERS[command](words, json);
		}
		epicenterRoot();
		const { data: located, error: notLoaded } = await loadHomeApp(name);
		if (notLoaded) return Err(notLoaded);
		if (!words.length) return Ok(oneAppListing(located, json));
		const matched = matchAction(located.actions, words);
		const action = matched && located.actions[matched.key];
		if (!matched || !action) {
			// The words that could name an action: those before the input.
			const end = words.findIndex((word) => !isName(word));
			const asked = words.slice(0, end < 0 ? undefined : end).join(' ');
			return ActionError.NotStarted({
				cause: 'usage',
				message: `${name} has no action ${JSON.stringify(asked || words[0])}. Its actions:\n${Object.entries(
					located.actions,
				)
					.map(([key, each]) => usageLine(name, key, each))
					.join('\n')}`,
				next: `epicenter ${name}`,
			});
		}
		if (help)
			return Ok(
				json
					? actionTool(located.name, matched.key, action)
					: actionHelp(name, matched.key, action),
			);
		const given = await readInput(action, matched.rest);
		if ('error' in given)
			return ActionError.NotStarted({
				cause: 'usage',
				message: given.error,
				next: `epicenter ${name} ${matched.key} --help`,
			});
		// Each update is one line of JSON on stderr, as it arrives.
		const onUpdate = (value: unknown) => writeErr(JSON.stringify(value));
		// Serve runs every action; this process only sends the call.
		sent = true;
		return sendToServe(name, matched.key, given.input, onUpdate);
	}
	let answered: Answer | undefined;
	try {
		answered = await answer();
	} catch (cause) {
		const message = extractErrorMessage(cause);
		if (sent)
			answered = ActionError.Unreachable({
				message: `Epicenter invoked the action but could not report its outcome: ${message}`,
			});
		else if (cause instanceof RootUsageError)
			answered = ActionError.NotStarted({
				cause: 'usage',
				message,
				next: cause.next,
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
			`Epicenter invoked the action but could not report its outcome: ${extractErrorMessage(cause)}`,
		);
		return 1;
	}
}
