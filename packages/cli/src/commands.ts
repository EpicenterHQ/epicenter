/**
 * The commands `epicenter` keeps for itself, each with its usage and what
 * `epicenter <command> --help` says beneath it. The CLI dispatches from this
 * table and prints its help from it, and no app may be named one of its
 * words. Each command parses its own flags with `node:util`'s `parseArgs`,
 * and every misuse answers its usage line.
 */
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { isName } from '@epicenter/app';
import { CliError } from './errors.ts';

export const COMMANDS = {
	init: {
		usage: 'epicenter init [<folder>] [--port <n>]',
		help: `Makes a folder an Epicenter and writes EPICENTER.md and starter AGENTS.md.
The folder defaults to the current directory. Epicenters cannot nest.`,
	},
	new: {
		usage: 'epicenter new <name> [--from <git url|path>]',
		help: `Makes <Epicenter>/<name>, a Git repository. With --from, it clones a starter (a
repository with no data), keeps it as the app's upstream remote, and builds its
UI; without it, it starts from an epicenter.ts and a .gitignore.`,
	},
	update: {
		usage: 'epicenter update [<app>]',
		help: `Merges each app's upstream, or one app's: it refuses an app with uncommitted
changes, undoes a merge that stops on a conflict, lists each file that no
longer fits its collection's fields, and builds the UI, keeping the last one that built.`,
	},
	build: {
		usage: 'epicenter build [<app>]',
		help: 'Builds the UI of every app, or one app, keeping each last good build.',
	},
	sync: {
		usage: 'epicenter sync [<app> [-m <message>]]',
		help: `Takes a snapshot of what is pending in each app, or one app, then pushes to
origin when it exists and the branch is ahead of it. It never pushes to
upstream. The snapshot reads "<app>: changed outside epicenter", or with -m
(--message), "<app>: <message>": an agent that edited an app's files itself
names what it did this way.`,
	},
	history: {
		usage: 'epicenter history <app> [--limit <n>]',
		help: `Lists the app's snapshots, newest first, 20 unless --limit says how many: each
one's commit, local time, and what it took. An undo reads as "undid <subject>".`,
	},
	undo: {
		usage: 'epicenter undo <app> [<commit>]',
		help: `Snapshots what is pending, then reverts the app's most recent snapshot that is
not an undo and is not undone, or the commit named, as "<app>: undid <subject>".
Run it again to go further back; undo an undo to bring it back. It refuses a
merge, a commit not in the app's history, and a revert that conflicts, leaving
the folder as it was. It never pushes; sync does.`,
	},
	serve: {
		usage: 'epicenter serve [--port <n>] [--host <address>] [--stdio]',
		help: `Offers every app's actions over MCP at / and each app's UI at /<app>/, on
127.0.0.1 and the Epicenter's port (default 4747) unless --port or --host says
otherwise. With --stdio, it speaks MCP on stdin and stdout instead. Over HTTP it
backs up every app as sync does when it starts, every 5 minutes, and when it
stops.`,
	},
} as const;

export type Command = keyof typeof COMMANDS;

/**
 * Why `name` cannot name an app, or `undefined` when it can: it must be
 * lowercase letters, digits, and dashes, starting with a letter, and not a
 * word the `epicenter` command keeps for itself.
 */
export function nameProblem(name: unknown): string | undefined {
	if (!isName(name))
		return `${JSON.stringify(name)} is not lowercase letters, digits, and dashes, starting with a letter`;
	if (Object.hasOwn(COMMANDS, name)) return `"${name}" is an epicenter command`;
	return undefined;
}

/**
 * A misuse of `command`: its usage line, after `why` when a value is wrong
 * in a way the usage line does not show, with its help as the next step.
 */
export function misuse(command: Command, why?: string) {
	return CliError.Usage({
		message: `${why ? `${why}\n` : ''}Usage: ${COMMANDS[command].usage}`,
		next: `epicenter ${command} --help`,
	}).error;
}

/**
 * The words after a command, parsed strictly against its own `options`, with
 * from `min` to `max` positionals; `undefined` for any misuse.
 */
export function parseWords<const O extends ParseArgsOptionsConfig>(
	words: string[],
	options: O,
	[min, max]: [number, number],
) {
	try {
		const parsed = parseArgs({
			args: words,
			options,
			strict: true,
			allowPositionals: true,
		});
		const count = parsed.positionals.length;
		return count < min || count > max ? undefined : parsed;
	} catch {
		return undefined;
	}
}

/** A port as `--port` gives it, or `undefined` when it is not a whole number from 0 to 65535. */
export function portOf(value: string): number | undefined {
	const port = Number(value);
	return /^\d+$/.test(value) && port <= 65535 ? port : undefined;
}

/** Why `--port` is wrong, for `misuse`. */
export const BAD_PORT = '--port must be a whole number from 0 to 65535';
