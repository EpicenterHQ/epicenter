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
		path: ['status'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary:
			"the folders in the Epicenter folder, each one's state, and the shares waiting for you",
	},
	{
		path: ['init'],
		args: '[<path>]',
		minArgs: 0,
		maxArgs: 1,
		options: [{ name: 'title', value: '<title>' }, { name: 'dry-run' }],
		summary:
			"write a folder's epicenter.json, proposing collections from its files",
	},
	{
		path: ['sync'],
		args: '[<folder>]',
		minArgs: 0,
		maxArgs: 1,
		options: [
			{ name: 'join', value: '<id>' },
			{ name: 'create' },
			{ name: 'push-deletions' },
			{ name: 'restore-deletions' },
			{ name: 'all' },
		],
		summary:
			'sync a folder in the Epicenter folder with its folder on the server, asking which one first when it is not synced here',
		long: true,
	},
	{
		path: ['clone'],
		args: '[<folder> [<name>]]',
		minArgs: 0,
		maxArgs: 2,
		summary:
			'list your folders, or bring one into the Epicenter folder by its id or title, and sync it',
		long: true,
	},
	{
		path: ['log'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [
			{ name: 'path', value: '<path>' },
			{ name: 'at', value: '<moment>' },
			{ name: 'limit', value: '<n>' },
		],
		summary: "the folder's changes on the server, newest first",
	},
	{
		path: ['diff'],
		args: '[<dir>]',
		minArgs: 0,
		maxArgs: 1,
		options: [{ name: 'since', value: '<moment>' }],
		summary:
			'the files changed since the last sync, or on the server since a moment',
	},
	{
		path: ['restore'],
		args: '<moment> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		options: [{ name: 'path', value: '<path>' }],
		summary:
			"give a folder's files, or one with --path, back what they held at a moment, as a new change",
	},
	{
		path: ['share'],
		args: '<folder> [<email>]',
		minArgs: 1,
		maxArgs: 2,
		options: [{ name: 'role', value: 'member|reader' }],
		summary:
			'invite an email to a folder, or change the role of someone who holds it; or list who holds it',
	},
	{
		path: ['unshare'],
		args: '<folder> <email>',
		minArgs: 2,
		maxArgs: 2,
		summary:
			'take a person out of a folder or cancel their invitation; with your own email, leave it or decline',
	},
	{
		path: ['accept'],
		args: '[<folder>]',
		minArgs: 0,
		maxArgs: 1,
		summary:
			'accept a share into the Epicenter folder, or list the shares waiting for you',
		long: true,
	},
	{
		path: ['attach'],
		args: '<folder> <app>',
		minArgs: 2,
		maxArgs: 2,
		summary: 'let an app reach a folder: use this folder with it',
	},
	{
		path: ['detach'],
		args: '<folder> <app>',
		minArgs: 2,
		maxArgs: 2,
		summary: 'stop an app reaching a folder',
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
