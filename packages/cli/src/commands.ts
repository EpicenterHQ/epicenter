/**
 * The commands `epicenter` keeps for itself, each with its usage. The CLI
 * dispatches from this table and prints its help from it, and no app may be
 * named one of its words.
 */
import { isName } from '@epicenter/app';

export const COMMANDS = {
	init: 'epicenter init [<folder>] [--port <n>]',
	new: 'epicenter new <name> [--from <git url|path>]',
	update: 'epicenter update [<app>]',
	build: 'epicenter build [<app>]',
	sync: 'epicenter sync [<app> [-m <message>]]',
	history: 'epicenter history <app> [--limit <n>]',
	undo: 'epicenter undo <app> [<commit>]',
	serve: 'epicenter serve [--port <n>] [--host <address>] [--stdio]',
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
