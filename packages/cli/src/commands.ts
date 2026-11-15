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
		help: `Makes a folder an Epicenter with one root Git repository, EPICENTER.md, and starter AGENTS.md.
With --from, clone the root repository and install each app's code packages.
The destination must be missing or empty. Epicenters cannot nest.`,
	},
	new: {
		usage: 'epicenter new <name> [--from <git url|path>]',
		help: `Makes apps/<name>/code/ from a template or committed source code and creates empty data/.
With --from <path|url>[#<folder>], copy the selected app's code without its Git history or records.
serve builds code/ui/ when it is opened.`,
	},
	export: {
		usage:
			'epicenter export <app> <directory> | epicenter export --all <directory>',
		help: `Regenerates one owned directory from committed app code. With --all, the directory
contains one child per app, including future committed apps; removed apps disappear.
Keep Git, handwritten notes and other publication files outside this directory.
Repeating the command replaces all generated contents, including local edits.
Exports exclude records, local files, dependencies, builds, provenance, and private history.
Uncommitted source changes are reported but not exported. Unrelated nonempty directories
and any Git metadata inside the destination are refused. All code is prepared before
refreshing; rerun after an interrupted fill. Review, commit and push with Git.`,
	},
	install: {
		usage: 'epicenter install [<app>]',
		help: `Installs each app's code/package.json, or one app's, with bun install
(--frozen-lockfile when bun.lock exists), then links node_modules/@epicenter/app
to this epicenter's own copy, which no app lists. new runs it;
a call never installs. After bun add, run epicenter install <app> to restore
the supplied link if Bun removed it.`,
	},
	build: {
		usage: 'epicenter build [<app>]',
		help: `Builds the UI of every app, or one app, from its ui/ as it is on disk now,
and shows the build's errors. serve rebuilds a UI on its own when a page opens
after its sources changed, and keeps serving the last good build meanwhile.`,
	},
	checkpoint: {
		usage: 'epicenter checkpoint [-m <message>] [--json]',
		help: 'Commit pending code and records in the root repository, then push to origin when set.',
	},
	serve: {
		usage: 'epicenter serve [--port <n>] [--host <address>]',
		help: `Offers every app's actions over MCP at /, each app's UI at /<app>/, and each
action to its UI at POST /<app>/<action>, on 127.0.0.1 and the Epicenter's port
(default 4747) unless --port or --host says otherwise. It runs every call itself,
from the app's code as it is on disk then. It backs up the root with checkpoint
when it starts, every 5 minutes, and when it stops. It has no sign-in: only this
computer and the tailnet should reach it.`,
	},
	service: {
		usage: 'epicenter service <install|uninstall|restart|status>',
		help: `Installs a macOS login job that keeps serve running for this Epicenter.
The person runs install and uninstall. Agents may safely run restart and status.
status --json reports whether the job is installed and running, its pid, and port.`,
	},
	routines: {
		usage: 'epicenter routines [run <name>]',
		help: `Lists the home's routines and their last outcomes, even while serve is stopped.
A routines/<name>.md declares daily: "08:00" and run: [executable, ...arguments].
serve checks at startup and once a minute, catching up once to the latest due time.
run explicitly runs one now, including a failed or interrupted attempt. It may
repeat effects. State and output stay in routines/<name>.local/.`,
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
