/**
 * The epicenter command runs apps from the selected Epicenter
 * (ADR-0841). It parses words, shows what can run, checks input, and prints the
 * answer. Its exit code is 0 when the action returned, 1 when it threw, and 2
 * when nothing ran (ADR-0867). After a run that is not read-only, it commits
 * the paths the run wrote, named for the call (ADR-0850); a commit that fails
 * changes neither the answer nor the exit code; the paths remain pending.
 */
import type { Action } from '@epicenter/app';
import packageJson from '../package.json' with { type: 'json' };
import { buildCommand } from './build.ts';
import { REPORT_FLAG, runCall } from './child.ts';
import { COMMANDS, type Command } from './commands.ts';
import { CliError } from './errors.ts';
import { historyCommand, undoCommand } from './history.ts';
import { discoverAll, loadHomeApp } from './home.ts';
import { serveHttp } from './http.ts';
import { initCommand } from './init.ts';
import { matchAction, nearestActions, readInput, usageLine } from './input.ts';
import {
	actionHelp,
	actionTool,
	homeListing,
	oneAppListing,
} from './listing.ts';
import { serveStdio } from './mcp.ts';
import { newCommand } from './new.ts';
import {
	type Answer,
	answerInto,
	fail,
	presentAnswer,
	writeJson,
	writeOut,
} from './output.ts';
import { epicenterRoot, RootUsageError } from './root.ts';
import { runAction } from './run.ts';
import { statusOf } from './snapshot.ts';
import { syncCommand } from './sync.ts';
import { updateCommand } from './update.ts';

const HELP = `epicenter                              your apps
epicenter <app>                        what an app can do
epicenter <app> <action> [<positionals>] [--flags]
${Object.values(COMMANDS).join('\n')}
epicenter --version

Uses the nearest Epicenter above the current folder, then EPICENTER_ROOT,
then ~/Epicenter. An Epicenter has EPICENTER.md.
A flag's value is read as its field's type; null removes a field that takes it.
--input <json> gives an action's whole input as one JSON object; - reads it from stdin.
--json prints one JSON answer, and --help (-h) explains anything; both go anywhere before --.
Exit codes: 0 done, 1 threw or an app did not sync, 2 did not run.`;
const GLOBALS = new Set(['--json', '--help', '-h', '--version', '-V']);

type Handler = (words: string[], json: boolean) => Promise<number>;

const usage = (message: string, next?: string) =>
	CliError.Usage({ message, ...(next ? { next } : {}) }).error;

/** What each command does, as `epicenter <command> --help` prints it under its usage. */
const COMMAND_HELP: { [K in Command]: string } = {
	init: `Makes a folder an Epicenter and writes EPICENTER.md and starter AGENTS.md.
The folder defaults to the current directory. Epicenters cannot nest.`,
	new: `Makes <Epicenter>/<name>, a Git repository. With --from, it clones a starter (a
repository with no data), keeps it as the app's upstream remote, and builds its
UI; without it, it starts from an epicenter.ts and a .gitignore.`,
	update: `Merges each app's upstream, or one app's: it refuses an app with uncommitted
changes, undoes a merge that stops on a conflict, lists each file that no
longer fits its collection's fields, and builds the UI, keeping the last one that built.`,
	build: `Builds the UI of every app, or one app, keeping each last good build.`,
	sync: `Takes a snapshot of what is pending in each app, or one app, then pushes
to origin when it exists. It never pushes to upstream. The snapshot reads
"<app>: changed outside epicenter", or with -m (--message), "<app>: <message>":
an agent that edited an app's files itself names what it did this way.`,
	history: `Lists the app's snapshots, newest first (20 by default; --limit takes 1 to 1000): each
one's commit, local time, and what it took. An undo reads as "undid <subject>".`,
	undo: `Snapshots what is pending, then reverts the app's most recent snapshot that is
not an undo and is not undone, or the commit named, as "<app>: undid <subject>".
Run it again to go further back; undo an undo to bring it back. It refuses a
merge, a commit not in the app's history, and a revert that conflicts, leaving
the folder as it was, and then pushes to origin as sync does.`,
	serve: `Offers every app's actions over MCP at / and each app's UI at /<app>/, on
127.0.0.1 and the Epicenter's port (default 4747) unless --port or --host says otherwise. With --stdio, it speaks
MCP on stdin and stdout instead. Over HTTP it backs up every app as sync does when it
starts, every 5 minutes, and when it stops.`,
};

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	init: initCommand,
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
	build: buildCommand,
	sync: syncCommand,
	history: historyCommand,
	undo: undoCommand,
	async serve(words, json) {
		if (json)
			return fail(
				usage('MCP uses stdout for protocol; --json does not apply'),
				json,
			);
		if (words.length === 1 && words[0] === '--stdio') return serveStdio();
		let port = epicenterRoot().port;
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

/** Dispatch app commands and return an exit code so the entrypoint can let stdout drain. */
export async function runCli(argv: string[]): Promise<number> {
	// A child of another epicenter answers into the report file it names (child.ts).
	const reportArg = argv[0]?.startsWith(REPORT_FLAG) ? argv[0] : undefined;
	if (reportArg) {
		answerInto(reportArg.slice(REPORT_FLAG.length));
		argv = argv.slice(1);
	}
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
			else {
				const found = await discoverAll();
				const histories = new Map(
					await Promise.all(
						found.apps.map(
							async (app) => [app.name, await statusOf(app.realPath)] as const,
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
				print(`${COMMANDS[command]}\n${COMMAND_HELP[command]}`);
				return 0;
			}
			if (command !== 'init') epicenterRoot();
			return HANDLERS[command](words, json);
		}
		epicenterRoot();
		// Running an action is two processes; the child owns the whole run, and this one its commit.
		if (!reportArg && words.length > 0 && !help)
			return presentAnswer((await runCall(argv, 'inherit')) as Answer, json);
		const { data: located, error: notFound } = await loadHomeApp(name);
		if (notFound) return fail(notFound, json);
		if (!located.ok)
			return fail(
				CliError.AppProblems({ app: name, problems: located.problems }).error,
				json,
			);
		if (!words.length) {
			print(oneAppListing(located, json, await statusOf(located.realPath)));
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
		const given = await readInput(action, matched.rest);
		if ('error' in given)
			return fail(CliError.Usage({ message: given.error, next }).error, json);
		const { answer, wrote } = await runAction(
			located,
			matched.key,
			action,
			given.input,
		);
		return presentAnswer(
			answer,
			json,
			wrote
				? { app: located.name, folder: located.realPath, ...wrote }
				: undefined,
		);
	} catch (error) {
		if (error instanceof RootUsageError)
			return fail(
				CliError.Usage({ message: error.message, next: error.next }).error,
				json,
			);
		return fail(CliError.Internal({ cause: error }).error, json);
	}
}
