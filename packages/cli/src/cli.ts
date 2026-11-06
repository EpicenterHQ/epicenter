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
	status: async ({ json }) =>
		(await import('./folder-commands.ts')).statusCommand(json),
	init: async ({ positionals: [path], options, json }) =>
		(await import('./folder-commands.ts')).initCommand(path, options, json),
	sync: async ({ positionals: [dir], options, json }) =>
		(await import('./sync/commands.ts')).syncCommand(dir, options, json),
	clone: async ({ positionals: [source, dir], json }) =>
		(await import('./sync/commands.ts')).cloneCommand(source, dir, json),
	log: async ({ positionals: [dir], options, json }) =>
		(await import('./sync/history.ts')).logCommand(dir, options, json),
	history: async ({ positionals: [path], options, json }) =>
		(await import('./sync/history.ts')).historyCommand(
			path as string,
			options,
			json,
		),
	show: async ({ positionals: [path], options, json }) =>
		(await import('./sync/history.ts')).showCommand(
			path as string,
			options,
			json,
		),
	at: async ({ positionals: [moment, dir], json }) =>
		(await import('./sync/history.ts')).atCommand(moment as string, dir, json),
	mark: async ({ positionals: [name, dir], options, json }) =>
		(await import('./sync/history.ts')).markCommand(name, dir, options, json),
	diff: async ({ positionals: [dir], options, json }) =>
		(await import('./sync/history.ts')).diffCommand(dir, options, json),
	restore: async ({ positionals: [moment, dir], options, json }) =>
		(await import('./sync/history.ts')).restoreCommand(
			moment as string,
			dir,
			options,
			json,
		),
	share: async ({ positionals: [folder, person], options, json }) =>
		(await import('./folder-commands.ts')).shareCommand(
			folder as string,
			person,
			options,
			json,
		),
	unshare: async ({ positionals: [folder, person], json }) =>
		(await import('./folder-commands.ts')).unshareCommand(
			folder as string,
			person as string,
			json,
		),
	accept: async ({ positionals: [folder], json }) =>
		(await import('./folder-commands.ts')).acceptCommand(folder, json),
	attach: async ({ positionals: [folder, app], json }) =>
		(await import('./folder-commands.ts')).attachCommand(
			folder as string,
			app as string,
			true,
			json,
		),
	detach: async ({ positionals: [folder, app], json }) =>
		(await import('./folder-commands.ts')).attachCommand(
			folder as string,
			app as string,
			false,
			json,
		),
	'auth login': async ({ json }) =>
		(await import('./auth-commands.ts')).authLogin(json),
	'auth logout': async ({ json }) =>
		(await import('./auth-commands.ts')).authLogout(json),
	'auth status': async ({ json }) =>
		(await import('./auth-commands.ts')).authStatusCommand(json),
	'auth token': async ({ options, json }) =>
		(await import('./auth-commands.ts')).authToken(options, json),
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
	status: `Lists every folder in the Epicenter folder (~/Epicenter, or ~/Epicenter Dev
in development): its title, and whether it is on this computer only, synced,
shared (with who holds it), or kept by Git, which Epicenter never syncs. A
folder on this computer only names the folders it could be. Below them, the
shares waiting for you and the folders you hold that this computer does not.
It says so when the Epicenter folder is inside a file-sync service, which
Epicenter refuses to sync. Signed out or offline, it lists what this computer
holds. With --json, {"root", "folders", "pending", "elsewhere", "unreadable",
"fileSync", "offline"}.`,
	init: `Writes <path>'s epicenter.json (this directory by default): its title (the
directory's name, or --title), and the collections its files suggest, a
pattern per directory, {name} the item's file name. A directory's notes
become one collection with a field for each front matter key, typed by its
values; its other files another. Files directly in the folder, and notes
whose front matter does not read, are left out, each with why. A folder
needs no epicenter.json to sync; it adds checking. Refuses a folder that has
one. --dry-run prints the proposal and writes nothing.`,
	share: `Invites <email> to the folder (a path that has synced, or a folder id), as
a member, or with --role reader as a reader, who syncs it without changing
it. The folder is theirs once whoever signs in with that email, verified,
accepts it (epicenter accept), whether they have an account now or sign up
later; the answer is the same either way. For someone who holds it already,
it changes their role. Without <email>, lists who holds the folder and who
is invited. Every member shares; a reader does not. With --json, {"share":
{"folder", "person", "role", "pending"}}, or the folder. Exits 2 when
refused.`,
	unshare: `Takes the person who signs in as <email> out of the folder, or cancels the
invitation to <email>; their next sync is refused, and the files they have
stay with them. Every member does this; with your own email, you leave the
folder, or decline an invitation waiting for you. When the last person
leaves, the folder is deleted from the server. With --json, {"unshare":
{"folder", "person", "removed", "folderGone"}}.`,
	accept: `Accepts the share of <folder> (its id, or its title) waiting for you, and
brings it into the Epicenter folder beside your own, in a new folder named
for its title. Without <folder>, lists the shares waiting for you.`,
	attach: `Lets the app that signs in as <app> (such as so.epicenter.todos) reach the
folder: an app reaches only the folders attached to it, and its first sync
attaches the folder it makes. Only Epicenter and this command attach one.`,
	detach: `Stops the app <app> reaching the folder. Its files stay where they are.`,
	sync: `Syncs <folder> (a folder in the Epicenter folder, by its path or name; the
current directory by default) with its folder on the server, with no Git on
this computer: what changed on either side since the last sync is copied to
the other, and a note both sides changed merges by Epicenter's rules, front
matter by key with this computer's change winning a key both changed, and the
body by line with one conflict block per clash. An edit beats a delete, and a
file both sides replaced keeps this computer's; the other stays in the
folder's history.

What this computer synced is recorded at the Epicenter folder's root, one
record per folder, and a folder syncs from that record only when this
directory is proven the one that synced it: the same inode and birth time, or,
after a move to a new computer, the same name and exactly the same files in a
folder only you hold. A folder not proven so asks which folder it is before
anything is sent, listing the folders you hold that it could be (by name or
title, with who holds them): answer --join <id>, or --create to make it a new
folder. With nothing it could be, it becomes a new folder; with one folder you
hold alone, it joins that one. A join starts from first contact, which never
deletes on either side. A folder kept by Git is never synced.

A sync that would delete 20 or more files on the server, or 5 or more that
are half the folder, sends nothing and says which: --push-deletions deletes
them there, and --restore-deletions brings them back here. --all syncs every
folder in the Epicenter folder that moved, asking the server once where every
folder is, and a folder an app made as if you had named it. With --json, one
{"sync": {...}} or {"question": {...}} line per folder. Exits 0 when synced, 1
when a sync should run again, the repository refused a file (a name differing
only in case from one it holds), a folder asks which one it is, or deletions
wait for an answer, and 2 when it could not sync.`,
	clone: `Without <folder>, lists the folders you hold: id, title, and who holds them.
With one (its id, or its title when one folder has it), brings it into a new
folder in the Epicenter folder, named <name> or for its title, and syncs it,
taking its files. Plain Git clones the same history at
<git origin>/folders/<id>.git.`,
	log: `Lists the folder's changes on the server, newest first: each change's
number, time, author, what it wrote, and its marks, noting the one this folder
last agreed at. --path lists only the changes to one file, --at starts from a
moment, and --limit takes at most that many (20 by default). A moment is a
change's number, a mark's name, or a time.`,
	history: `Lists each version of the file at <path> (a file in a folder synced
here) on the server, newest first: the change that wrote it, when, who, its
version and size, or that it was deleted, with the change's marks. --at starts
from a moment; --limit takes at most that many (50 by default).`,
	show: `Writes the file at <path> as the server holds it to stdout, or as it was
at --at <moment> (a change's number, a mark, or a time). With --json,
{"show": {"path", "seq", "version", "size", "text"}}.`,
	at: `Lists the folder's files as they were at <moment> (a change's number, a
mark's name, or a time), each with its version and size.`,
	mark: `Names the folder's last change on the server <name>, so log, history,
show, at, diff, and restore reach it by name, and epicenter export --git writes
it as a tag. A name that marks another change stays unless --move. Without a
name, lists the folder's marks.`,
	diff: `Without --since, lists the files this folder added, changed, or deleted
since its last sync, read from the folder alone. With --since <moment> (a
change's number, a mark, or a time), lists the files the server changed
between that moment and now.`,
	restore: `Makes one change on the server that gives the folder's files back the
versions they held at <moment> (a change's number, a mark, or a time),
removing files made since, or restores only the file at --path. It names
versions the server keeps, so no bytes travel, and the history keeps
everything in between. Run epicenter sync to bring it here.`,
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
