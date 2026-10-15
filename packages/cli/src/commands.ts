/**
 * Every command ADR-0558 names, in the order `--help` lists them. A command
 * with no handler in `cli.ts` parses, shows in `--help` as not built, and
 * exits 2 pointing at its record.
 */

import type { CommandSpec } from './parse.ts';

const ADR_PATHS: Record<string, string> = {
	'ADR-0520': 'docs/adr/0520-the-cli-acts-on-a-data-folder-by-its-path.md',
	'ADR-0527':
		'docs/adr/0527-a-data-folder-may-keep-its-declaration-as-typescript.md',
	'ADR-0556':
		'docs/adr/0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md',
	'ADR-0558':
		'docs/adr/0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md',
	'ADR-0559':
		'docs/adr/0559-all-desktop-git-runs-in-the-epicenter-cli-over-system-git.md',
};

/** `ADR-0558 (docs/adr/0558-….md)`, where a record lives in the repository. */
export function adrPointer(adr: string) {
	const path = ADR_PATHS[adr];
	return path ? `${adr} (${path})` : adr;
}

export const COMMANDS: readonly CommandSpec[] = [
	{
		path: ['check'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'report each file in a data folder that does not conform',
		adr: 'ADR-0520',
	},
	{
		path: ['query'],
		args: '<dir> [<sql>]',
		minArgs: 1,
		maxArgs: 2,
		summary:
			'describe the tables, or answer one read-only SQL statement over the files that conform',
		adr: 'ADR-0520',
	},
	{
		path: ['generate'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'run <dir>/epicenter.ts and write the epicenter.json it declares',
		adr: 'ADR-0527',
	},
	{
		path: ['status'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'changed files, ahead and behind, and the remote',
		adr: 'ADR-0558',
	},
	{
		path: ['history'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'the versions of the folder',
		adr: 'ADR-0559',
		hidden: true,
	},
	{
		path: ['save-version'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		summary: "commit the folder's edits as a version",
		adr: 'ADR-0559',
		hidden: true,
	},
	{
		path: ['sync'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		options: [
			{ name: 'to', value: '<namespace>/<name>' },
			{ name: 'resolve', value: '<choices.json>' },
		],
		summary: 'fetch, merge by file kind, commit, and push',
		adr: 'ADR-0558',
		long: true,
	},
	{
		path: ['clone'],
		args: '<namespace>/<name> | <url> [<dir>]',
		minArgs: 1,
		maxArgs: 2,
		summary: 'clone into <dir>, by default ~/Epicenter/<name>',
		adr: 'ADR-0558',
		long: true,
	},
	{
		path: ['repos'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: "the caller's repositories",
		adr: 'ADR-0558',
	},
	{
		path: ['open'],
		args: '<dir>',
		minArgs: 1,
		maxArgs: 1,
		options: [{ name: 'app', value: '<id>' }],
		summary: 'open the folder in Epicenter',
		adr: 'ADR-0558',
	},
	{
		path: ['app', 'list'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		options: [{ name: 'repository', value: '<url>' }],
		summary:
			'the apps installed on this machine, or with --repository the apps in a repository',
		adr: 'ADR-0558',
	},
	{
		path: ['app', 'install'],
		args: '<url>',
		minArgs: 1,
		maxArgs: 1,
		options: [{ name: 'folder', value: '<path>' }, { name: 'approve' }],
		summary: 'install an app from a folder in a Git repository',
		adr: 'ADR-0558',
		long: true,
	},
	{
		path: ['app', 'update'],
		args: '<id>',
		minArgs: 1,
		maxArgs: 1,
		options: [
			{ name: 'approve' },
			{ name: 'commit', value: '<sha>', hidden: true },
		],
		summary: 'update an installed app',
		adr: 'ADR-0558',
		long: true,
	},
	{
		path: ['app', 'remove'],
		args: '<id>',
		minArgs: 1,
		maxArgs: 1,
		summary: 'remove an installed app',
		adr: 'ADR-0558',
	},
	{
		path: ['auth', 'login'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		options: [{ name: 'loopback', hidden: true }],
		summary: 'sign in with a device code',
		adr: 'ADR-0558',
	},
	{
		path: ['auth', 'logout'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'sign out',
		adr: 'ADR-0558',
	},
	{
		path: ['auth', 'status'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'who is signed in on this machine',
		adr: 'ADR-0558',
	},
	{
		path: ['auth', 'token'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		options: [{ name: 'resource', value: '<url>' }],
		summary: 'print an access token',
		adr: 'ADR-0558',
	},
	{
		path: ['auth', 'git-credential'],
		args: 'get | store | erase',
		minArgs: 1,
		maxArgs: 1,
		summary: "Git's credential helper for git.epicenter.so",
		adr: 'ADR-0558',
	},
	{
		path: ['send'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		summary: 'send one request for the desktop app, body on stdin',
		adr: 'ADR-0556',
		long: true,
		hidden: true,
	},
	{
		path: ['install-command'],
		args: '',
		minArgs: 0,
		maxArgs: 0,
		options: [{ name: 'dry-run' }],
		summary: 'link this binary onto PATH as epicenter',
		adr: 'ADR-0556',
		hidden: true,
	},
];
