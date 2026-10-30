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
import type { GrantKind } from './auth.ts';
import { COMMANDS } from './commands.ts';
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
 * Each command's handler. Each loads its package only when it runs, so
 * `--version` and `--help` start without the folder engine.
 */
const HANDLERS: Record<string, Run> = {
	messages: async () => (await import('./messages.js')).messagesCommand(),
	'schema export': async ({ positionals: [directory], json }) =>
		(await import('./schema-commands.ts')).exportSchemas(
			directory as string,
			json,
		),
	'schema import': async ({ positionals: [directory, input], options, json }) =>
		(await import('./schema-commands.ts')).importSchemas(
			directory as string,
			input as string,
			options.replace === true,
			json,
		),
	'documents-query': async ({ positionals: [directory], json }) =>
		(await import('./document-commands.ts')).documentsQuery(
			directory as string,
			json,
		),
	'folders pin': async ({ positionals: [directory], json }) =>
		(await import('./navigation.js')).foldersCommand('pin', directory, json),
	'folders remove-recent': async ({ positionals: [directory], json }) =>
		(await import('./navigation.js')).foldersCommand(
			'remove-recent',
			directory,
			json,
		),
	'folders list': async ({ positionals: [directory], json }) =>
		(await import('./navigation.js')).foldersCommand('list', directory, json),
	'folders unpin': async ({ positionals: [directory], json }) =>
		(await import('./navigation.js')).foldersCommand('unpin', directory, json),
	check: async ({ positionals: [contract, dir], json }) =>
		(await import('./contract-commands.ts')).check(
			contract as string,
			dir ?? '.',
			json,
		),
	format: async ({ positionals: [contract, dir], json }) =>
		(await import('./contract-commands.ts')).format(
			contract as string,
			dir ?? '.',
			json,
		),
	query: async ({ positionals: [dir, sql], json }) =>
		(await import('./folder-commands.ts')).query(dir as string, sql, json),
	status: async ({ positionals: [dir], options, json, grant }) =>
		history('status', dir as string, options, json, grant),
	history: async ({ positionals: [dir], options, json, grant }) =>
		history('history', dir as string, options, json, grant),
	'save-version': async ({ positionals: [dir], options, json, grant }) =>
		history('save-version', dir as string, options, json, grant),
	sync: async ({ positionals: [dir], options, json, grant }) =>
		history('sync', dir as string, options, json, grant),
	clone: async ({ positionals: [source, dir], json, grant }) =>
		(await import('./repository-commands.ts')).clone(
			source as string,
			dir,
			json,
			grant,
		),
	repos: async ({ json, grant }) =>
		(await import('./repository-commands.ts')).repos(json, grant),
	'auth key': async ({ positionals: [action, connection], json }) => {
		const [{ authKey }, { keychain }] = await Promise.all([
			import('./ai-commands.ts'),
			import('./secrets.ts'),
		]);
		return authKey(action as string, connection as string, json, keychain());
	},
	send: async ({ grant }) => {
		const [
			{ send },
			{ keychain },
			{ accountAccess, authContext, epicenterAccess },
		] = await Promise.all([
			import('./ai-commands.ts'),
			import('./secrets.ts'),
			import('./auth.ts'),
		]);
		const ctx = authContext();
		return send(
			keychain(),
			epicenterAccess(ctx, grant),
			accountAccess(ctx, grant),
		);
	},
	'auth login': async ({ json, grant }) =>
		(await import('./auth-commands.ts')).authLogin(json, grant),
	'auth logout': async ({ json, grant }) =>
		(await import('./auth-commands.ts')).authLogout(json, grant),
	'auth status': async ({ json }) =>
		(await import('./auth-commands.ts')).authStatusCommand(json),
	'auth token': async ({ options, json, grant }) =>
		(await import('./auth-commands.ts')).authToken(options, json, grant),
	'auth git-credential': async ({ positionals: [action], grant }) =>
		(await import('./auth-commands.ts')).authGitCredential(
			action as string,
			grant,
		),
	'whispering-connection read': async ({ positionals: [operation], json }) =>
		(await import('./connection-rows.ts')).whisperingConnection(
			'read',
			operation as string,
			json,
		),
	'whispering-connection set': async ({ positionals: [operation], json }) =>
		(await import('./connection-rows.ts')).whisperingConnection(
			'set',
			operation as string,
			json,
		),
	'install-command': async ({ json }) =>
		(await import('./install-command.ts')).installCommand({ json }),
};

