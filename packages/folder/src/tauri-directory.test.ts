/**
 * The desktop opener: `grant_directory` hands over the directory, and the
 * folder is read and changed through the shell's commands. They are replaced
 * by stand-ins that reach the disk through `node:fs` and fail as the shell
 * does, with the operating system's message as text.
 *
 * Key behaviors:
 * - A granted folder opens over its real directory and commits with `git`
 * - Every refused or failed grant is an `OpenFolderError` and opens nothing
 * - A removal whose reply is lost is done if the path is gone, and
 *   `Unconfirmed` if it is still there
 * - A save the shell finds overtaken where it publishes is `Conflict`, or
 *   `Exists` for a create, never `Unconfirmed`; an overwrite still lands
 * - `openDataFolder` reads with the folder's own `epicenter.json` and never
 *   writes it, runs no `git` before the first commit creates the repository,
 *   and merges rows on Sync by that declaration
 * - Through a lens, a data folder has the lens's tables, keeps the fields the
 *   lens does not name, and refuses a lens its declaration does not contain
 * - A data folder the shell grants inside another repository's working tree
 *   blocks its first commit with the shell's reason, and runs no `git init`
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { OpenFolderError } from './errors.js';
import { createGitRunner } from './git/native-host.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';
import type { Expectation } from './native/bindings.gen.js';

type Call = { cmd: string; args: Record<string, unknown> };
let grantedRoot: string | undefined;
let calls: Call[] = [];
/** `git` commands other than `init` asked for where there is no repository. */
let gitWithoutRepository: string[][] = [];
let grant: (args: Record<string, unknown>) => unknown = () => {
	throw new Error('no grant scripted');
};
/** Runs after the shell's removal and may lose its reply by throwing. */
let afterRemove: (path: string) => void = () => {};
/**
 * Runs before the shell checks a rename's destination or a removal's path:
 * another writer landing there after the page checked it.
 */
let beforeChange: (path: string) => Promise<void> | void = () => {};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	async invoke(
		cmd: string,
		body: Record<string, unknown> | Uint8Array = {},
		options?: { headers?: Record<string, string> },
	) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		// A raw body carries its arguments in percent-encoded headers.
		const args =
			body instanceof Uint8Array
				? {
						...Object.fromEntries(
							Object.entries(options?.headers ?? {}).map(([key, value]) => [
								key,
								decodeURIComponent(value),
							]),
						),
						bytes: body,
					}
				: body;
		calls.push({ cmd: name, args });
		if (name === 'grant_directory') return grant(args);
		// The shell runs the folder's Git; here the system `git` stands in.
		if (name === 'run_git') {
			const root = grantedRoot;
			if (root === undefined)
				throw { name: 'Unavailable', message: 'not granted' };
			const command = args.args as string[];
			if (command[0] !== 'init' && !existsSync(join(root, '.git/HEAD')))
				gitWithoutRepository.push(command);
			// The shell runs only `git init` where there is no `.git`.
			if (command[0] !== 'init' && !existsSync(join(root, '.git')))
				throw {
					name: 'Unavailable',
					message: `'${root}' has no Git repository yet, so only \`git init\` runs there`,
				};
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
		// The shell's reads; here `node:fs` stands in.
		if (name === 'read_folder_directory')
			return asShellError(async () =>
				(
					await nodeFs.readdir(args.path as string, { withFileTypes: true })
				).map((entry) => ({ name: entry.name, kind: kindOf(entry) })),
			);
		if (name === 'stat_folder_path')
			return asShellError(async () => {
				const stats = await nodeFs
					.lstat(args.path as string)
					.catch((cause: { code?: string }) => {
						if (cause.code === 'ENOENT') return undefined;
						throw cause;
					});
				if (stats === undefined) return null;
				return { kind: kindOf(stats), size: stats.size, mode: null };
			});
		if (name === 'read_folder_file')
			return asShellError(async () => {
				// The raw response arrives as an `ArrayBuffer`.
				const bytes = await nodeFs.readFile(args.path as string);
				return bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				);
			});
		// The shell's own changes; here `node:fs` stands in.
		if (name === 'write_folder_file') {
			if (!(args.bytes instanceof Uint8Array))
				throw 'write_folder_file takes its bytes as a raw body, not JSON';
			await nodeFs.writeFile(args.path as string, args.bytes, {
				flag: args['create-new'] === 'true' ? 'wx' : 'w',
			});
			return null;
		}
		if (name === 'rename_folder_path') {
			await beforeChange(args.to as string);
			await check(args.to as string, args.expected as Expectation);
			await asRefusal(() =>
				nodeFs.rename(args.from as string, args.to as string),
			);
			return null;
		}
		if (name === 'remove_folder_path') {
			await beforeChange(args.path as string);
			await check(args.path as string, args.expected as Expectation);
			await asRefusal(() =>
				nodeFs.rm(args.path as string, { recursive: args.recursive === true }),
			);
			afterRemove(args.path as string);
			return null;
		}
		if (name === 'make_folder_directory') {
			await nodeFs.mkdir(args.path as string, { recursive: true });
			return null;
		}
		throw new Error(`unexpected command ${name}`);
	},
}));

