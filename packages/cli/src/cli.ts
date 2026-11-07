/**
 * The `epicenter` command line: parse, run, and return the exit code
 * (ADR-0556, ADR-0558). Each platform operation is rendered from its one
 * description in `operations.ts` (ADR-0827): its positionals and options
 * become its input, checked against its input schema, and its output is
 * printed for a person or, with `--json`, as it is. The CLI's own commands
 * (`mcp`, `auth`, `messages`) have handlers here.
 *
 * Every command takes `--json`, and only `--json` switches the output: one
 * JSON value on stdout, or NDJSON lines ending in one result for
 * `auth login`. Stderr is for people in both modes. Exit codes are
 * ADR-0520's: 0 done, 1 a finding a person acts on, 2 input the tool cannot
 * use.
 */

import { Value } from 'typebox/value';
import packageJson from '../package.json' with { type: 'json' };
import { COMMANDS } from './commands.ts';
import { inputOf, type Operation } from './operation.ts';
import { OPERATIONS } from './operations.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';
import {
	type CommandSpec,
	type Invocation,
	parseArgs,
	usageLine,
} from './parse.ts';

type Command = Extract<Invocation, { kind: 'command' }>;
type Run = (invocation: Command) => Promise<number>;

/**
 * The CLI's own commands. Each loads its module only when it runs, so
 * `--version` and `--help` start without the folder engine.
 */
const HANDLERS: Record<string, Run> = {
	messages: async () => (await import('./messages.js')).messagesCommand(),
	mcp: async ({ positionals, options }) =>
		(await import('./mcp.ts')).mcpCommand({
			dirs: positionals,
			all: options.all === true,
		}),
	'auth login': async ({ json }) =>
		(await import('./auth-commands.ts')).authLogin(json),
	'auth logout': async ({ json }) =>
		(await import('./auth-commands.ts')).authLogout(json),
	'auth status': async ({ json }) =>
		(await import('./auth-commands.ts')).authStatusCommand(json),
	'auth token': async ({ options, json }) =>
		(await import('./auth-commands.ts')).authToken(options, json),
};

/** What `epicenter <command> --help` adds below the summary for the CLI's own commands. */
const DETAILS: Record<string, string> = {
	mcp: `Serves Epicenter to an agent over the Model Context Protocol, on stdin and
stdout: a tool for every operation epicenter lists, with the same input and
output, and, for each folder it reaches (those named, or with --all every
folder in the Epicenter folder), tools over each collection its
epicenter.json declares: <folder>_<collection>_query, _get, _set, and _write.
Each writes through the folder, as an app does, and the folders it writes are
synced at the moments an app's writes are: a burst of writes, every few
seconds while it runs, and as it ends. Add "epicenter mcp --all" to an
agent's MCP configuration.`,
	'auth login': `Signs this computer in with a device code: open the link it prints, check
the code, and choose which folders it may reach. The sign-in is kept in this
computer's keychain, and sync sends its token on each request to the
deployment. --json prints NDJSON: the
code and link as {"device": {...}}, then {"signedIn": {...}} or {"error"}.`,
	'auth token': `Prints an access token for --resource, by default the deployment's API,
refreshing the sign-in when the cached token has under five minutes left. One
refresh runs at a time on this computer. Exits 2 when this computer is not
signed in or the sign-in has ended.`,
	'auth status': `Names who each sign-in on this computer belongs to: this computer's, from
epicenter auth login, and the Epicenter app's. Reads only the keychain.`,
	'auth logout': `Revokes this computer's sign-in at the server and deletes it from the
keychain. The Epicenter app's sign-in is separate; sign it out in its Settings.`,
};

const name = (command: CommandSpec) => command.path.join(' ');
const operationOf = (command: CommandSpec): Operation | undefined =>
	command.path.length === 1
		? OPERATIONS.find((operation) => operation.name === command.path[0])
		: undefined;