/**
 * Run a history command. When the shell ends this process (a page reloaded,
 * or its window closed), every `git` it started ends too, with the helpers
 * each started (ADR-0559), and a refresh it sent finishes first (ADR-0565;
 * `stop.ts`).
 */
async function history(
	command: 'status' | 'history' | 'save-version' | 'sync',
	dir: string,
	options: Record<string, string | true>,
	json: boolean,
	grant: GrantKind,
) {
	const [{ historyCommand }, { endGitCommands }, { onStop }] =
		await Promise.all([
			import('./history-commands.ts'),
			import('@epicenter/folder/bun'),
			import('./stop.ts'),
		]);
	onStop(endGitCommands);
	return historyCommand(command, dir, options, json, grant);
}

/** What `epicenter <command> --help` adds below the usage line. */
const DETAILS: Record<string, string> = {
	check: `Checks every file in <dir>, by default this directory, against an app's
contract: the JSON at <contract>, a URL or a file path. Prints one line per
problem, compiler style: a path no collection of the contract names, a note
whose front matter does not parse, or one whose fields do not fit. Hidden
paths (.git, .epicenter, ...) are not the contract's and are skipped. Exits 0
when every file fits, 1 when one does not, and 2 when the contract or the
folder cannot be used. Never writes a file.`,
	format: `Rewrites every note in <dir>, by default this directory, that a collection
of the contract at <contract> (a URL or a file path) names, in house style:
the contract's fields first in its order, other keys after them sorted,
block YAML, the body untouched. A note whose front matter does not parse is
left as it is and named. Each note is replaced only while it still holds the
bytes read. Exits 0 when every note is in house style, 1 when one was left as
it is, and 2 when the contract or the folder cannot be used.`,
	query: `Without a statement, describes each table's columns and what they hold.
With one, runs that single read-only statement (SELECT, WITH, VALUES, or
EXPLAIN) over the files that conform and prints tab-separated rows. A file
that does not conform is left out of every table and named on stderr (in
"excluded" with --json). Exits 0 when it answers and 2 when
the folder, the definition, or the statement cannot be used.`,
	'auth key': `Keeps an AI connection's endpoint and key in this computer's keychain,
under the connection's id, the stem of its row in so.epicenter/connections
(ADR-0557). set reads {"endpoint": "<url>", "key": "<key>"} as JSON on
stdin, never from the command line; an empty or missing key saves a keyless
endpoint. state prints the endpoint and whether a key is saved, never the
key. remove deletes the entry. Exits 0, or 2 when the id, the input, or the
keychain cannot be used.`,
	'auth login': `Signs this computer in with a device code: open the link it prints, check
the code, and choose which folders it may reach. The sign-in is kept in this
computer's keychain, and Git's global configuration gets this command as its
credential helper for the deployment's Git origin. --json prints NDJSON: the
code and link as {"device": {...}}, then {"signedIn": {...}} or {"error"}.`,
	'auth token': `Prints an access token for --resource, by default the deployment's API,
refreshing the sign-in when the cached token has under five minutes left. One
refresh runs at a time on this computer. Exits 2 when this computer is not
signed in or the sign-in has ended.`,
	'auth status': `Names who each sign-in on this computer belongs to: this computer's, from
epicenter auth login, and the Epicenter app's. Reads only the keychain.`,
	'auth logout': `Revokes this computer's sign-in at the server and deletes it from the
keychain. The Epicenter app's sign-in is separate; sign it out in its Settings.`,
	'auth git-credential': `Git runs this as its credential helper (gitcredentials(7)). get answers
the deployment's Git origin with a username, an access token as the password,
and password_expiry_utc; any other host gets no answer. store and erase do
nothing. Takes no --json.`,
	status: `Prints the folder's branch and head, the files changed since the last
version, and the remote with how far ahead and behind it is. Reads only: it
runs Git and writes nothing. With --json, one line in the history encoding
the desktop app reads. Exits 0, or 2 when the folder cannot be used or git
is not installed ({"error": "GitMissing"} with --json).`,
	clone: `Clones <namespace>/<name> from this deployment's Git origin, or any
other URL as given with your own Git credentials, into <dir>, by default
~/Epicenter/<name>. Run epicenter repos to list the names. Exits 2 when it
cannot clone.`,
	repos: `Lists the repositories of every namespace this sign-in may reach: the
personal namespace first, then each group by title, as <namespace>/<name>.
With --json, {"namespaces": [{"id", "title", "personal", "role",
"repositories": [{"id", "name", "url"}]}]}.`,
	sync: `Records the folder's edits as a version, fetches the remote branch, merges
it by each file's kind, and pushes, under the folder's history lock, so two
syncs or a sync and save-version never interleave. --to <namespace>/<name>
connects the folder to that repository on this deployment's Git origin:
the first sync creates it, and the folder's remote becomes
<git origin>/<namespace>/<name>.git. --to also takes any remote's URL.
What both sides changed merges into one commit, and this folder's version
of each field or lines both changed wins; the commit's Overrode: lines name
what the remote lost, which its history still holds. A sync asks nothing.
A folder with no epicenter.json is not synced (nothing says which files stay
on this computer), and nothing is committed or pushed; declare them in
epicenter.json's "local" list first.`,
	'schema export': `Prints one JSON document containing only the declared tables from
<dir>/epicenter.json. It executes no code and changes no files. The exported
copy can be imported into another folder. Output is JSON with or without --json.`,
	'schema import': `Reads a JSON document with a tables section from <file>, or stdin for -.
Imports those tables into <dir>/epicenter.json, creating the file when absent.
Preserves other tables, saved views, title, local rules, and editor schema hints.
A different existing table schema requires --replace. Invalid or duplicate-key
JSON remains unchanged. Opening or updating an app never imports its schema.`,
};