/** The handlers pages registered for the folder plugin's change event. */
const changeHandlers = new Set<(event: { payload: unknown }) => void>();
let listenedTo: string[] = [];

/** The shell's watcher announcing a change, as the folder plugin emits it. */
function emitChanged(payload: { scope: string; paths: string[] | null }) {
	for (const handler of [...changeHandlers]) handler({ payload });
}

// The shell sends the event to each permitted window, and the page listens
// on its own.
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({
		async listen(
			event: string,
			handler: (event: { payload: unknown }) => void,
		) {
			listenedTo.push(event);
			changeHandlers.add(handler);
			return () => {
				changeHandlers.delete(handler);
			};
		},
	}),
}));

/** The shell's errors are strings carrying the operating system's message. */
const asShellError = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (cause) {
		throw String(cause);
	}
};

/** A rename's or removal's failure as the shell refuses it. */
const asRefusal = async <T>(work: () => Promise<T>): Promise<T> => {
	try {
		return await work();
	} catch (cause) {
		throw { name: 'Failed', message: String(cause) };
	}
};

/** The shell's check of what a rename or removal expects at `path`. */
async function check(path: string, expected: Expectation) {
	if (expected === 'any') return;
	const found = await nodeFs.lstat(path).catch(() => undefined);
	if (expected === 'absent') {
		if (found !== undefined) throw { name: 'Exists' };
		return;
	}
	if (expected === 'present') {
		if (found === undefined) throw { name: 'NotFound' };
		return;
	}
	if (!found?.isFile()) throw { name: 'Conflict', actualSha256: null };
	const actualSha256 = createHash('sha256')
		.update(await nodeFs.readFile(path))
		.digest('hex');
	if (actualSha256 !== expected.sha256)
		throw { name: 'Conflict', actualSha256 };
}

/** What an entry is, without following a link, as the shell names it. */
const kindOf = (entry: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}) =>
	entry.isSymbolicLink()
		? 'link'
		: entry.isFile()
			? 'file'
			: entry.isDirectory()
				? 'directory'
				: 'other';

