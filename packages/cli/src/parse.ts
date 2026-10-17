/**
 * The command line's grammar: a verb, or a group and a verb, then
 * positionals and the options that command declares (ADR-0558).
 *
 * Options are matched exactly, so a positional that starts with `--`, such
 * as a SQL statement that opens with a comment, stays a positional. A token
 * shaped like an option the command does not declare is refused rather than
 * read as a positional. After `--`, every token is a positional.
 */

import type { GrantKind } from './auth.ts';

/** An option a command declares. `value` names its argument; without one it is a switch. */
export type OptionSpec = {
	readonly name: string;
	readonly value?: string;
	/** Left out of `--help`, as `--allow-unrelated` is. */
	readonly hidden?: boolean;
	/** A one-letter spelling, as `-m` is for `--message`. */
	readonly short?: string;
};

/** One command as the parser and `--help` see it. */
export type CommandSpec = {
	/** `['check']`, or a group and its verb: `['app', 'install']`. */
	readonly path: readonly string[];
	/** The positionals as `--help` prints them, such as `<dir> [<sql>]`. */
	readonly args: string;
	readonly minArgs: number;
	readonly maxArgs: number;
	readonly options?: readonly OptionSpec[];
	readonly summary: string;
	/** Prints NDJSON progress lines and one result line with `--json`. */
	readonly long?: boolean;
	/** Left out of `--help`: run by the desktop app, not typed. */
	readonly hidden?: boolean;
};

/** What a command line asks for. */
export type Invocation =
	| { kind: 'help'; group?: string; command?: CommandSpec; json: boolean }
	| { kind: 'version'; json: boolean }
	| {
			kind: 'command';
			command: CommandSpec;
			positionals: string[];
			options: Record<string, string | true>;
			json: boolean;
			/**
			 * The grant a command uses: `desktop` under the hidden `--desktop`,
			 * which Rust runs every command with, and `device` otherwise
			 * (ADR-0558).
			 */
			grant: GrantKind;
	  }
	| { kind: 'usage'; message: string; group?: string; json: boolean };

const OPTION_SHAPE = /^--[A-Za-z][A-Za-z0-9-]*(=|$)/;

/** Parse `argv` (without the program) against `commands`. */
export function parseArgs(
	argv: readonly string[],
	commands: readonly CommandSpec[],
): Invocation {
	const rest: string[] = [];
	let json = false;
	let help = false;
	let version = false;
	let literal = false;
	let grant: GrantKind = 'device';
	for (const token of argv) {
		if (literal) rest.push(token);
		else if (token === '--') {
			literal = true;
			rest.push(token);
		} else if (token === '--json') json = true;
		else if (token === '--help' || token === '-h') help = true;
		else if (token === '--version' || token === '-V') version = true;
		// Hidden: Rust runs every command with it to select the desktop grant
		// (ADR-0558).
		else if (token === '--desktop') grant = 'desktop';
		else rest.push(token);
	}

	const [first, second] = rest;
	if (first === undefined || first === '--' || first.startsWith('-')) {
		if (version && first === undefined) return { kind: 'version', json };
		if (help || first === undefined) return { kind: 'help', json };
		return { kind: 'usage', message: `Unknown option '${first}'`, json };
	}
	if (first === 'help' && !help) return { kind: 'help', json };

	const groups = new Set(
		commands.filter((c) => c.path.length > 1).map((c) => c.path[0]),
	);
	let command: CommandSpec | undefined;
	let consumed: number;
	if (groups.has(first)) {
		command = commands.find(
			(c) => c.path.length === 2 && c.path[0] === first && c.path[1] === second,
		);
		if (command === undefined) {
			if (help) return { kind: 'help', group: first, json };
			return {
				kind: 'usage',
				message:
					second === undefined
						? `epicenter ${first} needs a command`
						: `Unknown command 'epicenter ${first} ${second}'`,
				group: first,
				json,
			};
		}
		consumed = 2;
	} else {
		command = commands.find((c) => c.path.length === 1 && c.path[0] === first);
		if (command === undefined)
			return { kind: 'usage', message: `Unknown command '${first}'`, json };
		consumed = 1;
	}
	if (help) return { kind: 'help', command, json };

	const name = `epicenter ${command.path.join(' ')}`;
	const positionals: string[] = [];
	const options: Record<string, string | true> = {};
	const tokens = rest.slice(consumed);
	let afterSeparator = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] as string;
		if (afterSeparator) {
			positionals.push(token);
			continue;
		}
		if (token === '--') {
			afterSeparator = true;
			continue;
		}
		const short = command.options?.find(
			(o) => o.short !== undefined && token === `-${o.short}`,
		);
		if (short === undefined && !OPTION_SHAPE.test(token)) {
			positionals.push(token);
			continue;
		}
		const equals = short === undefined ? token.indexOf('=') : -1;
		const key =
			short?.name ?? token.slice(2, equals === -1 ? undefined : equals);
		const option = short ?? command.options?.find((o) => o.name === key);
		if (option === undefined)
			return {
				kind: 'usage',
				message: `${name} does not take --${key}`,
				json,
			};
		if (option.value === undefined) {
			if (equals !== -1)
				return {
					kind: 'usage',
					message: `--${key} takes no value`,
					json,
				};
			options[key] = true;
			continue;
		}
		const value = equals === -1 ? tokens[++index] : token.slice(equals + 1);
		if (value === undefined || value === '')
			return {
				kind: 'usage',
				message: `--${key} needs ${option.value}`,
				json,
			};
		options[key] = value;
	}
	if (
		positionals.length < command.minArgs ||
		positionals.length > command.maxArgs
	)
		return {
			kind: 'usage',
			message: `Usage: ${usageLine(command)}`,
			json,
		};
	return { kind: 'command', command, positionals, options, json, grant };
}

/** `epicenter sync <dir> [--to <namespace>/<name>]`, without hidden options. */
export function usageLine(command: CommandSpec) {
	const options = (command.options ?? [])
		.filter((o) => !o.hidden)
		.map((o) => {
			const name = o.short ? `-${o.short}|--${o.name}` : `--${o.name}`;
			return o.value ? `[${name} ${o.value}]` : `[${name}]`;
		});
	return ['epicenter', ...command.path, command.args, ...options]
		.filter(Boolean)
		.join(' ');
}
