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

/** Whether this `epicenter` is the compiled binary, which is Bun itself under `BUN_BE_BUN=1`. */
export const COMPILED = Bun.main.startsWith('/$bunfs/');

export const COMMANDS = {
	init: {
		usage: 'epicenter init [<folder>] [--port <n> | --from <git url>]',
		help: `Makes a folder an Epicenter and writes EPICENTER.md and starter AGENTS.md.
The folder is a Git repository of its own too: it backs up what is not in an
app, and repositories.json in it lists every repository inside with its origin.
With --from, it rebuilds an Epicenter instead: it clones that repository into
the folder, which must be missing or empty, then clones each repository it
lists and installs each app. The folder defaults to the current directory.
Epicenters cannot nest.`,
	},
	new: {
		usage: 'epicenter new <name> [--from <git url|path>]',
		help: `Makes <Epicenter>/apps/<name>, two Git repositories: the folder holds the app's code,
and data/ inside it the app's data. With --from, it clones a starter (another
app's code) and keeps it as the app's upstream remote; without it, it starts
from an epicenter.ts and a .gitignore. serve builds the UI when it is opened.`,
	},
	update: {
		usage: 'epicenter update [<app> [<remote>]]',
		help: `Merges each app's upstream into its code, or one app's, or from the remote named:
it snapshots what is pending first and undoes a merge that stops on a conflict.
The data is never merged; serve rebuilds the UI from the merged code.`,
	},
	install: {
		usage: 'epicenter install [<app>]',
		help: `Installs each app's top-level package.json, or one app's, with bun install
(--frozen-lockfile when bun.lock exists), then links node_modules/@epicenter/app
to this epicenter's own copy, which no app lists. new and update run it;
a call never installs. After bun add, run epicenter install <app> to restore
the supplied link if Bun removed it.`,
	},
	build: {
		usage: 'epicenter build [<app>]',
		help: `Builds the UI of every app, or one app, from its ui/ as it is on disk now,
and shows the build's errors. serve rebuilds a UI on its own when a page opens
after its sources changed, and keeps serving the last good build meanwhile.`,
	},
	sync: {
		usage: 'epicenter sync [<app> [-m <message>]]',
		help: `Takes a snapshot of what is pending in each app's code and data, or one app's,
then pushes each to its own origin when it exists and the branch is ahead of
it. It never pushes anywhere else. The snapshot reads "<app>: changed outside epicenter", or with -m
(--message), "<app>: <message>": an agent that edited an app's files itself
names what it did this way.`,
	},
	history: {
		usage: 'epicenter history <app> [--limit <n>]',
		help: `Lists the app's snapshots of its code and its data together, newest first, 20
unless --limit says how many: each one's commit, local time, code or data,
subject, and the paths it changed. An undo reads as "undid <subject>".`,
	},
	undo: {
		usage: 'epicenter undo <app> [<commit>]',
		help: `Snapshots what is pending, then reverts the app's most recent data snapshot that
is not an undo and is not undone, or the data commit named, as "<app>: undid
<subject>". When the code has changed since that snapshot, it lists the code
commits since. Run it again to go further back; undo an undo to bring it back.
Code is reverted with git. It refuses a commit not in the app's data history and
a revert Git refuses, or that conflicts or changes nothing, leaving the folder as
it was. It never pushes; sync does.`,
	},
	serve: {
		usage: 'epicenter serve [--port <n>] [--host <address>]',
		help: `Offers every app's actions over MCP at /, each app's UI at /<app>/, and each
action to its UI at POST /<app>/<action>, on 127.0.0.1 and the Epicenter's port
(default 4747) unless --port or --host says otherwise. It runs every call itself,
from the app's code as it is on disk then. It backs up every app as sync does
when it starts, every 5 minutes, and when it stops. It has no sign-in: only this
computer and the tailnet should reach it.`,
	},
	service: {
		usage: 'epicenter service <install|uninstall|restart|status>',
		help: `Installs a macOS login job that keeps serve running for this Epicenter.
The person runs install and uninstall. Agents may safely run restart and status.
status --json reports whether the job is installed and running, its pid, and port.`,
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