const { openDataFolder, openFolder } = await import('./tauri-adapter.js');
const { defineFolder, defineTable, field } = await import('./contract.js');

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const originalEnv = { ...process.env };
beforeAll(() => {
	Object.assign(process.env, {
		GIT_CONFIG_GLOBAL: GIT_ENV.GIT_CONFIG_GLOBAL,
		GIT_CONFIG_NOSYSTEM: '1',
	});
});
afterAll(() => {
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'])
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
});
beforeEach(() => {
	calls = [];
	listenedTo = [];
	gitWithoutRepository = [];
	afterRemove = () => {};
	beforeChange = () => {};
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
	// The grant comes first; every later call is a read, for the granted
	// scope. Opening writes nothing and runs no `git`.
	const commands = () => new Set(calls.map(({ cmd }) => cmd));
	expect(calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: 'so.epicenter.todos' },
	});
	expect(
		[...commands()]
			.filter(
				(cmd) =>
					![
						'read_folder_directory',
						'stat_folder_path',
						'read_folder_file',
					].includes(cmd),
			)
			.sort(),
	).toEqual(['grant_directory']);
	for (const call of calls.slice(1))
		expect(call.args.scope).toBe('so.epicenter.todos');
	// The shell's watcher is how this page hears outside changes.
	expect(listenedTo).toEqual(['epicenter-folder://changed']);
	expect(folder.location).toEqual({ kind: 'directory', root });
	expect(folder.definition).toBe(definition);

	const created = expectOk(
		await folder.tables.todos.create({
			fields: { title: 'From the desktop', done: false },
			body: '',
		}),
	);
	expect(await readFile(join(root, created.path), 'utf8')).toContain(
		'title: From the desktop',
	);
	// Saving created no repository; the first commit does.
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'fsck', '--strict');
	await folder.close();
});

