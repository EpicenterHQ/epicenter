/**
 * The epicenter command runs apps from the home or an explicit folder path
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its exit code is 0 when the action returned, 1 when it threw, 2 when
 * nothing ran, and 3 when it returned but its writes were not committed
 * (ADR-0867).
 */
import { type Action, COMMANDS, type Command, isName } from '@epicenter/app';
import packageJson from '../package.json' with { type: 'json' };
import { REPORT_FLAG, runChild } from './child.ts';
import { CliError } from './errors.ts';
import { discoverAll, isFolderPath, loadFolder, loadHomeApp } from './home.ts';
import { serveHttp } from './http.ts';
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
import { linkCommand, newCommand } from './new.ts';
import {
	answerInto,
	fail,
	presentAnswer,
	writeJson,
	writeOut,
} from './output.ts';
import type { Answer } from './report.ts';
import { runAction } from './run.ts';
import { syncCommand } from './sync.ts';
import { updateCommand } from './update.ts';

const HELP = `epicenter                              your apps
epicenter <app>                        what an app can do
epicenter <app> <action> [<positionals>] [--flags]
epicenter <path> <action> ...          the same, for an app's folder by path
${Object.values(COMMANDS).join('\n')}
epicenter --version

Your apps are the folders in ~/Epicenter with an epicenter.json.
A flag's value is read as its field's type; null removes a field that takes it.
--input <json> gives an action's whole input as one JSON object; - reads it from stdin.
--json prints one JSON answer, and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 threw or an app did not sync, 2 did not run, 3 ran but not committed.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

const usage = (message: string, next?: string) =>
	CliError.Usage({ message, ...(next ? { next } : {}) }).error;

/** What each command does, as `epicenter <command> --help` prints it under its usage. */
const COMMAND_HELP: { [K in Command]: string } = {
	new: `Makes ~/Epicenter/<name>, a Git repository. With --from, it clones a starter (a
repository with no data), keeps it as the app's upstream remote, and builds its
UI; without it, it starts from an epicenter.json and a .gitignore.`,
	update: `Merges each app's upstream, or one app's: it refuses an app with uncommitted
changes, undoes a merge that stops on a conflict, lists each file that no
longer fits epicenter.json, and builds the UI, keeping the last one that built.`,
	link: `Joins a folder that is already an app, where it lives: it checks its
epicenter.json and a free name, and links it into ~/Epicenter.`,
	sync: `Commits what is left in each app, or one app, then pulls from origin and pushes
to it. It never pushes to upstream.`,
	serve: `Offers every app's actions over MCP at / and each app's UI at /<app>/, on
