/**
 * The epicenter command runs apps from the home or an explicit folder path
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its returned exit code follows whether run started (ADR-0842).
 */
import { type Action, COMMANDS, type Command } from '@epicenter/app';
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
import { REPORT_FLAG, runChild } from './child.ts';
import {
	answerInto,
	fail,
	presentAnswer,
	presentReport,
	writeJson,
	writeOut,
	writeStarted,
} from './output.ts';
import { runAction } from './run.ts';

const HELP = `epicenter [--json]
epicenter <app> [--json]
epicenter <app> <action words> [<positionals>] [--flags] [--json]
epicenter <path> <action words> [<positionals>] [--flags] [--json]
${Object.values(COMMANDS).join('\n')}
epicenter --version

Your apps are the folders in ~/Epicenter with an epicenter.json.
--json and --help (-h) go anywhere before --.
Exit codes: 0 ran, 2 did not run, 3 ran and failed.
Run epicenter for your apps.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

const usage = (message: string, next?: string) =>
	CliError.Usage({ message, ...(next ? { next } : {}) }).error;

/** What each command in `COMMANDS` does; `help` is read before dispatch, as `--help`. */
const HANDLERS: { [K in Exclude<Command, 'help'>]: Handler } = {
	async new(words, json) {
		const [only] = words;
		if (words.length !== 1 || only === undefined)
			return fail(usage('epicenter new needs one name'), json);
		return newCommand(only, json);
	},
	async add(words, json) {
		const init = words.includes('--init');
		const sources = words.filter((word) => word !== '--init');
		if (sources.length !== 1 || sources[0] === undefined)
			return fail(usage('epicenter add needs one folder or Git URL'), json);
		return addCommand(sources[0], init, json);
	},
	async serve(words, json) {
		if (words.join(' ') !== '--stdio')
			return fail(
				usage(
					'epicenter serve over the network is not built yet',
					'epicenter serve --stdio',
				),
				json,
			);
		if (json)
			return fail(
				usage('MCP uses stdout for protocol; --json does not apply'),
				json,
			);
		return serveStdio();
	},
	async setup(_, json) {
		return fail(usage('epicenter setup is not built yet'), json);
	},
};

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
	// A child of another epicenter answers into the report file it names (child.ts).
	const reportArg = argv.find((token) => token.startsWith(REPORT_FLAG));
	if (reportArg) {
		answerInto(reportArg.slice(REPORT_FLAG.length));
		argv = argv.filter((token) => token !== reportArg);
	}
	const relayed = argv;
	if (argv[0] === 'help') argv = [...argv.slice(1), '--help'];
	// --version is read only on its own, so an action's --version stays its own flag.
	const onlyGlobals = argv.every((token) => GLOBALS.has(token));
	const tokens: string[] = [];
	let json = reportArg !== undefined;
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
		if (name !== 'help' && Object.hasOwn(HANDLERS, name)) {
			const command = name as keyof typeof HANDLERS;
			if (help) {
				print(COMMANDS[command]);
				return 0;
			}
			return HANDLERS[command](words, json);
		}
		// Running an action is two processes; the child owns the whole run.
		if (!reportArg && words.length > 0 && !help)
			return presentAnswer(
				(await runChild(relayed, { stdin: 'inherit' })).answer,
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
			writeStarted,
		);
		if (error) return fail(error, json);
		return presentReport(report, json);
	} catch (error) {
		return fail(CliError.Internal({ cause: error }).error, json);
	}
}