test("the shell's change event reaches this folder's listeners: its own scope only, null as everything", async () => {
	const { folder } = await granted();
	const heard: unknown[] = [];
	folder.onFilesChanged((change) => heard.push(change));
	emitChanged({ scope: 'so.epicenter.todos', paths: ['todos/a.md'] });
	emitChanged({ scope: 'so.epicenter.notes', paths: ['notes/b.md'] });
	emitChanged({ scope: 'so.epicenter.todos', paths: null });
	expect(heard).toEqual([['todos/a.md'], 'everything']);
	// A page's own save is not reported to it.
	expectOk(
		await folder.tables.todos.create({
			fields: { title: 'Mine', done: false },
			body: '',
		}),
	);
	expect(heard).toHaveLength(2);
	// Closing stops listening to the shell.
	await folder.close();
	expect(changeHandlers.size).toBe(0);
	emitChanged({ scope: 'so.epicenter.todos', paths: ['todos/a.md'] });
	expect(heard).toHaveLength(2);
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
	[{ name: 'Missing', root: '/elsewhere' }, 'Missing'],
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

test('a save another window overtakes where it publishes merges with what is there; other writes are refused', async () => {
	const { root, folder } = await granted();
	const sha256 = (text: string) =>
		createHash('sha256').update(text).digest('hex');
	// Another window's save lands after this page checked the path and
	// before the shell publishes this one.
	const overtaken = new Map<string, string>();
	beforeChange = (path) => {
		const theirs = overtaken.get(path);
		if (theirs === undefined) return;
		overtaken.delete(path);
		writeFileSync(path, theirs);
	};
	const created = expectOk(
		await folder.tables.todos.create({
			fields: { title: 'Mine', done: false },
			body: '',
		}),
	);
	const path = join(root, created.path);
	const theirs = '---\ntitle: Theirs\ndone: false\n---\n';
	overtaken.set(path, theirs);
	created.row.fields.title = 'Mine, edited';
	const saved = expectOk(await folder.tables.todos.save(created, created.row));
	expect(saved).toMatchObject({
		merged: true,
		replaced: [
			{ kind: 'field', field: 'title', kept: 'Mine, edited', theirs: 'Theirs' },
		],
	});
	expect(await readFile(path, 'utf8')).toContain('title: Mine, edited');
	// Each refused stream removed what it staged.
	const scratchDirectory = join(root, '.git/epicenter/scratch');
	expect(await nodeFs.readdir(scratchDirectory)).toEqual([]);

	const note = join(root, 'notes/a.md');
	overtaken.set(note, 'theirs\n');
	const made = await folder.files.create('notes/a.md', 'mine\n');
	expect(made.error?.name).toBe('Exists');
	expect(await readFile(note, 'utf8')).toBe('theirs\n');

	const captured = expectOk(await folder.files.read('notes/a.md'));
	overtaken.set(note, 'theirs again\n');
	const removed = await folder.files.remove(captured);
	expect(removed.error).toMatchObject({
		name: 'Conflict',
		actualSha256: sha256('theirs again\n'),
	});

	overtaken.set(note, 'theirs once more\n');
	expectOk(await folder.files.overwrite('notes/a.md', 'mine\n'));
	expect(await readFile(note, 'utf8')).toBe('mine\n');
	expect(await nodeFs.readdir(scratchDirectory)).toEqual([]);
	// The page told the shell what each publish expected: the declaration,
	// published before the first save, takes whatever is there.
	expect(
		calls
			.filter(({ cmd }) => cmd === 'rename_folder_path')
			.map(({ args }) => args.expected),
	).toEqual([
		'any',
		'absent',
		{ sha256: created.sha256 },
		{ sha256: sha256(theirs) },
		'absent',
		'any',
	]);
	await folder.close();
});

/** Hand-formatted, as no publication would write it. */
const DECLARED = `{"kv":{"type":"object","properties":{}},"tables":{"todos":{"type":"object","properties":{"title":{"type":"string"},"done":{"type":"boolean"}},"required":["title","done"]}}}`;

/** The shell grants `root` as `so.epicenter.vault`. */
function grantRoot(root: string) {
	grantedRoot = root;
	grant = () => ({
		root,
		branch: 'main',
		authorName: 'Vault',
		authorEmail: 'vault@localhost',
	});
}

/** Every path the page asked the shell to write, rename onto, or remove. */
const changedPaths = () =>
	calls.flatMap(({ cmd, args }) =>
		cmd === 'write_folder_file' || cmd === 'remove_folder_path'
			? [args.path as string]
			: cmd === 'rename_folder_path'
				? [args.to as string]
				: [],
	);

test('a data folder reads with its own epicenter.json, never writes it, and its first commit creates the repository', async () => {
	const root = await scratch('tauri-data-folder-');
	await nodeFs.writeFile(join(root, 'epicenter.json'), DECLARED);
	await nodeFs.mkdir(join(root, 'todos'));
	await nodeFs.writeFile(
		join(root, 'todos/one.md'),
		'---\ntitle: One\ndone: false\n---\n',
	);
	grantRoot(root);
	const folder = expectOk(await openDataFolder({ id: 'so.epicenter.vault' }));
	expect(calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: 'so.epicenter.vault' },
	});
	// Opening read the declaration and ran no `git`.
	expect(calls.some(({ cmd }) => cmd === 'run_git')).toBe(false);
	expect(changedPaths()).toEqual([]);
	expect(existsSync(join(root, '.git'))).toBe(false);
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	const heard: string[] = [];
	folder.onFilesChanged((paths) => heard.push(...paths));

	const todos = folder.tables.todos!;
	const one = expectOk(await todos.get('one'));
	expectOk(
		await todos.save(one!, {
			fields: { title: 'One', done: true },
			body: '',
		}),
	).stored;
	expectOk(
		await todos.create({ fields: { title: 'Two', done: false }, body: '' }),
	);
	expect(expectOk(await folder.git.status()).head).toBeUndefined();
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'fsck', '--strict');

	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	expect(
		changedPaths().filter((path) => path.endsWith('epicenter.json')),
	).toEqual([]);
	expect(heard).not.toContain('epicenter.json');
	expect(gitWithoutRepository).toEqual([]);
	await folder.close();
});

test('a data folder without epicenter.json opens with no tables, and files work', async () => {
	const root = await scratch('tauri-data-folder-none-');
	grantRoot(root);
	const folder = expectOk(await openDataFolder({ id: 'so.epicenter.vault' }));
	expect(folder.definition).toEqual({ kv: {}, tables: {} });
	expect(folder.tables).toEqual({});
	expectOk(await folder.files.create('notes/a.md', 'a\n'));
	expect(
		new TextDecoder().decode(
			expectOk(await folder.files.read('notes/a.md')).bytes,
		),
	).toBe('a\n');
	expect(existsSync(join(root, 'epicenter.json'))).toBe(false);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	expect(gitWithoutRepository).toEqual([]);
	await folder.close();
});