127.0.0.1:4747 unless --port or --host says otherwise. With --stdio, it speaks
MCP on stdin and stdout instead.`,
};

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	async new(words, json) {
		const [name, ...rest] = words;
		const fromAt = rest.findIndex(
			(word) => word === '--from' || word.startsWith('--from='),
		);
		const fromWord = fromAt < 0 ? undefined : rest[fromAt];
		const from =
			fromWord === undefined
				? undefined
				: fromWord.startsWith('--from=')
					? fromWord.slice('--from='.length)
					: rest[fromAt + 1];
		const used = fromAt < 0 ? 0 : fromWord === '--from' ? 2 : 1;
		if (
			name === undefined ||
			name.startsWith('-') ||
			rest.length !== used ||
			(fromAt >= 0 && !from)
		)
			return fail(
				usage(
					'epicenter new needs one name, and maybe --from <git url|path>',
					COMMANDS.new,
				),
				json,
			);
		return newCommand(name, from, json);
	},
	update: updateCommand,
	async link(words, json) {
		const [folder, name] = words;
		if (words.length > 2 || folder === undefined)
			return fail(
				usage('epicenter link needs one folder, and maybe a name'),
				json,
			);
		return linkCommand(folder, name, json);
	},
	sync: syncCommand,
	async serve(words, json) {
		if (json)
			return fail(
				usage('MCP uses stdout for protocol; --json does not apply'),
				json,
			);
		if (words.length === 1 && words[0] === '--stdio') return serveStdio();
		let port = 4747;
		let host = '127.0.0.1';
		const seen = new Set<string>();
		for (let i = 0; i < words.length; i += 2) {
			const flag = words[i];
			const value = words[i + 1];
			if (
				(flag !== '--port' && flag !== '--host') ||
				value === undefined ||
				seen.has(flag)
			)
				return fail(usage('Invalid serve options', COMMANDS.serve), json);
			seen.add(flag);
			if (flag === '--host') host = value;
			else {
				port = Number(value);
				if (!Number.isInteger(port) || port < 0 || port > 65535)
					return fail(usage('Port must be an integer from 0 to 65535'), json);
			}
		}
		return serveHttp(host, port);
	},
};

/**
 * The action's input, checked against its fields: from `--input <json>`, one
 * JSON object as MCP and scripts pass it (`-` reads it from stdin), or else
 * from flags and positionals. `--input` stands alone: the object holds every
 * field, positional ones included (ADR-0867).
 */
async function inputOf(action: Action, rest: string[]) {
	const end = rest.indexOf('--');
	const at = rest.indexOf('--input');
	if (at < 0 || (end >= 0 && at > end)) {
		const parsed = inputFromArgs(action, rest);
		if ('error' in parsed) return parsed;
		return checkInput(action, parsed.input, (key) =>
			action.positional?.includes(key) ? `<${key}>` : `--${flagOf(key)}`,
		);
	}
	const given = rest[at + 1];
	if (rest.length !== 2 || given === undefined)
		return {
			error:
				'--input takes the whole input as one JSON object, with nothing beside it; put positional fields in the object',
		};
	let raw: unknown;
	try {
		raw = JSON.parse(given === '-' ? await Bun.stdin.text() : given);
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
	const reportArg = argv[0]?.startsWith(REPORT_FLAG) ? argv[0] : undefined;
	if (reportArg) {
		answerInto(reportArg.slice(REPORT_FLAG.length));
		argv = argv.slice(1);
	}
	const relayed = argv;
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
			else print(homeListing(await discoverAll(), json));
			return 0;
		}
		const [name, ...words] = tokens as [string, ...string[]];
		if (Object.hasOwn(HANDLERS, name)) {
			const command = name as keyof typeof HANDLERS;
			if (help) {
				print(`${COMMANDS[command]}\n${COMMAND_HELP[command]}`);
				return 0;
			}
			return HANDLERS[command](words, json);
		}
		// Running an action is two processes; the child owns the whole run.
		if (!reportArg && words.length > 0 && !help)
			return presentAnswer(
				(await runChild(relayed, { stdin: 'inherit' })) as Answer,
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
			print(oneAppListing(located, json));
			return 0;
		}
		const matched = matchAction(located.actions, words);
		const action = matched && located.actions[matched.key];
		if (!matched || !action) {
			const { asked, keys: near } = nearestActions(
				Object.keys(located.actions),
				words,
			);
			const shown = near.length ? near : Object.keys(located.actions);
			return fail(
				CliError.Usage({
					message: `${name} has no action ${JSON.stringify(asked)}. ${near.length ? 'Did you mean' : 'Its actions'}:\n${shown
						.map((key) =>
							usageLine(name, key, located.actions[key] as Action, {
								short: true,
							}),
						)
						.join('\n')}`,
					next:
						near.length === 1
							? `epicenter ${name} ${near[0]} --help`
							: `epicenter ${name}`,
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
		const given = await inputOf(action, matched.rest);
		if ('error' in given)
			return fail(CliError.Usage({ message: given.error, next }).error, json);
		return presentAnswer(
			await runAction(located, matched.key, action, given.input),
			json,
		);
	} catch (error) {
		return fail(CliError.Internal({ cause: error }).error, json);
	}
}

/** The words a person gave before the first value or flag; any leading run of them may be the action's name. */
function nameWords(words: string[]): string[] {
	const end = words.findIndex((word) => !isName(word));
	return words.slice(0, end < 0 ? words.length : end);
}

/**
 * The actions a person most likely meant: for each leading run of their
 * words, an action that run ends (`tasks set` for `tasks tasks set`) or that
 * is a typo or two from it. Only the closest are kept, with the run they
 * matched, so a value such as an id is not taken for part of the name.
 */
function nearestActions(
	keys: string[],
	words: string[],
): { asked: string; keys: string[] } {
	const named = nameWords(words);
	let best = {
		asked: named.join(' ') || words[0] || '',
		keys: [] as string[],
		score: Infinity,
	};
	for (let end = named.length; end > 0; end--) {
		const asked = named.slice(0, end).join(' ');
		for (const key of keys) {
			const score = key.endsWith(` ${asked}`) ? 0 : distance(key, asked);
			if (score > Math.min(2, Math.floor(key.length / 3))) continue;
			if (score < best.score) best = { asked, keys: [key], score };
			else if (score === best.score && asked === best.asked)
				best.keys.push(key);
		}
	}
	return best;
}

/** The fewest one-letter edits between two strings, a swap of neighbours counting as one. */
function distance(a: string, b: string): number {
	const d = Array.from({ length: a.length + 1 }, (_, i) =>
		Array.from({ length: b.length + 1 }, (_, j) =>
			i === 0 ? j : j === 0 ? i : 0,
		),
	);
	for (let i = 1; i <= a.length; i++)
		for (let j = 1; j <= b.length; j++) {
			const row = d[i] as number[];
			const above = d[i - 1] as number[];
			row[j] = Math.min(
				(above[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(above[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
				row[j] = Math.min(
					row[j] as number,
					((d[i - 2] as number[])[j - 2] as number) + 1,
				);
		}
	return (d[a.length] as number[])[b.length] as number;
}
