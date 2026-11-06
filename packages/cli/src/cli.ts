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
	check: async ({ positionals: [contract, dir], json }) =>
		(await import('./contract-commands.ts')).check(contract, dir, json),
	format: async ({ positionals: [contract, dir], json }) =>
		(await import('./contract-commands.ts')).format(
			contract as string,
			dir ?? '.',
			json,
		),
	sync: async ({ positionals: [dir], json, grant }) =>
		(await import('./sync/commands.ts')).syncCommand(dir, json, grant),
	clone: async ({ positionals: [source, dir], json, grant }) =>
		(await import('./sync/commands.ts')).cloneCommand(
			source as string,
			dir,
			json,
			grant,
		),
	log: async ({ positionals: [dir], options, json, grant }) =>
		(await import('./sync/commands.ts')).logCommand(dir, options, json, grant),
	diff: async ({ positionals: [dir], options, json, grant }) =>
		(await import('./sync/commands.ts')).diffCommand(dir, options, json, grant),
	restore: async ({ positionals: [commit, dir], options, json, grant }) =>
		(await import('./sync/commands.ts')).restoreCommand(
			commit as string,
			dir,
			options,
			json,
			grant,
		),
	repos: async ({ json, grant }) =>
		(await import('./repository-commands.ts')).repos(json, grant),
	share: async ({ positionals: [target, person], options, json, grant }) =>
		(await import('./repository-commands.ts')).share(
			target as string,
			person,
			options,
			json,
			grant,
		),
	unshare: async ({ positionals: [target, person], json, grant }) =>
		(await import('./repository-commands.ts')).unshare(
			target as string,
			person as string,
			json,
			grant,
		),
	'auth login': async ({ json, grant }) =>
		(await import('./auth-commands.ts')).authLogin(json, grant),
	'auth logout': async ({ json, grant }) =>
		(await import('./auth-commands.ts')).authLogout(json, grant),
	'auth status': async ({ json }) =>
		(await import('./auth-commands.ts')).authStatusCommand(json),
	'auth token': async ({ options, json, grant }) =>
		(await import('./auth-commands.ts')).authToken(options, json, grant),
};

/** What `epicenter <command> --help` adds below the usage line. */
const DETAILS: Record<string, string> = {
	check: `Checks every file in <dir>, by default this directory, against an app's
contract from <dir>/AGENTS.md. The explicit <contract> argument, a URL or a
file path, takes precedence. Prints one line per
problem, compiler style: a path no collection of the contract names, a note
whose front matter does not parse, or one whose fields do not fit. Hidden
paths (.git, .DS_Store, ...) are not the contract's and are skipped. Exits 0
when every file fits, 1 when one does not, and 2 when the contract or the
folder cannot be used. Never writes a file.`,
	format: `Rewrites every note in <dir>, by default this directory, that a collection
of the contract at <contract> (a URL or a file path) names, in house style:
the contract's fields first in its order, other keys after them sorted,
block YAML, the body untouched. A note whose front matter does not parse is
left as it is and named. Each note is replaced only while it still holds the
bytes read. Exits 0 when every note is in house style, 1 when one was left as
it is, and 2 when the contract or the folder cannot be used.`,
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
	repos: `Lists the repositories of every namespace this sign-in may reach: the
personal namespace first, then each group by title, as <namespace>/<name>.
Your personal namespace's id is your handle, which others share with. With
--json, {"namespaces": [{"id", "title", "personal", "role",
"repositories": [{"id", "name", "url"}]}]}.`,
	share: `Lets the person whose handle is <handle> (their personal namespace's id,
from their epicenter repos) read one of your repositories with --read, or
also push forward and write from the web with --write, replacing any access
they had. Only you may rewrite main or share it on. They clone it as
<owner>/<name>, your handle and its name. The repository is <owner>/<name>,
~/<name> (quoted, so the shell leaves it), or a folder cloned from it. Without
<handle>, lists who it is shared with. With --json, the grant
{"person", "level"}, or {"grants": [...]}. Exits 2 when refused.`,
	unshare: `Revokes the access of the person whose handle is <handle> to one of your
repositories. Their next fetch or push is refused; the files they already
have stay with them. With --json, {"person", "revoked"}. Exits 2 when
refused.`,
	sync: `Syncs <dir> (default: the current directory) with its repository on the
server, with no Git on this computer: what changed on either side since the
last sync is copied to the other, and a note both sides changed merges by
Epicenter's rules, front matter by key with this computer's change winning a
key both changed, and the body by line with one conflict block per clash. An
edit beats a delete, and a file both sides replaced keeps this computer's;
the other stays in the repository's history. A folder's first sync makes its
repository and records its id in .epicenter/synced.json. With --json, one
{"sync": {...}} line. Exits 0 when synced, 1 when a sync should run again or
the repository refused a file (a name differing only in case from one it
holds), and 2 when it could not sync.`,
	clone: `Records the repository <folder> names (its id, from epicenter repos, or
<namespace>/<name>, ~ for your own) in <dir>, by default a new folder named for
it here, and syncs it, bringing its files. A folder that already holds files
keeps them, merged on top. Plain Git clones the same repository at
<git origin>/<namespace>/<name>.git.`,
	log: `Lists the folder's history on the server, newest first: each commit's id,
time, and subject, marking the one this folder last agreed at. --limit takes
at most that many (20 by default).`,
	diff: `Without --since, lists the files this folder added, changed, or deleted
since its last sync, read from the folder alone. With --since <commit>, lists
the files the repository changed between that commit and its head.`,
	restore: `Writes the folder's files as they were at <commit> (from epicenter log),
removing files made since, or only the file at --path. Nothing reaches the
server until the next epicenter sync, which records it as a new change, so
the history keeps everything in between.`,
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
	const auth = visible.filter((c) => c.path[0] === 'auth');
	return [
		`Usage: epicenter ${group ?? '<command>'} ... [--json]`,
		...(folder.length
			? ['', 'Folder commands take a folder by its path:', ...folder.map(line)]
			: []),
		...(folders.length
			? ['', 'Folders on this computer:', ...folders.map(line)]
			: []),
		...(auth.length ? ['', 'Your Epicenter account:', ...auth.map(line)] : []),
		'',
		'Every command takes --json: one JSON value on stdout, or NDJSON progress',
		'lines for sync and auth login.',
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
			// `crypto.subtle` work started after a child process exited; a
			// ref'd timer keeps it running until the command returns.
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
