/**
 * Every command the CLI runs (ADR-0558), in the order `--help` lists them.
 * Each has a handler in `cli.ts`.
 */

import type { CommandSpec } from './parse.ts';

export const COMMANDS: readonly CommandSpec[] = [
	{
		path: ['folders', 'add'],
		args: '<directory>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'add an existing folder to this machine’s list',
	},
	{
		path: ['folders', 'list'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'list added folders and their availability',
	},
	{
		path: ['folders', 'forget'],
		args: '<directory>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'remove a shortcut without changing its files',
	},
	{
		path: ['check'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'report each file in a data folder that does not conform',
	},
	{
		path: ['query'],
		args: '<dir> [<sql>]',
		minArgs: 1,
		maxArgs: 2,
		summary:
			'describe the tables, or answer one read-only SQL statement over the files that conform',
	},
	{
		path: ['generate'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'run <dir>/epicenter.ts and write the epicenter.json it declares',
	},
	{
		path: ['status'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'changed files, ahead and behind, and the remote',
	},
	{
		path: ['history'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		options: [{ name: 'depth', value: '<n>' }],
		summary: 'the versions of the folder',
		hidden: true,
	},
	{
		path: ['save-version'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		options: [{ name: 'message', value: '<text>', short: 'm' }],
		summary: "commit the folder's edits as a version",
		hidden: true,
	},
	{
		path: ['sync'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		options: [
			{ name: 'to', value: '<namespace>/<name>' },
			{ name: 'allow-unrelated', hidden: true },
		],
		summary: 'fetch, merge by unit, commit, and push',
		long: true,
	},
	{
		path: ['clone'],
		args: '<namespace>/<name> | <url> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary: 'clone into <dir>, by default ~/Epicenter/<name>',
		long: true,
	},
	{
		path: ['repos'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: "the caller's repositories",
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
	{
		path: ['auth', 'git-credential'],
		args: 'get | store | erase',
		minArgs: 1,
		maxArgs: 1,
		summary: "Git's credential helper for the deployment's Git origin",
	},
	{
		path: ['auth', 'key'],
		args: 'set | remove | state <id>',
		minArgs: 2,
		maxArgs: 2,
		summary:
			"an AI connection's endpoint and key in this computer's keychain; set reads them on stdin",
	},
	{
		path: ['send'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary:
			'send one request over an AI connection for the desktop app, request on stdin',
		long: true,
		hidden: true,
	},
	{
		path: ['whispering-connection', 'read'],
		args: '<transcription|text>',
		minArgs: 1,
		maxArgs: 1,
		summary:
			"read one of Whispering's connection rows in so.epicenter for the desktop app",
		hidden: true,
	},
	{
		path: ['whispering-connection', 'set'],
		args: '<transcription|text>',
		minArgs: 1,
		maxArgs: 1,
		summary:
			"save one of Whispering's connection rows in so.epicenter for the desktop app, change on stdin",
		hidden: true,
	},
	{
		path: ['install-command'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'link ~/.local/bin/epicenter to this binary',
		hidden: true,
	},
];