const name = (command: CommandSpec) => command.path.join(' ');

function helpText(group?: string) {
	const visible = COMMANDS.filter(
		(c) => !c.hidden && (group === undefined || c.path[0] === group),
	);
	const width = Math.max(...visible.map((c) => usageLine(c).length));
	const line = (c: CommandSpec) =>
		`  ${usageLine(c).padEnd(width)}  ${c.summary}`;
	const folder = visible.filter((c) => c.path.length === 1);
	const folders = visible.filter((c) => c.path[0] === 'folders');
	const schema = visible.filter((c) => c.path[0] === 'schema');
	const auth = visible.filter((c) => c.path[0] === 'auth');
	return [
		`Usage: epicenter ${group ?? '<command>'} ... [--json]`,
		...(folder.length
			? ['', 'Folder commands take a folder by its path:', ...folder.map(line)]
			: []),
		...(folders.length
			? ['', 'Folders on this computer:', ...folders.map(line)]
			: []),
		...(schema.length
			? ['', 'Portable table schemas:', ...schema.map(line)]
			: []),
		...(auth.length ? ['', 'Your Epicenter account:', ...auth.map(line)] : []),
		'',
		'Every command takes --json: one JSON value on stdout, or NDJSON progress',
		'lines ending in one result for sync, clone, and auth login.',
		'Stderr is for people. Exit codes: 0 done, 1 a finding to act on, 2 input',
		'the command cannot use.',
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
	].join('\n');
}

function describe(command: CommandSpec) {
	return {
		command: name(command),
		usage: usageLine(command),
		summary: command.summary,
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
			const run = HANDLERS[name(invocation.command)] as Run;
			// Bun 1.3.14 can end the process while a command still awaits
			// `crypto.subtle` work started after a child process exited, as
			// isomorphic-git's hashing does between two `git` runs; a ref'd
			// timer keeps it running until the command returns.
			const alive = setInterval(() => {}, 2 ** 30);
			try {
				return await run(invocation);
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
