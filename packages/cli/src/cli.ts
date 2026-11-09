/**
 * The epicenter command runs apps from the home or an explicit folder path
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its returned exit code follows whether run started (ADR-0842).
 */
import type { Action } from '@epicenter/app';
import packageJson from '../package.json' with { type: 'json' };
import { addCommand, newCommand } from './add.ts';
import { CliError } from './errors.ts';
import { discoverAll, isFolderPath, loadFolder, loadHomeApp } from './home.ts';
import {
	checkInput,
	flagOf,
	inputFromArgs,
	matchAction,
	usageLine,
} from './input.ts';
import {
	actionHelp,
	actionTool,
	homeListing,
	oneAppListing,
} from './listing.ts';
import { serveStdio } from './mcp.ts';
import { fail, presentReport, writeJson, writeOut } from './output.ts';
import { runAction } from './run.ts';
import { typesCommand } from './types.ts';

const HELP = `epicenter [--json]
epicenter <app> [--json]
epicenter <app> <action words> [<positionals>] [--flags] [--json]
epicenter <path> <action words> [<positionals>] [--flags] [--json]
epicenter serve --stdio
epicenter types [<app> | <path>]
epicenter new <name>
epicenter add <folder> [--init] | add <git url>
epicenter update | open
epicenter help [<app> [<action words>]]
epicenter --version

Your apps are the folders in ~/Epicenter with an epicenter.json.
Global flags come after the action words: --json, --help (-h).
Exit codes: 0 success, 1 finding, 2 did not run, 3 action started and threw.
EPICENTER_TEST_SECRETS: JSON service stores held in memory for this process, so tests never reach the Keychain.
Run epicenter for your apps.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

/**
 * The action's input, checked against its fields: from `--input <json>`, one
 * JSON object as MCP and scripts pass it, or else from flags and positionals.
 */
function inputOf(action: Action, rest: string[]) {
	if (rest[0] !== '--input')
		return (() => {
			const parsed = inputFromArgs(action, rest);
			if ('error' in parsed) return parsed;
			return checkInput(action, parsed.input, (key) =>
				action.positional?.includes(key) ? `<${key}>` : `--${flagOf(key)}`,
			);
		})();
	if (rest.length !== 2)
		return { error: '--input takes one JSON object and nothing else' };
	let raw: unknown;
	try {
		raw = JSON.parse(rest[1] as string);
	} catch {
		return { error: '--input is not JSON' };
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return { error: '--input is not a JSON object' };
	return checkInput(action, raw, (key) => key);
}

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	if (argv[0] === 'help') argv = [...argv.slice(1), '--help'];
	let leading = 0;
	while (GLOBALS.has(argv[leading] ?? '')) leading++;
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
		else if (
			(token === '--version' || token === '-V') &&
			leading === argv.length
		)
			version = true;
		else tokens.push(token);
	}
	if (leading > 0 && leading < argv.length) {
		return fail(
			CliError.Usage({
				message: 'Global flags come after the action words',
				next: `epicenter ${[...argv.slice(leading), ...argv.slice(0, leading)].join(' ')}`,
			}).error,
			json,
		);
	}
	const print = (value: unknown) => {
		if (json) writeJson(value);
		else writeOut(String(value));
	};
	try {
		if (!tokens.length) {
			if (version)
				print(
					json
						? { version: packageJson.version }
						: `epicenter ${packageJson.version}`,
				);
			else if (help) print(HELP);
			else print(await homeListing(await discoverAll(), json));
			return 0;
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (name === 'new') {
			if (help) {
				print('epicenter new <name>');
				return 0;
			}
			const [only] = words;
			if (words.length !== 1 || only === undefined)
				return fail(
					CliError.Usage({ message: 'epicenter new needs one name' }).error,
					json,
				);
			return newCommand(only, json);
		}
		if (name === 'add') {
			if (help) {
				print('epicenter add <folder> [--init]\nepicenter add <git url>');
				return 0;
			}
			const init = words.includes('--init');
			const sources = words.filter((word) => word !== '--init');
			if (sources.length !== 1 || sources[0] === undefined)
				return fail(
					CliError.Usage({
						message: 'epicenter add needs one folder or Git URL',
					}).error,
					json,
				);
			return addCommand(sources[0], init, json);
		}
		if (name === 'types') {
			if (help) {
				print('epicenter types [<app> | <path>]');
				return 0;
			}
			if (words.length > 1)
				return fail(
					CliError.Usage({ message: 'epicenter types takes one app or path' })
						.error,
					json,
				);
			return typesCommand(words[0] ?? '.', json);
		}
		if (name === 'serve') {
			if (help) {
				print('epicenter serve --stdio');
				return 0;
			}
			if (words.join(' ') !== '--stdio')
				return fail(
					CliError.Usage({
						message: 'epicenter serve over the network is not built yet',
						next: 'epicenter serve --stdio',
					}).error,
					json,
				);
			if (json)
				return fail(
					CliError.Usage({
						message: 'MCP uses stdout for protocol; --json does not apply',
					}).error,
					json,
				);
			return serveStdio();
		}
		if (['update', 'open'].includes(name))
			return fail(
				CliError.Usage({ message: `epicenter ${name} is not built yet` }).error,
				json,
			);
		const { data: located, error: notFound } = await (isFolderPath(name)
			? loadFolder(name, words)
			: loadHomeApp(name));
		if (notFound) return fail(notFound, json);
		if (!located.ok)
			return fail(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
				json,
			);
		if (!words.length) {
			print(await oneAppListing(located, json));
			return 0;
		}
		const matched = matchAction(located.actions, words);
		const action = matched && located.actions[matched.key];
		if (!matched || !action)
			return fail(
				CliError.Usage({
					message: `Unknown action ${words.join(' ')}.\n${Object.entries(
						located.actions,
					)
						.map(([key, action]) => usageLine(name, key, action))
						.join('\n')}`,
					next: `epicenter ${name}`,
				}).error,
				json,
			);
		if (help) {
			print(
				json
					? actionTool(located.name, matched.key, action)
					: actionHelp(name, matched.key, action),
			);
			return 0;
		}
		const next = `epicenter ${name} ${matched.key} --help`;
		const given = inputOf(action, matched.rest);
		if ('error' in given)
			return fail(CliError.Usage({ message: given.error, next }).error, json);
		const { data: report, error } = await runAction(
			located,
			matched.key,
			given.input,
		);
		if (error) return fail(error, json);
		return presentReport(report, json);
	} catch (error) {
		return fail(CliError.Internal({ cause: error }).error, json);
	}
}
