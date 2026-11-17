/** Dispatch commands and run checked app actions; actions leave their writes pending. */
import { isName } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { buildCommand } from './build.ts';
import { checkCommand } from './check.ts';
import { checkpoint, renderCheckpoint } from './checkpoint.ts';
import { COMMANDS, type Command, misuse, parseWords } from './commands.ts';
import { VERSION } from './engines.ts';
import { CliError } from './errors.ts';
import { exportCommand } from './export.js';
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
	refused,
	writeErr,
	writeJson,
	writeOut,
} from './output.ts';
import { epicenterDir, epicenterRoot, RootUsageError } from './root.ts';
import { routinesCommand } from './routines.ts';
import { runAction } from './run.ts';
import { serviceCommand } from './service.ts';

const HELP = `epicenter                              your apps
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
--json prints one JSON answer, and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 ran with a failure or an unfinished export or checkpoint, 2 did not run.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	init: initCommand,
	install: installCommand,
	new: newCommand,
	export: exportCommand,
	build: buildCommand,
	check: checkCommand,
	service: serviceCommand,
	routines: routinesCommand,
	async checkpoint(words, json) {
		const given = parseWords(
			words,
			{ message: { type: 'string', short: 'm' } },
			[0, 0],
		);
		if (!given) return fail(misuse('checkpoint'), json);
		const result = await checkpoint(epicenterDir(), {
			message: given.values.message,
		});
		if (json) writeJson(result);
		else writeOut(renderCheckpoint(result));
		return result.deferred || result.failed || result.pushFailed ? 1 : 0;
	},
	async serve(words, json) {
		if (json)
			return fail(
				misuse('serve', 'serve prints no answer; --json does not apply'),
				json,
			);
		if (!parseWords(words, {}, [0, 0])) return fail(misuse('serve'), json);
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
	const actionRequest =
		tokens.length > 1 && !help && !Object.hasOwn(HANDLERS, tokens[0]!);
	const reject = (error: CliError) =>
		actionRequest ? presentAnswer(refused(error), json) : fail(error, json);
	const print = (value: unknown) => {
		if (json) writeJson(value);
		else writeOut(String(value));
	};
	let invoked = false;
	try {
		if (!tokens.length) {
			if (version) print(json ? { version: VERSION } : `epicenter ${VERSION}`);
			else if (help) print(HELP);
			else {
				epicenterRoot();
				const found = await discoverAll();
				print(homeListing(found, json));
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
			if (
				command !== 'init' &&
				command !== 'service' &&
				command !== 'checkpoint'
			)
				epicenterRoot();
			return await HANDLERS[command](words, json);
		}
		epicenterRoot();
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return reject(notFound);
		if (!located.ok)
			return reject(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
			);
		if (!words.length) {
			print(oneAppListing(located, json));
			return 0;
		}
		const matched = matchAction(located.actions, words);
		const action = matched && located.actions[matched.key];
		if (!matched || !action) {
			// The words that could name an action: those before the input.
			const end = words.findIndex((word) => !isName(word));
			const asked = words.slice(0, end < 0 ? undefined : end).join(' ');
			return reject(
				CliError.Usage({
					message: `${name} has no action ${JSON.stringify(asked || words[0])}. Its actions:\n${Object.entries(
						located.actions,
					)
						.map(([key, each]) => usageLine(name, key, each))
						.join('\n')}`,
					next: `epicenter ${name}`,
				}).error,
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
			return reject(CliError.Usage({ message: given.error, next }).error);
		// What the action prints goes to stderr, so stdout holds only the answer.
		invoked = true;
		// Each update is one line of JSON on stderr, as it arrives.
		const answer = await printingToStderr(() =>
			runAction(located, matched.key, action, given.input, {
				onUpdate: (value) => writeErr(JSON.stringify(value)),
			}),
		);
		return presentAnswer(answer, json);
	} catch (error) {
		if (invoked) {
			writeErr(
				`Epicenter invoked the action but could not report its outcome: ${extractErrorMessage(error)}`,
			);
			return 1;
		}
		if (error instanceof RootUsageError)
			return reject(
				CliError.Usage({ message: error.message, next: error.next }).error,
			);
		return reject(CliError.Internal({ cause: error }).error);
	}
}
