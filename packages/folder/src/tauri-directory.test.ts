/**
 * The desktop opener: `grant_directory` hands over the directory, and the
 * folder is read through Tauri's fs plugin and changed through the shell's
 * commands. Both are replaced by stand-ins that reach the disk through
 * `node:fs` and fail as the plugins do, with the operating system's message
 * as text.
 *
 * Key behaviors:
 * - A granted folder opens over its real directory and commits with `git`
 * - Every refused or failed grant is an `OpenFolderError` and opens nothing
 * - A removal whose reply is lost is done if the path is gone, and
 *   `Unconfirmed` if it is still there
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { OpenFolderError } from './errors.js';
import { createGitRunner } from './git/native-host.js';
import { GIT_ENV, git, scratch } from './git-http.test-support.js';
import { installWebLocks } from './web-locks.test-support.js';

type Call = { cmd: string; args: Record<string, unknown> };
let grantedRoot: string | undefined;
let calls: Call[] = [];
let grant: (args: Record<string, unknown>) => unknown = () => {
	throw new Error('no grant scripted');
};
/** Runs after the shell's removal and may lose its reply by throwing. */
let afterRemove: (path: string) => void = () => {};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	async invoke(cmd: string, args: Record<string, unknown> = {}) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		calls.push({ cmd: name, args });
		if (name === 'grant_directory') return grant(args);
		// The shell runs the folder's Git; here the system `git` stands in.
		if (name === 'run_git') {
			const root = grantedRoot;
			if (root === undefined)
				throw { name: 'Unavailable', message: 'not granted' };
			const result = await createGitRunner(root)(args.args as string[], {
				input:
					args.input === null
						? undefined
						: new Uint8Array(args.input as number[]),
				env:
					args.indexFile === null
						? undefined
						: { GIT_INDEX_FILE: args.indexFile as string },
				allowFailure: true,
			});
			return {
				code: result.code,
				stdout: Array.from(result.stdout),
				stderr: result.stderr,
			};
		}
		if (name === 'cancel_git') return null;
		// The shell's own changes; here `node:fs` stands in.
		if (name === 'write_folder_file') {
			await nodeFs.writeFile(
				args.path as string,
				new Uint8Array(args.bytes as number[]),
				{ flag: args.createNew ? 'wx' : 'w' },
			);
			return null;
		}
		if (name === 'rename_folder_path') {
			await nodeFs.rename(args.from as string, args.to as string);
			return null;
		}
		if (name === 'remove_folder_path') {
			await nodeFs.rm(args.path as string, {
				recursive: args.recursive === true,
			});
			afterRemove(args.path as string);
			return null;
		}
		if (name === 'make_folder_directory') {
			await nodeFs.mkdir(args.path as string, { recursive: true });
			return null;
		}
		throw new Error(`unexpected command ${name}`);
	},
	Channel: class {},
	transformCallback: () => 0,
}));

mock.module('@tauri-apps/api/event', () => ({
	listen: async () => () => {},
}));

/** The plugin's errors are strings carrying the operating system's message. */
const asPluginError = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (cause) {
		const code = (cause as { code?: string }).code;
		const os = code === 'ENOENT' ? 2 : code === 'EEXIST' ? 17 : 5;
		throw `failed with error: ${String(cause)} (os error ${os})`;
	}
};

mock.module('@tauri-apps/plugin-fs', () => ({
	readDir: (path: string) =>
		asPluginError(async () =>
			(await nodeFs.readdir(path, { withFileTypes: true })).map((entry) => ({
				name: entry.name,
				isFile: entry.isFile(),
				isDirectory: entry.isDirectory(),
				isSymlink: entry.isSymbolicLink(),
			})),
		),
	lstat: (path: string) =>
		asPluginError(async () => {
			const stats = await nodeFs.lstat(path);
			return {
				isFile: stats.isFile(),
				isDirectory: stats.isDirectory(),
				isSymlink: stats.isSymbolicLink(),
				size: stats.size,
			};
		}),
	readFile: (path: string) =>
		asPluginError(async () => new Uint8Array(await nodeFs.readFile(path))),
	writeFile: (
		path: string,
		data: Uint8Array,
		options?: { createNew?: boolean },
	) =>
		asPluginError(() =>
			nodeFs.writeFile(path, data, { flag: options?.createNew ? 'wx' : 'w' }),
		),
	rename: (from: string, to: string) =>
		asPluginError(() => nodeFs.rename(from, to)),
	remove: (path: string, options?: { recursive?: boolean }) =>
		asPluginError(async () => {
			if (options?.recursive) return nodeFs.rm(path, { recursive: true });
			if ((await nodeFs.lstat(path)).isDirectory()) return nodeFs.rmdir(path);
			return nodeFs.rm(path);
		}),
	mkdir: (path: string) =>
		asPluginError(async () => {
			await nodeFs.mkdir(path, { recursive: true });
		}),
}));

