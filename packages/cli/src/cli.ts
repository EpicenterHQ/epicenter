/**
 * The epicenter command runs apps from the selected Epicenter
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its exit code is 0 when the action returned, 1 when it threw, and 2
 * when nothing ran (ADR-0867). A call that wrote commits everything pending
 * in data, named for the call (ADR-0850); a commit that fails changes neither the
 * answer nor the exit code: why, and its next step, go to stderr, and the
 * paths stay pending.
 */
import { join } from 'node:path';
import { isName } from '@epicenter/app';
import { buildCommand } from './build.ts';
import {
	BAD_PORT,
	COMMANDS,
	type Command,
	misuse,
	parseWords,
	portOf,
} from './commands.ts';
import { codeStateOf } from './data.ts';
import { VERSION } from './engines.ts';
import { CliError } from './errors.ts';
import { historyCommand, undoCommand } from './history.ts';
import { discoverAll, loadHomeApp } from './home.ts';
import { serveHttp } from './http.ts';
import { initCommand } from './init.ts';
import { matchAction, readInput, usageLine } from './input.ts';
import { installCommand } from './install.ts';
import {
	actionHelp,
	actionTool,
	homeListing,
	oneAppListing,
} from './listing.ts';
import { newCommand } from './new.ts';
import {
	fail,
	presentAnswer,
	printingToStderr,
	writeErr,
	writeJson,
	writeOut,
} from './output.ts';
import { appsDir, epicenterRoot, RootUsageError } from './root.ts';
import { runAction } from './run.ts';
import { serviceCommand } from './service.ts';
import { appStatusOf } from './snapshot.ts';
import { syncCommand } from './sync.ts';
import { updateCommand } from './update.ts';

const HELP = `epicenter                              your apps
epicenter <app>                        what an app can do
epicenter <app> <action> [<positionals>] [--flags]
${Object.values(COMMANDS)
	.map(({ usage }) => usage)
	.join('\n')}
epicenter --version

Uses the nearest Epicenter above the current folder, then EPICENTER_ROOT,
then ~/Epicenter. An Epicenter has EPICENTER.md.
A flag's value is read as its field's type; null removes a field that takes it.
--input <json> gives an action's whole input as one JSON object; - reads it from stdin.
--json prints one JSON answer, and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 threw or an app did not sync, 2 did not run.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	init: initCommand,
	install: installCommand,
	new: newCommand,
	update: updateCommand,
	build: buildCommand,
	sync: syncCommand,
	history: historyCommand,
	undo: undoCommand,
	service: serviceCommand,
	async serve(words, json) {
		if (json)
			return fail(
				misuse('serve', 'serve prints no answer; --json does not apply'),
				json,
			);
		const given = parseWords(
			words,
			{ port: { type: 'string' }, host: { type: 'string' } },
			[0, 0],
		);
		if (!given) return fail(misuse('serve'), json);
		const { port, host } = given.values;
		const root = epicenterRoot();
		const listen = port === undefined ? root.port : portOf(port);
		if (listen === undefined) return fail(misuse('serve', BAD_PORT), json);
		return serveHttp(host ?? '127.0.0.1', listen);
	},
};

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	// --version is read only on its own, so an action's --version stays its own flag.
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
	const print = (value: unknown) => {
		if (json) writeJson(value);
		else writeOut(String(value));
	};
	try {
		if (!tokens.length) {
			if (version) print(json ? { version: VERSION } : `epicenter ${VERSION}`);
			else if (help) print(HELP);
			else {
				const found = await discoverAll();
				const histories = new Map(
					await Promise.all(
						found.apps.map(
							async (app) =>
								[app.name, await appStatusOf(app.realPath)] as const,
						),
					),
				);
				print(homeListing(found, json, histories));
			}
			return 0;
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (Object.hasOwn(HANDLERS, name)) {
			const command = name as keyof typeof HANDLERS;
			if (help) {
				print(`${COMMANDS[command].usage}\n${COMMANDS[command].help}`);
				return 0;
			}
			if (command !== 'init' && command !== 'service') epicenterRoot();
			return HANDLERS[command](words, json);
		}
		epicenterRoot();
		// The code a call ran is the code before loading it: an epicenter.ts may move HEAD as it loads.
		const code =
			words.length > 0 && !help && isName(name)
				? await codeStateOf(join(appsDir(), name))
				: { dirty: false };
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return fail(notFound, json);
		if (!located.ok)
			return fail(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
				json,
			);
		if (!words.length) {
			print(oneAppListing(located, json, await appStatusOf(located.realPath)));
			return 0;
		}
		const matched = matchAction(located.actions, words);
		const action = matched && located.actions[matched.key];
		if (!matched || !action) {
			// The words that could name an action: those before the first value or flag.
			const end = words.findIndex((word) => !isName(word));
			const asked = words.slice(0, end < 0 ? undefined : end).join(' ');
			return fail(
				CliError.Usage({
					message: `${name} has no action ${JSON.stringify(asked || words[0])}. Its actions:\n${Object.entries(
						located.actions,
					)
						.map(([key, each]) => usageLine(name, key, each, { short: true }))
						.join('\n')}`,
					next: `epicenter ${name}`,
				}).error,
				json,
			);
		}
		if (help) {
			print(
				json
					? actionTool(located.name, matched.key, action)
					: actionHelp(name, matched.key, action),
			);
			return 0;
		}
		const next = `epicenter ${name} ${matched.key} --help`;
		const given = await readInput(action, matched.rest);
		if ('error' in given)
			return fail(CliError.Usage({ message: given.error, next }).error, json);
		// What the action prints goes to stderr, so stdout holds only the answer.
		const { answer, committed } = await printingToStderr(() =>
			runAction(located, matched.key, action, given.input, code),
		);
		if (committed && 'failed' in committed)
			writeErr(
				`${name}: not yet in history: ${committed.failed.message}\nRun: ${committed.failed.next ?? `epicenter sync ${name}`}`,
			);
		return presentAnswer(answer, json);
	} catch (error) {
		if (error instanceof RootUsageError)
			return fail(
				CliError.Usage({ message: error.message, next: error.next }).error,
				json,
			);
		return fail(CliError.Internal({ cause: error }).error, json);
	}
}
