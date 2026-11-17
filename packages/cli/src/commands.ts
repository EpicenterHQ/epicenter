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
		usage: 'epicenter init [<folder>] [--port <n>]',
		help: `Makes a folder an Epicenter with one root Git repository, EPICENTER.md, and starter AGENTS.md.
Epicenters cannot nest.`,
	},
	new: {
		usage:
			'epicenter new <name> [--from <folder> | --from <owner/repo/folder>[#<ref>]]',
		help: `Makes apps/<name>/code/ from blank code or committed source code and creates empty data/.
With --from, copy one app's code without its Git history or records, from a folder in a Git
checkout (a path: /, ./, ../, ~/) or a folder on GitHub at a branch, tag, or full commit.
To copy from another host, clone it first. Copies the source commit, not its working files;
local differences are reported and left out.
serve builds code/ui/ when it is opened.`,
	},
	export: {
		usage:
			'epicenter export <app> <directory> | epicenter export --all <directory>',
		help: `Regenerates one owned directory from an app's committed code. With --all, the directory
contains one child per app, including future committed apps; removed apps disappear.
It reads the last commit and commits nothing: an app whose code/ has uncommitted
changes is refused until you commit them.
Keep Git, handwritten notes and other publication files outside this directory.
Repeating the command replaces all generated contents, including local edits.
Exports exclude records, local files, dependencies, builds, provenance, and private history.
Unrelated nonempty destinations and Git metadata inside them are refused. All code is prepared before
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
	check: {
		usage: 'epicenter check [<app>] [--json]',
		help: `Reads every data key of every app, or one app's, and reports each file that
does not fit its key's fields. Each key shows how many files it holds and how
many have problems, then each file's problems. Many files with one kind of
problem usually mean the declaration is too narrow, not the files. It reads
only. Exit 1 when any file has a problem or an app could not be checked.`,
	},
	serve: {
		usage: 'epicenter serve',
		help: `Offers every app's actions over MCP at /, each app's UI at /<app>/, and each
action to its UI at POST /<app>/<action>, on 127.0.0.1 at the port in
EPICENTER.md (default 4747). A home has one serve, and it runs every action:
epicenter <app> <action> sends its call here and is refused while serve is
stopped. Each call runs from the app's code as it is on disk then, to its end,
and serve keeps nothing about it. It runs the home's routines: a
routines/<name>.md declares cron: "0 8 * * *" and run: [executable,
...arguments], and once a minute serve starts each routine whose schedule had
an occurrence since its last check. It records nothing about them, and
epicenter on its own lists them. Serve commits nothing: Git stores the home,
and a new home commits itself with routines/checkpoint.md. It has no sign-in
and answers only this computer. To reach it from your other devices, run a private proxy
such as: tailscale serve --bg 4747`,
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

/** A port as `init --port` gives it, or `undefined` when it is not a whole number from 1 to 65535. */
export function portOf(value: string): number | undefined {
	const port = Number(value);
	return /^\d+$/.test(value) && port >= 1 && port <= 65535 ? port : undefined;
}

/** Why `--port` is wrong, for `misuse`. */
export const BAD_PORT = '--port must be a whole number from 1 to 65535';
