/**
 * The epicenter command runs apps from the home or an explicit folder path
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its returned exit code follows whether run started (ADR-0842).
 */
import type { Action } from '@epicenter/app';
import packageJson from '../package.json' with { type: 'json' };
import { CliError } from './errors.ts';
import {
	discoverAll,
	isFolderPath,
	type Located,
	loadFolder,
	loadHomeApp,
	Refusal,
} from './home.ts';
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
import { newCommand } from './new.ts';
import { fail, ran, writeJson, writeOut } from './output.ts';
import { runAction } from './run.ts';
import { syncCommand } from './sync.ts';
import { typesCommand } from './types.ts';

const HELP = `epicenter [--json]
epicenter <app> [--json]
epicenter <app> <action words> [<positionals>] [--flags] [--json]
epicenter <path> <action words> [<positionals>] [--flags] [--json]
epicenter serve --stdio
epicenter types [<app> | <path>]
epicenter new <name> | sync | add <source> | update | open
epicenter help [<app> [<action words>]]
epicenter --version

Your apps are the folders in ~/Epicenter with an epicenter.json.
Global flags come after the action words: --json, --help (-h).
Exit codes: 0 success, 1 finding, 2 did not run, 3 action started and threw.
EPICENTER_CACHE_HOME: device cache (default ~/Library/Caches/so.epicenter.apps).
EPICENTER_TEST_SECRETS: JSON service stores held in memory for this process.
EPICENTER_SKIP_INSTALL=1: skip bun install in new (tests).
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
			else print(homeListing(await discoverAll(), json));
			return 0;
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (name === 'new') {
			if (help) {
				print('epicenter new <name>');
				return 0;
			}
			if (words.length !== 1)
				return fail(
					CliError.Usage({ message: 'epicenter new needs one name' }).error,
					json,
				);
			return newCommand(words[0], json);
		}
		if (name === 'sync') {
			if (help) {
				print('epicenter sync');
				return 0;
			}
			if (words.length)
				return fail(
					CliError.Usage({ message: 'epicenter sync takes no arguments' })
						.error,
					json,
				);
			return syncCommand(json);
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
		if (['add', 'update', 'open'].includes(name))
			return fail(
				CliError.Usage({ message: `epicenter ${name} is not built yet` }).error,
				json,
			);
		let located: Located;
		try {
			located = await (isFolderPath(name)
				? loadFolder(name, words)
				: loadHomeApp(name));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(
				CliError.Usage({
					message,
					next: error instanceof Refusal ? error.next : undefined,
				}).error,
				json,
			);
		}
		if (!located.ok)
			return fail(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
				json,
			);
		if (!words.length) {
			print(oneAppListing(located, json));
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
		const { data, error } = await runAction(located, matched.key, given.input);
		if (error !== null) return fail(error, json);
		return ran(data, json);
	} catch (error) {
		return fail(
			CliError.Usage({
				message: error instanceof Error ? error.message : String(error),
			}).error,
			json,
		);
	}
}
