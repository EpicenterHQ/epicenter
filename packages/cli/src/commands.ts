/**
 * Every command the CLI runs (ADR-0558), in the order `--help` lists them.
 * Each has a handler in `cli.ts`.
 */

import type { CommandSpec } from './parse.ts';

export const COMMANDS: readonly CommandSpec[] = [
	{
		path: ['messages'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		hidden: true,
		summary: 'Beeper operation as JSON on stdin',
	},
	{
		path: ['schema', 'export'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: "print the folder's declared table schemas as JSON",
	},
	{
		path: ['schema', 'import'],
		args: '<dir> <file|->',
		minArgs: 2,
		maxArgs: 2,
		options: [{ name: 'replace' }],
		summary:
			'import every source table schema, preserving the rest of epicenter.json',
	},
	{
		path: ['documents-query'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		hidden: true,
		summary:
			'query saved Markdown documents for the desktop editor, SQL on stdin',
	},
	{
		path: ['check'],
		args: '<contract> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary: "report each file in a folder that does not fit an app's contract",
	},
	{
		path: ['format'],
		args: '<contract> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary: "rewrite every note an app's contract claims in house style",
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
		path: ['init'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [{ name: 'enclosing-ok' }],
		summary: 'set up or repair a data folder for sync, and register it',
	},
	{
		path: ['sync'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [
			{ name: 'watch' },
			{ name: 'interval', value: '<seconds>', hidden: true },
		],
		summary:
			'commit the folder, merge the remote by Epicenter rules, and push; every registered folder without <dir>',
		long: true,
	},
	{
		path: ['status'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		summary:
			'changed files, ahead and behind, and the remote; every registered folder without <dir>',
	},
	{
		path: ['clone'],
		args: '<namespace>/<name> | <url> | <path> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary:
			'clone, set up, and register a folder, by default ~/Epicenter/<name>',
	},
	{
		path: ['forget'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		summary: 'stop syncing a folder, leaving its files and history',
	},
	{
		path: ['merge-driver'],
		args: '<base> <ours> <theirs> [<path>]',
		minArgs: 3,
		maxArgs: 4,
		hidden: true,
		summary: "Git's merge driver for notes",
	},
	{
		path: ['repos'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: "the caller's repositories",
	},
	{
		path: ['share'],
		args: '<owner>/<name> | <dir> [<handle>]',
		minArgs: 1,
		maxArgs: 2,
		options: [{ name: 'read' }, { name: 'write' }],
		summary:
			'let another person read (--read) or also write (--write) your repository, or list who may',
	},
	{
		path: ['unshare'],
		args: '<owner>/<name> | <dir> <handle>',
		minArgs: 2,
		maxArgs: 2,
		summary: "revoke a person's access to your repository",
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
