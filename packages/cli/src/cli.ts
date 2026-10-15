/**
 * The `epicenter` command line: parse, dispatch to a thin wrapper over a
 * shared package, and return the exit code (ADR-0556, ADR-0558).
 *
 * Every command takes `--json`, and only `--json` switches the output: one
 * JSON value on stdout, or NDJSON lines ending in one result for a long
 * command. Stderr is for people in both modes. Exit codes are ADR-0520's:
 * 0 done, 1 a finding a person acts on, 2 input the tool cannot use.
 */

import packageJson from '../package.json' with { type: 'json' };
import { adrPointer, COMMANDS } from './commands.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';
import {
	type CommandSpec,
	type Invocation,
	parseArgs,
	usageLine,
} from './parse.ts';

type Run = (
	invocation: Extract<Invocation, { kind: 'command' }>,
) => Promise<number>;

/**
 * The commands built so far. Each loads its package only when it runs, so
 * `--version` and `--help` start without the folder engine.
 */
const HANDLERS: Record<string, Run> = {
	check: async ({ positionals: [dir], json }) =>
		(await import('./folder-commands.ts')).check(dir as string, json),
	query: async ({ positionals: [dir, sql], json }) =>
		(await import('./folder-commands.ts')).query(dir as string, sql, json),
	generate: async ({ positionals: [dir], json }) =>
		(await import('./folder-commands.ts')).generate(dir as string, json),
	'app list': async ({ options, json }) =>
		(await import('./app-commands.ts')).appList(options, json),
	'app install': async ({ positionals: [source], options, json }) =>
		(await import('./app-commands.ts')).appInstall(
			source as string,
			options,
			json,
		),
	'app update': async ({ positionals: [id], options, json }) =>
		(await import('./app-commands.ts')).appUpdate(id as string, options, json),
	'app remove': async ({ positionals: [id], json }) =>
		(await import('./app-commands.ts')).appRemove(id as string, json),
	'install-command': async ({ options, json }) =>
		(await import('./install-command.ts')).installCommand({
			json,
			dryRun: options['dry-run'] === true,
		}),
};

/** What `epicenter <command> --help` adds below the usage line. */
const DETAILS: Record<string, string> = {
	check: `Prints one line per file that does not conform, compiler style, then a
summary. Exits 0 when every file conforms, 1 when one does not, and 2 when
the folder or its declaration cannot be used or a file cannot be read.
Never writes a file or runs the folder's code.`,
	query: `Without a statement, describes each table's columns and what they hold.
With one, runs that single read-only statement (SELECT, WITH, VALUES, or
EXPLAIN) over the files that conform and prints tab-separated rows. A file
that does not conform is left out of every table and named on stderr (in
"excluded" with --json); check says why. Exits 0 when it answers and 2 when
the folder, the declaration, or the statement cannot be used.`,
	'app install': `Clones the repository into Apps/<app-id>/, the id read from the
epicenter.app.json in --folder (the root by default), then builds it with
bun run build:installed. A commit nobody approved on this machine is not
built: the command prints it with its log and exits 1 until it runs again
with --approve. --json prints NDJSON progress lines and one result line.`,
	'app update': `Fetches the app's upstream, fast-forwards or rebases the commits made
here, and builds the result if it may run. A commit made on this machine runs
without asking; one fetched from elsewhere is printed with its log and diff
stat, and the command exits 1 until it runs again with --approve.`,
	generate: `Runs <dir>/epicenter.ts, whose default export is defineFolder({...}) from
@epicenter/folder, and writes the epicenter.json it declares. It is the only
command that runs a folder's code; check and query read only epicenter.json.
It may import @epicenter/folder, @epicenter/definition, typebox, and their
subpaths, which resolve to this binary's own copies. Exits 0, or 2 when
epicenter.ts cannot be used. To confirm the file is current, run generate
and then git diff --exit-code -- <dir>/epicenter.json.`,
};

const name = (command: CommandSpec) => command.path.join(' ');
const built = (command: CommandSpec) => name(command) in HANDLERS;

function helpText(group?: string) {
	const visible = COMMANDS.filter(
		(c) => !c.hidden && (group === undefined || c.path[0] === group),
	);
	const width = Math.max(...visible.map((c) => usageLine(c).length));
	const line = (c: CommandSpec) =>
		`  ${usageLine(c).padEnd(width)}  ${c.summary}${built(c) ? '' : ' (not built yet)'}`;
	const folder = visible.filter((c) => c.path.length === 1);
	const app = visible.filter((c) => c.path[0] === 'app');
	const auth = visible.filter((c) => c.path[0] === 'auth');
	return [
		`Usage: epicenter ${group ?? '<command>'} ... [--json]`,
		...(folder.length
			? ['', 'Folder commands take a folder by its path:', ...folder.map(line)]
			: []),
		...(app.length ? ['', 'Apps on this machine:', ...app.map(line)] : []),
		...(auth.length ? ['', 'Your Epicenter account:', ...auth.map(line)] : []),
		'',
		'Every command takes --json: one JSON value on stdout, or NDJSON progress',
		'lines ending in one result for sync, clone, app install, and app update.',
		'Stderr is for people. Exit codes: 0 done, 1 a finding to act on, 2 input',
		'the command cannot use. A command not built yet exits 2.',
		'',
		'  --json     machine-readable output on stdout',
		"  --help     this help, or one command's with epicenter <command> --help",
		'  --version  the version of this binary',
	].join('\n');
}

function commandHelp(command: CommandSpec) {
	return [
		`Usage: ${usageLine(command)} [--json]`,
		'',
		`${command.summary}.`,
		...(DETAILS[name(command)] ? ['', DETAILS[name(command)] as string] : []),
		...(built(command)
			? []
			: ['', `Not built yet; see ${adrPointer(command.adr)}.`]),
	].join('\n');
}

function describe(command: CommandSpec) {
	return {
		command: name(command),
		usage: usageLine(command),
		summary: command.summary,
		built: built(command),
		adr: command.adr,
		...(command.long ? { output: 'ndjson' } : {}),
	};
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
			const run = HANDLERS[name(invocation.command)];
			if (run === undefined)
				return fail(
					`epicenter ${name(invocation.command)} is not built yet; see ${adrPointer(invocation.command.adr)}`,
					invocation.json,
				);
			try {
				return await run(invocation);
			} catch (error) {
				// A thrown error is the tool failing, not a finding.
				return fail(
					error instanceof Error ? error.message : String(error),
					invocation.json,
				);
			}
		}
	}
}