test('a data folder whose epicenter.json cannot be used is InvalidDeclaration and opens nothing', async () => {
	const root = await scratch('tauri-data-folder-invalid-');
	await nodeFs.writeFile(
		join(root, 'epicenter.json'),
		'{"kv":{"type":"object","properties":{}},"tables":{"todos":{"type":"object","properties":{},"required":["title"]}}}',
	);
	grantRoot(root);
	const refused = expectErr(await openDataFolder({ id: 'so.epicenter.vault' }));
	expect(refused.name).toBe('InvalidDeclaration');
	expect(refused.message).toContain("requires 'title'");
	expect(calls.some(({ cmd }) => cmd === 'run_git')).toBe(false);
	expect(changedPaths()).toEqual([]);
});

test("a data folder inside another repository blocks its first commit with the shell's reason", async () => {
	const root = await scratch('tauri-data-folder-nested-');
	await nodeFs.writeFile(join(root, 'epicenter.json'), DECLARED);
	const initProblem = `${root} is inside the repository at /outer; commit it with that repository's Git`;
	grantedRoot = root;
	grant = () => ({
		root,
		branch: 'main',
		authorName: 'Vault',
		authorEmail: 'vault@localhost',
		initProblem,
	});
	const folder = expectOk(await openDataFolder({ id: 'so.epicenter.vault' }));
	expectOk(
		await folder.tables.todos!.create({
			fields: { title: 'One', done: false },
			body: '',
		}),
	);
	expect(await folder.git.commit()).toEqual({
		status: 'blocked',
		reason: initProblem,
	});
	expect(calls.some(({ cmd }) => cmd === 'run_git')).toBe(false);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	await folder.close();
});

test('a data folder grant refused is the refusal', async () => {
	grant = () => {
		throw { name: 'UnknownScope', scope: 'so.epicenter.vault' };
	};
	const refused = expectErr(await openDataFolder({ id: 'so.epicenter.vault' }));
	expect(refused.name).toBe('UnknownScope');
	expect(calls.map(({ cmd }) => cmd)).toEqual(['grant_directory']);
});

