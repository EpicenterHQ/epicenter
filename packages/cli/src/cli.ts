/** Dispatch commands, and send each checked app action to the home's serve, which runs it. */
import { isName } from '@epicenter/app';
import { extractErrorMessage } from 'wellcrafted/error';
import { checkCommand } from './check.ts';
import { COMMANDS, type Command, misuse, parseWords } from './commands.ts';
import { VERSION } from './engines.ts';
import { CliError } from './errors.ts';
import { exportCommand } from './export.js';
import { discoverAll, loadHomeApp } from './home.ts';
import { serveHttp } from './http.ts';
import { initCommand } from './init.ts';
import { matchAction, readInput, usageLine } from './input.ts';
import { installedVersion } from './library.ts';
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
	refused,
	writeErr,
	writeJson,
	writeOut,
} from './output.ts';
import { repositoryStatus } from './repository.ts';
import { epicenterDir, epicenterRoot, MARKER, RootUsageError } from './root.ts';
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
--json prints one JSON answer, and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 ran with a failure or an unfinished export, 2 did not run.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	init: initCommand,
	new: newCommand,
	export: exportCommand,
	check: checkCommand,
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
				// A report only: it reads the home and starts, fetches and writes nothing.
				const [found, routines, repository, version] = await Promise.all([
					discoverAll(),
					createRoutines({ folder: epicenterDir() }).list(),
					repositoryStatus(epicenterDir()),
					installedVersion(epicenterDir()),
				]);
				print(homeListing(found, { routines, repository, version }, json));
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
			if (command !== 'init') epicenterRoot();
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
		// Each update is one line of JSON on stderr, as it arrives.
		const onUpdate = (value: unknown) => writeErr(JSON.stringify(value));
		// Serve runs every action; this process only sends the call.
		invoked = true;
		const sent = await sendToServe(name, matched.key, given.input, onUpdate);
		if (!sent.answer)
			return reject(
				CliError.Refused({
					message:
						sent.holder === 'nothing'
							? 'Epicenter is not running for this home. Start it with `epicenter serve`.'
							: `Port ${sent.port} answers for another ${sent.holder === 'epicenter' ? 'Epicenter' : 'program'}. Set a different \`port\` in ${MARKER}.`,
				}).error,
			);
		if (sent.version !== undefined && sent.version !== VERSION)
			writeErr(
				`Epicenter is running ${sent.version === null ? 'an older version' : `version ${sent.version}`} and this command is version ${VERSION}. Stop \`epicenter serve\` and start it again.`,
			);
		return presentAnswer(sent.answer, json);
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
