/**
 * The commands `epicenter` keeps for itself, each with its usage and what
 * `epicenter <command> --help` says beneath it. The CLI dispatches from this
 * table and prints its help from it, and no app may be named one of its
 * words. No command takes a flag of its own, and every misuse answers its
 * usage line.
 */
import { parseArgs } from 'node:util';
import { ActionError, isName, Ok } from '@epicenter/app';

export const COMMANDS = {
	check: {
		usage: 'epicenter check [<app>] [--json]',
		help: `Reads every data key of every app, or one app's, and reports each file that
does not fit its key's fields. Each key shows how many files it holds and how
many have problems, then each file's problems. Many files with one kind of
problem usually mean the declaration is too narrow, not the files. It reads
only. An app whose local/ has no .gitignore is listed with the command that
adds one. Exit 0 when nothing has a problem, 1 when a file or an app has one,
and 2 when a named app does not load.`,
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
and its owner commits it. It has no sign-in and answers only this computer.
To reach it from your other devices, run a private proxy such as:
tailscale serve --bg 4747`,
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
 * The words after `command`, from `min` to `max` of them and no flag. Any
 * misuse is `NotStarted` (`usage`): the command's usage line, with its help
 * as the next step.
 */
export function parseWords(
	command: Command,
	words: string[],
	[min, max]: [number, number],
) {
	const misused = ActionError.NotStarted({
		cause: 'usage',
		message: `Usage: ${COMMANDS[command].usage}`,
		next: `epicenter ${command} --help`,
	});
	try {
		const { positionals } = parseArgs({
			args: words,
			options: {},
			strict: true,
			allowPositionals: true,
		});
		const count = positionals.length;
		return count < min || count > max ? misused : Ok(positionals);
	} catch {
		return misused;
	}
}
