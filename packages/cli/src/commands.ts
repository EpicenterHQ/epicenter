/**
 * The commands `epicenter` keeps for itself, each with its usage and what
 * `epicenter <command> --help` says beneath it. The CLI dispatches from this
 * table and prints its help from it, and no app may be named one of its
 * words. Each command parses its own flags with `node:util`'s `parseArgs`,
 * and every misuse answers its usage line.
 */
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { ActionError, isName, Ok } from '@epicenter/app';

export const COMMANDS = {
	init: {
		usage: 'epicenter init [<folder>] [--port <n>] [--no-install]',
		help: `Makes a folder an Epicenter: one root Git repository with EPICENTER.md, a starter
AGENTS.md, and a package.json that makes it a Bun workspace depending on this
version of @epicenter/cli and @epicenter/app. Then runs bun install there, which
writes bun.lock and node_modules/. With --no-install it writes the files and
leaves the install to you. A package.json already there is kept as it is.
Epicenters cannot nest.`,
	},
	new: {
		usage:
			'epicenter new <name> [--from <folder> | --from <owner/repo/folder>[#<ref>]]',
		help: `Makes apps/<name>/code/ from blank code or committed source code and creates empty data/.
With --from, copy one app's code without its Git history or records, from a folder in a Git
checkout (a path: /, ./, ../, ~/) or a folder on GitHub at a branch, tag, or full commit.
To copy from another host, clone it first. Copies the source commit, and refuses a local
folder with uncommitted changes.
The app's code/package.json is named <name> and lists only its own packages: the copy's
name is rewritten, and its bun.lock and any @epicenter/app entry are left out, since the
home has one lock and one @epicenter/app. It runs nothing: it prints the command that
installs the app's packages and builds its UI, cd <home> && bun install && bun run build.`,
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
	check: {
		usage: 'epicenter check [<app>] [--json]',
		help: `Reads every data key of every app, or one app's, and reports each file that
does not fit its key's fields. Each key shows how many files it holds and how
many have problems, then each file's problems. Many files with one kind of
problem usually mean the declaration is too narrow, not the files. It reads
only. Exit 0 when nothing has a problem, 1 when a file has one or an app
could not be checked, and 2 when a named app does not load.`,
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
 * The words after `command`, parsed strictly against its own `options`, with
 * from `min` to `max` positionals. Any misuse is `NotStarted` (`usage`): the
 * command's usage line, with its help as the next step.
 */
export function parseWords<const O extends ParseArgsOptionsConfig>(
	command: Command,
	words: string[],
	options: O,
	[min, max]: [number, number],
) {
	const misused = ActionError.NotStarted({
		cause: 'usage',
		message: `Usage: ${COMMANDS[command].usage}`,
		next: `epicenter ${command} --help`,
	});
	try {
		const parsed = parseArgs({
			args: words,
			options,
			strict: true,
			allowPositionals: true,
		});
		const count = parsed.positionals.length;
		return count < min || count > max ? misused : Ok(parsed);
	} catch {
		return misused;
	}
}