function helpText(group?: string) {
	const visible = COMMANDS.filter(
		(c) => !c.hidden && (group === undefined || c.path[0] === group),
	);
	const width = Math.max(...visible.map((c) => usageLine(c).length));
	const line = (c: CommandSpec) =>
		`  ${usageLine(c).padEnd(width)}  ${c.summary}`;
	const folder = visible.filter((c) => operationOf(c) !== undefined);
	const agents = visible.filter((c) => c.path[0] === 'mcp');
	const auth = visible.filter((c) => c.path[0] === 'auth');
	return [
		`Usage: epicenter ${group ?? '<command>'} ... [--json]`,
		...(folder.length
			? [
					'',
					'Folder commands take a folder by its path, or a folder on the server by its id:',
					...folder.map(line),
				]
			: []),
		...(agents.length ? ['', 'Your agents:', ...agents.map(line)] : []),
		...(auth.length ? ['', 'Your Epicenter account:', ...auth.map(line)] : []),
		'',
		'Every command takes --json: one JSON value on stdout, or NDJSON lines for',
		'auth login.',
		'Stderr is for people. Exit codes: 0 done, 1 a finding to act on, 2 input',
		'the command cannot use.',
		'',
		'  --json     machine-readable output on stdout',
		"  --help     this help, or one command's with epicenter <command> --help",
		'  --version  the version of this binary',
	].join('\n');
}

function commandHelp(command: CommandSpec) {
	const details = operationOf(command)?.details ?? DETAILS[name(command)];
	return [
		`Usage: ${usageLine(command)} [--json]`,
		'',
		`${command.summary}.`,
		...(details ? ['', details] : []),
	].join('\n');
}

function describe(command: CommandSpec) {
	const operation = operationOf(command);
	return {
		command: name(command),
		usage: usageLine(command),
		summary: command.summary,
		...(command.long ? { ndjson: true } : {}),
		...(operation === undefined
			? {}
			: { input: operation.input, output: operation.output }),
	};
}

/** Run `operation` on what the command line gave it, and print its answer. */
async function runOperation(operation: Operation, invocation: Command) {
	const { json } = invocation;
	const input = inputOf(operation, invocation.positionals, invocation.options);
	if (input.error !== null) return fail(input.error, json);
	const implementation = await operation.load();
	const answer = await implementation.run(input.data as never);
	if (answer.error !== null) return fail(answer.error, json);
	const { output, finding } = answer.data;
	// Tests run every command this way, so an output its schema does not describe fails them.
	if (
		process.env.EPICENTER_STRICT_OUTPUT === '1' &&
		!Value.Check(operation.output, output)
	) {
		const [first] = Value.Errors(operation.output, output);
		return fail(
			`epicenter ${operation.name} answered outside its output schema: ${first?.instancePath} ${first?.message}`,
			json,
		);
	}
	if (json) writeJson(output);
	else implementation.print(output);
	return finding ? EXIT.finding : EXIT.ok;
}

/** Run one command line, without the program name, and return its exit code. */
export async function runCli(argv: readonly string[]): Promise<number> {
	const invocation = parseArgs(argv, COMMANDS);
	switch (invocation.kind) {
		case 'version':
			if (invocation.json) writeJson({ version: packageJson.version });
			else writeOut(`epicenter ${packageJson.version}`);
			return EXIT.ok;
		case 'help':
			if (invocation.json)
				writeJson(
					invocation.command
						? describe(invocation.command)
						: {
								commands: COMMANDS.filter(
									(c) =>
										!c.hidden &&
										(invocation.group === undefined ||
											c.path[0] === invocation.group),
								).map(describe),
							},
				);
			else
				writeOut(
					invocation.command
						? commandHelp(invocation.command)
						: helpText(invocation.group),
				);
			return EXIT.ok;
		case 'usage':
			if (invocation.json) return fail(invocation.message, true);
			writeErr(invocation.message);
			writeErr(
				invocation.group === undefined
					? 'Run epicenter --help for the commands.'
					: `\n${helpText(invocation.group)}`,
			);
			return EXIT.unusable;
		case 'command': {
			const operation = operationOf(invocation.command);
			// Bun 1.3.14 can end the process while a command still awaits
			// `crypto.subtle` work started after a child process exited; a
			// ref'd timer keeps it running until the command returns.
			const alive = setInterval(() => {}, 2 ** 30);
			try {
				return operation === undefined
					? await (HANDLERS[name(invocation.command)] as Run)(invocation)
					: await runOperation(operation, invocation);
			} catch (error) {
				// A thrown error is the tool failing, not a finding.
				return fail(
					error instanceof Error ? error.message : String(error),
					invocation.json,
				);
			} finally {
				clearInterval(alive);
			}
		}
	}
}
