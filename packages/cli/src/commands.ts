/**
 * Every command the CLI runs (ADR-0558), in the order `--help` lists them:
 * each platform operation in `operations.ts`, rendered as a command, then
 * the CLI's own, which are not platform operations and so not tools: `mcp`,
 * which serves the operations to an agent, `auth`, the CLI's own sign-in,
 * and `messages`, run by another program. Each of the CLI's own has a
 * handler in `cli.ts`.
 */

import { commandOf } from './operation.ts';
import { OPERATIONS } from './operations.ts';
import type { CommandSpec } from './parse.ts';

/** The CLI's own commands. */
export const CLI_COMMANDS: readonly CommandSpec[] = [
	{
		path: ['messages'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		hidden: true,
		summary: 'Beeper operation as JSON on stdin',
	},
	{
		path: ['mcp'],
		args: '[<dir> ...]',
		minArgs: 0,
		maxArgs: Number.POSITIVE_INFINITY,
		options: [{ name: 'all' }],
		summary:
			"serve every operation, and each folder's collections, to an agent as MCP tools on stdin and stdout",
	},
	{
		path: ['auth', 'login'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'sign in with a device code',
		long: true,
	},
	{
		path: ['auth', 'logout'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'sign this computer out and revoke its tokens',
	},
	{
		path: ['auth', 'status'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'who is signed in on this machine',
	},
	{
		path: ['auth', 'token'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		options: [{ name: 'resource', value: '<url>' }],
		summary: 'print an access token, by default for the API',
	},
];

/** Every command, operations first. */
export const COMMANDS: readonly CommandSpec[] = [
	...OPERATIONS.map(commandOf),
	...CLI_COMMANDS,
];