const { openFolder } = await import('./tauri-adapter.js');
const { defineFolder, defineTable, field } = await import('./contract.js');

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

let restoreLocks: () => void;
const originalEnv = { ...process.env };
beforeAll(() => {
	restoreLocks = installWebLocks();
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	restoreLocks();
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});
beforeEach(() => {
	calls = [];
	afterRemove = () => {};
});

/** A granted folder over a new directory. */
async function granted() {
	const root = await scratch('tauri-directory-');
	grantedRoot = root;
	grant = () => ({
		root,
		branch: 'main',
		authorName: 'Todos',
		authorEmail: 'todos@localhost',
	});
	const folder = expectOk(
		await openFolder({ definition, id: 'so.epicenter.todos' }),
	);
	return { root, folder };
}

test('a granted folder opens over its real directory', async () => {
	const root = await scratch('tauri-directory-');
	grantedRoot = root;
	grant = () => ({
		root,
		branch: 'main',
		authorName: 'Todos',
		authorEmail: 'todos@localhost',
	});
	const folder = expectOk(
		await openFolder({ definition, id: 'so.epicenter.todos' }),
	);
	// The grant comes first; every later call is the folder's Git, for the
	// granted scope. Opening writes nothing.
	const commands = () => new Set(calls.map(({ cmd }) => cmd));
	expect(calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: 'so.epicenter.todos' },
	});
	expect([...commands()].sort()).toEqual(['grant_directory', 'run_git']);
	for (const call of calls.slice(1))
		expect(call.args.scope).toBe('so.epicenter.todos');
	expect(folder.location).toEqual({ kind: 'directory', root });

	const created = expectOk(
		await folder.tables.todos.create({
			fields: { title: 'From the desktop', done: false },
			body: '',
		}),
	);
	expect(await readFile(join(root, created.path), 'utf8')).toContain(
		'title: From the desktop',
	);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'fsck', '--strict');
	await folder.close();
});

test('a refused grant is the refusal', async () => {
	grant = () => {
		throw {
			name: 'WindowNotPermitted',
			scope: 'so.epicenter.todos',
			window: 'x',
		};
	};
	const refused = expectErr(
		await openFolder({ definition, id: 'so.epicenter.todos' }),
	);
	expect(refused.name).toBe('WindowNotPermitted');
	expect(calls.map(({ cmd }) => cmd)).toEqual(['grant_directory']);
});

test.each<[unknown, OpenFolderError['name']]>([
	[{ name: 'UnknownScope', scope: 'so.epicenter.todos' }, 'UnknownScope'],
	[{ name: 'Busy', root: '/elsewhere' }, 'Busy'],
	[{ name: 'Unavailable', message: 'locked out' }, 'Unavailable'],
	[{ name: 'ShuttingDown' }, 'ShuttingDown'],
	// Tauri rejects with a string for a missing command or permission.
	['plugin:epicenter-folder|grant_directory not allowed', 'Unavailable'],
	// The reply never arrived.
	[new Error('the IPC channel closed'), 'Unavailable'],
])('a grant refused with %p opens nothing and is %s', async (refusal, name) => {
	grant = () => {
		throw refusal;
	};
	const refused = expectErr(
		await openFolder({ definition, id: 'so.epicenter.todos' }),
	);
	expect(refused.name).toBe(name);
	expect(calls.map(({ cmd }) => cmd)).toEqual(['grant_directory']);
});

test('a removal whose reply is lost is done once the path is gone', async () => {
	const { root, folder } = await granted();
	const file = expectOk(await folder.files.create('notes/a.md', 'a\n'));
	afterRemove = () => {
		throw new Error('the reply was lost');
	};
	expectOk(await folder.files.remove(file));
	expect(
		await nodeFs.lstat(join(root, 'notes/a.md')).catch(() => undefined),
	).toBe(undefined);
	await folder.close();
});

test('a removal whose reply is lost with the path still there is unconfirmed', async () => {
	const { root, folder } = await granted();
	const file = expectOk(await folder.files.create('notes/a.md', 'a\n'));
	afterRemove = (path) => {
		// Another program, or the shell's own late removal, has not run yet.
		writeFileSync(path, 'a\n');
		throw new Error('the reply was lost');
	};
	const refused = expectErr(await folder.files.remove(file));
	expect(refused.name).toBe('Unconfirmed');
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('a\n');
	await folder.close();
});