test('a data folder opened through a lens reads its fields, keeps the rest, and never writes epicenter.json', async () => {
	const root = await scratch('tauri-data-folder-lens-');
	await nodeFs.writeFile(join(root, 'epicenter.json'), DECLARED);
	await nodeFs.mkdir(join(root, 'todos'));
	await nodeFs.writeFile(
		join(root, 'todos/one.md'),
		'---\ntitle: One\ndone: false\nsource: phone\n---\n',
	);
	grantRoot(root);
	const lens = defineFolder({
		kv: {},
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const folder = expectOk(
		await openDataFolder({ id: 'so.epicenter.vault', lens }),
	);
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	const todos = folder.tables.todos;
	// The folder requires `done`, which the lens does not declare.
	expect(todos.canCreate).toBe(false);
	expect(
		expectErr(await todos.create({ fields: { title: 'Two' }, body: '' })).name,
	).toBe('CannotCreate');
	const one = expectOk(await todos.get('one'))!;
	one.row.fields.title = 'One, renamed';
	expectOk(await todos.save(one, one.row)).stored;
	expect(await readFile(join(root, 'todos/one.md'), 'utf8')).toBe(
		'---\ntitle: One, renamed\ndone: false\nsource: phone\n---\n',
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	expect(
		changedPaths().filter((path) => path.endsWith('epicenter.json')),
	).toEqual([]);
	await folder.close();

	const mismatch = defineFolder({
		kv: {},
		tables: { todos: defineTable({ fields: { done: field.string() } }) },
	});
	const refused = expectErr(
		await openDataFolder({ id: 'so.epicenter.vault', lens: mismatch }),
	);
	expect(refused).toMatchObject({
		name: 'ShapeMismatch',
		problems: [{ kind: 'incompatibleField', table: 'todos', field: 'done' }],
	});
});

test("a data folder's Sync merges rows by its own declaration", async () => {
	const project = await scratch('tauri-data-folder-sync-');
	const bare = await createBareRemote(project);
	const native = join(project, 'native');
	await git(project, 'clone', '--quiet', bare, native);
	await nodeFs.writeFile(join(native, 'epicenter.json'), DECLARED);
	await nodeFs.mkdir(join(native, 'todos'));
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: One\ndone: false\n---\n',
	);
	await git(native, 'add', '--all');
	await git(native, 'commit', '--quiet', '-m', 'Start');
	await git(native, 'push', '--quiet', 'origin', 'HEAD:main');
	const root = join(project, 'desktop');
	await git(project, 'clone', '--quiet', bare, root);
	grantRoot(root);
	const folder = expectOk(await openDataFolder({ id: 'so.epicenter.vault' }));

	// Adjacent lines, which a line merge would hold for a person; two
	// fields, which the declaration's row merge combines.
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: One, renamed\ndone: false\n---\n',
	);
	await git(native, 'commit', '--quiet', '-am', 'Rename');
	await git(native, 'push', '--quiet', 'origin', 'main');
	const todos = folder.tables.todos!;
	const one = expectOk(await todos.get('one'));
	expectOk(
		await todos.save(one!, {
			fields: { title: 'One', done: true },
			body: '',
		}),
	).stored;
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expect(await readFile(join(root, 'todos/one.md'), 'utf8')).toBe(
		'---\ntitle: One, renamed\ndone: true\n---\n',
	);
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	await folder.close();
});

test('a save another window lands while Sync writes the same row survives, and the next Sync asks for a choice', async () => {
	const project = await scratch('tauri-incoming-race-');
	const bare = await createBareRemote(project);
	const native = join(project, 'native');
	await git(project, 'clone', '--quiet', bare, native);
	await nodeFs.mkdir(join(native, 'todos'));
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: Shared\ndone: false\n---\n',
	);
	await git(native, 'add', '--all');
	await git(native, 'commit', '--quiet', '-m', 'Start');
	await git(native, 'push', '--quiet', 'origin', 'HEAD:main');
	const root = join(project, 'desktop');
	await git(project, 'clone', '--quiet', bare, root);
	grantRoot(root);
	const folder = expectOk(
		await openFolder({ definition, id: 'so.epicenter.todos' }),
	);
	expectOk(await folder.sync.run());
	await git(native, 'pull', '--quiet', 'origin', 'main');
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: Remote\ndone: false\n---\n',
	);
	await git(native, 'commit', '--quiet', '-am', 'Rename remotely');
	await git(native, 'push', '--quiet', 'origin', 'main');

	// Another window saves the row after this page checked it and before the
	// shell publishes Sync's write there.
	const path = join(root, 'todos/one.md');
	const theirs = '---\ntitle: Other window\ndone: false\n---\n';
	beforeChange = (target) => {
		if (target !== path) return;
		beforeChange = () => {};
		writeFileSync(path, theirs);
	};
	const stopped = await folder.sync.run();
	expect(stopped.error).toMatchObject({
		name: 'Merge',
		error: {
			name: 'Refused',
			error: { name: 'Conflict', path: 'todos/one.md' },
		},
	});
	expect(await readFile(path, 'utf8')).toBe(theirs);

	const next = await folder.sync.run();
	expect(next.error?.name).toBe('NeedsChoices');
	expect(
		next.error?.name === 'NeedsChoices' ? next.error.attempt.conflicts : [],
	).toMatchObject([{ kind: 'field', field: 'title', path: 'todos/one.md' }]);
	expect(await readFile(path, 'utf8')).toBe(theirs);
	await folder.close();
});
