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
		path: ['check'],
		args: '[<dir> | <contract> [<dir>]]',
		minArgs: 0,
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
		path: ['sync'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		summary:
			"sync a folder with its repository, making the repository at the folder's first sync",
		long: true,
	},
	{
		path: ['clone'],
		args: '<folder> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary:
			'bring a repository into a folder by its id or <namespace>/<name>, and sync it',
		long: true,
	},
	{
		path: ['log'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [{ name: 'limit', value: '<n>' }],
		summary: "the folder's history on the server, newest first",
	},
	{
		path: ['diff'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [{ name: 'since', value: '<commit>' }],
		summary:
			'the files changed since the last sync, or on the server since a commit',
	},
	{
		path: ['restore'],
		args: '<commit> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		options: [{ name: 'path', value: '<path>' }],
		summary:
			"make a folder's files, or one with --path, what they were at a commit",
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
];
