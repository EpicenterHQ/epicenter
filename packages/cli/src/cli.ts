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
import packageJson from '../package.json' with { type: 'json' };
import { accessCommand } from './access.ts';
import { buildCommand } from './build.ts';
import { READ_ONLY_FLAG, REPORT_FLAG, runChild } from './child.ts';
import {
	BAD_PORT,
	COMMANDS,
	type Command,
	misuse,
	parseWords,
	portOf,
} from './commands.ts';
import { codeStateOf } from './data.ts';
import { CliError } from './errors.ts';
import { historyCommand, undoCommand } from './history.ts';
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
import { serveStdio } from './mcp.ts';
import { newCommand } from './new.ts';
import {
	type Answer,
	answerInto,
	fail,
	presentAnswer,
	writeErr,
	writeJson,
	writeOut,
} from './output.ts';
import { epicenterDir, epicenterRoot, RootUsageError } from './root.ts';
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

/** Whether `host` is a loopback address or name, reachable only from this computer. */
const isLoopbackHost = (host: string) =>
	host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);

/** What each command in `COMMANDS` does. */
const HANDLERS: { [K in Command]: Handler } = {
	init: initCommand,
	new: newCommand,
	update: updateCommand,
	build: buildCommand,
	sync: syncCommand,
	history: historyCommand,
	undo: undoCommand,
	access: accessCommand,
	service: serviceCommand,
	async serve(words, json) {
		if (json)
			return fail(
				misuse('serve', 'MCP uses stdout for protocol; --json does not apply'),
				json,
			);
		const given = parseWords(
			words,
			{
				port: { type: 'string' },
				host: { type: 'string' },
				stdio: { type: 'boolean' },
			},
			[0, 0],
		);
		if (!given) return fail(misuse('serve'), json);
		const { port, host, stdio } = given.values;
		if (stdio) return port || host ? fail(misuse('serve'), json) : serveStdio();
		const root = epicenterRoot();
		const listen = port === undefined ? root.port : portOf(port);
		if (listen === undefined) return fail(misuse('serve', BAD_PORT), json);
		// With a public address, the tailnet reaches the private listener only
		// through a proxy on this computer, such as tailscale serve.
		if (root.public && host !== undefined && !isLoopbackHost(host))
			return fail(
				misuse(
					'serve',
					`With a public address, serve listens only on a loopback address, not ${host}`,
				),
				json,
			);
		return serveHttp(host ?? '127.0.0.1', listen);
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
	// A child may be limited to read-only actions (child.ts).
	const onlyReadOnly = reportArg !== undefined && argv[0] === READ_ONLY_FLAG;
	if (onlyReadOnly) argv = argv.slice(1);
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
			if (onlyReadOnly)
				return fail(
					CliError.Refused({
						message: `epicenter ${name} is not an action, and this call may only read`,
					}).error,
					json,
				);
			const command = name as keyof typeof HANDLERS;
			if (help) {
				print(`${COMMANDS[command].usage}\n${COMMANDS[command].help}`);
				return 0;
			}
			if (command !== 'init' && command !== 'service') epicenterRoot();
			return HANDLERS[command](words, json);
		}
		epicenterRoot();
		// Running an action is two processes: the child owns the whole call, commit and all, and this one relays its answer.
		if (!reportArg && words.length > 0 && !help)
			return presentAnswer((await runChild(argv, 'inherit')) as Answer, json);
		const code =
			reportArg && words.length > 0 && !help && isName(name)
				? await codeStateOf(join(epicenterDir(), name))
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
		if (onlyReadOnly && action.annotations?.readOnlyHint !== true)
			return fail(
				CliError.Refused({
					message: `${name} ${matched.key} changes files, and this call may only read`,
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
		const given = await readInput(action, matched.rest);
		if ('error' in given)
			return fail(CliError.Usage({ message: given.error, next }).error, json);
		const { answer, committed } = await runAction(
			located,
			matched.key,
			action,
			given.input,
			code,
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
