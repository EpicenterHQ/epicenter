/**
 * The desktop opener: `grant_directory` hands over the directory, and the
 * folder is read and changed through the shell's commands. They are replaced
 * by the stand-ins in `granted-shell.test-support.ts`, which reach the disk
 * through `node:fs` and fail as the shell does.
 *
 * Key behaviors:
 * - A granted folder opens over its real directory, and its history runs
 *   through the shell's history commands: the `epicenter` CLI over `git`,
 *   which `answerShellHistory` runs in this process with the CLI's author
 * - Every refused or failed grant is an `OpenFolderError` and opens nothing
 * - Each storage method is one call to the shell: a read is one
 *   `read_folder_file`, and a put of bytes or a removal one `put_folder_file`
 * - A delete whose reply is lost is done if the path is gone, and `Io`
 *   with an `Unconfirmed` cause if it is still there
 * - A write the shell finds overtaken where it publishes reads again and
 *   merges, a create onto the file that landed is `InvalidPath`, and a
 *   delete reads again and wins; none is `Unconfirmed`
 * - A folder opened by ID reads with its own table schemas and never
 *   writes them, asks for no history when it opens, creates no repository
 *   before the first commit, and merges rows on Sync by that declaration
 * - What a page's Sync wrote reaches its listeners once, from the reply
 * - Read through a definition, a data folder has the definition's tables,
 *   keeps the fields the definition does not name, and refuses a definition
 *   its declaration does not contain
 * - A data folder inside another repository's working tree blocks its first
 *   commit, and no repository is made
 */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { OpenFolderError } from './errors.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';
import {
	createGrantedShell,
	type GrantedShell,
} from './granted-shell.test-support.js';
import { mustRow } from './row-write.test-support.js';

/** The shell's history commands, which run the `epicenter` CLI. */
const HISTORY_COMMANDS = new Set(['status', 'history', 'save_version', 'sync']);
/** The shell; a test that opens a folder grants it a directory (`grantRoot`). */
let shell: GrantedShell;

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (
		cmd: string,
		body?: Record<string, unknown> | Uint8Array,
		options?: { headers?: Record<string, string> },
	) => shell.invoke(cmd, body, options),
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

const { openFolder } = await import('./tauri-adapter.js');
const { defineFolder, defineTable, field } = await import('./contract.js');

const definition = defineFolder({
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
/** The window runs Todos on its own folder. */
const TODOS_WINDOW = {
	app: 'so.epicenter.todos',
	folder: 'so.epicenter.todos',
};

beforeEach(() => {
	// A shell that has granted nothing yet; a refused grant is scripted on it.
	shell = createGrantedShell('', TODOS_WINDOW);
	listenedTo = [];
});

/** The shell grants `root`. */
function grantRoot(root: string) {
	shell = createGrantedShell(root, TODOS_WINDOW);
}

/** A granted folder over a new directory. */
async function granted() {
	const root = await scratch('tauri-directory-');
	grantRoot(root);
	const folder = expectOk(
		await openFolder({ definition, app: 'so.epicenter.todos' }),
	);
	return { root, folder };
}

test('a granted folder opens over its real directory', async () => {
	const root = await scratch('tauri-directory-');
	grantRoot(root);
	const folder = expectOk(
		await openFolder({ definition, app: 'so.epicenter.todos' }),
	);
	// The page asks which folder its window was handed, then for its grant;
	// every later call is a read, for the granted scope. Opening writes
	// nothing and runs no `git`.
	const commands = () => new Set(shell.calls.map(({ cmd }) => cmd));
	expect(shell.calls.slice(0, 2)).toEqual([
		{ cmd: 'window_folder', args: {} },
		{ cmd: 'grant_directory', args: { scope: 'so.epicenter.todos' } },
	]);
	expect(
		[...commands()]
			.filter(
				(cmd) =>
					!['list_folder', 'read_folder_children', 'read_folder_file'].includes(
						cmd,
					),
			)
			.sort(),
	).toEqual(['grant_directory', 'window_folder']);
	for (const call of shell.calls.slice(2))
		expect(call.args.scope).toBe('so.epicenter.todos');
	// The shell's watcher is how this page hears outside changes.
	expect(listenedTo).toEqual(['epicenter-folder://changed']);
	expect(folder.location).toEqual({ kind: 'directory', root });
	expect(folder.definition).toBe(definition);

	const created = mustRow(
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

test('each storage method is one call to the shell', async () => {
	const root = await scratch('tauri-directory-calls-');
	grantRoot(root);
	const { tauriHostFiles } = await import('./tauri-files.js');
	const { hostStorage } = await import('./boundary.js');
	const storage = hostStorage(tauriHostFiles('so.epicenter.todos'));
	const sha256 = (text: string) =>
		createHash('sha256').update(text).digest('hex');
	/** The commands `work` sent, in order. */
	async function sent(work: () => Promise<unknown>) {
		shell.calls.length = 0;
		await work();
		return shell.calls.map(({ cmd }) => cmd);
	}

	expect(
		await sent(async () =>
			expect(
				expectOk(await storage.put('notes/deep/a.md', bytes('a\n'), null)),
			).toBe('landed'),
		),
	).toEqual(['put_folder_file']);
	expect(
		await sent(async () => {
			const read = expectOk(await storage.read('notes/deep/a.md'));
			expect(new TextDecoder().decode(read.bytes)).toBe('a\n');
			expect(read.sha256).toBe(sha256('a\n'));
		}),
	).toEqual(['read_folder_file']);
	expect(
		await sent(async () =>
			expect(
				expectOk(await storage.put('notes/deep/a.md', bytes('b\n'), null)),
			).toBe('stale'),
		),
	).toEqual(['put_folder_file']);
	expect(
		await sent(async () =>
			expect(
				expectOk(
					await storage.put('notes/deep/a.md', bytes('b\n'), sha256('a\n')),
				),
			).toBe('landed'),
		),
	).toEqual(['put_folder_file']);
	expect(
		await sent(async () =>
			expect(
				expectOk(await storage.put('notes/deep/a.md', null, sha256('b\n'))),
			).toBe('landed'),
		),
	).toEqual(['put_folder_file']);
	expect(await sent(async () => expectOk(await storage.list()))).toEqual([
		'list_folder',
	]);
	expect(
		await sent(async () =>
			expect(expectOk(await storage.children('notes'))).toEqual({
				files: [],
				directories: ['deep'],
			}),
		),
	).toEqual(['read_folder_children']);
	expect(
		await sent(async () => expectOk(await storage.mkdir('notes/other'))),
	).toEqual(['make_folder_directory']);
	expect(
		await sent(async () => expectOk(await storage.rmdir('notes/other'))),
	).toEqual(['remove_folder_directory']);
	// The shell's refusals are the page's errors, named as the shell names
	// them.
	expect(expectErr(await storage.read('notes/deep'))).toMatchObject({
		name: 'NotAFile',
		path: 'notes/deep',
	});
	expect(expectErr(await storage.rmdir('notes'))).toMatchObject({
		name: 'DirectoryNotEmpty',
		path: 'notes',
	});
	expect(
		expectErr(await storage.put('notes/deep', bytes('x'), null)),
	).toMatchObject({ name: 'NotAFile', path: 'notes/deep' });
	expect(expectErr(await storage.children('missing'))).toMatchObject({
		name: 'NotFound',
		path: 'missing',
	});
});

/** The UTF-8 bytes of `text`. */
const bytes = (text: string) => new TextEncoder().encode(text);

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
	shell.control.grant = () => {
		throw {
			name: 'WindowNotPermitted',
			scope: 'so.epicenter.todos',
			window: 'x',
		};
	};
	const refused = expectErr(
		await openFolder({ definition, app: 'so.epicenter.todos' }),
	);
	expect(refused.name).toBe('WindowNotPermitted');
	expect(shell.calls.map(({ cmd }) => cmd)).toEqual([
		'window_folder',
		'grant_directory',
	]);
});

test.each<[unknown, OpenFolderError['name']]>([
	[{ name: 'UnknownScope', scope: 'so.epicenter.todos' }, 'UnknownScope'],
	[{ name: 'Missing', root: '/elsewhere' }, 'Missing'],
	[{ name: 'Unavailable', message: 'locked out' }, 'Unavailable'],
	[{ name: 'ShuttingDown' }, 'ShuttingDown'],
	// Tauri rejects with a string for a missing command or permission.
	['plugin:epicenter-folder|grant_directory not allowed', 'Unavailable'],
	// The reply never arrived.
	[new Error('the IPC channel closed'), 'Unavailable'],
])('a grant refused with %p opens nothing and is %s', async (refusal, name) => {
	shell.control.grant = () => {
		throw refusal;
	};
	const refused = expectErr(
		await openFolder({ definition, app: 'so.epicenter.todos' }),
	);
	expect(refused.name).toBe(name);
	expect(shell.calls.map(({ cmd }) => cmd)).toEqual([
		'window_folder',
		'grant_directory',
	]);
});

test('a directory removal whose reply is lost is Unconfirmed, and no data change', async () => {
	const { root, folder } = await granted();
	await nodeFs.mkdir(join(root, 'empty'));
	shell.control.refuseNext = 1;
	shell.control.loseReplies = 1;
	shell.control.loseDirectoryReplies = 1;
	expect(expectErr(await folder.files.rmdir('empty'))).toMatchObject({
		name: 'Unconfirmed',
		path: 'empty',
	});
	expect(existsSync(join(root, 'empty'))).toBe(false);
	// The data change controls were not spent on it.
	expect(shell.changes).toEqual([]);
	expect(shell.control.refuseNext).toBe(1);
	expect(shell.control.loseReplies).toBe(1);
	await folder.close();
});

test('a removal whose reply is lost is done once the path is gone', async () => {
	const { root, folder } = await granted();
	expectOk(await folder.write('notes/a.md', null, 'a\n'));
	shell.control.afterChange = () => {
		throw new Error('the reply was lost');
	};
	expectOk(await folder.write('notes/a.md', null, null));
	expect(
		await nodeFs.lstat(join(root, 'notes/a.md')).catch(() => undefined),
	).toBe(undefined);
	await folder.close();
});

test('a removal whose reply is lost with the path still there is unconfirmed', async () => {
	const { root, folder } = await granted();
	expectOk(await folder.write('notes/a.md', null, 'a\n'));
	shell.control.afterChange = (change) => {
		// Another program, or the shell's own late removal, has not run yet.
		writeFileSync(join(root, change.path), 'a\n');
		throw new Error('the reply was lost');
	};
	const refused = expectErr(await folder.write('notes/a.md', null, null));
	expect(refused).toMatchObject({ name: 'Io', cause: { name: 'Unconfirmed' } });
	expect(await readFile(join(root, 'notes/a.md'), 'utf8')).toBe('a\n');
	await folder.close();
});

test('a row write another window overtakes where it publishes merges with what is there; a create is refused, and a delete reads again and wins', async () => {
	const { root, folder } = await granted();
	const sha256 = (text: string) =>
		createHash('sha256').update(text).digest('hex');
	// Another window's save lands after this page checked the path and
	// before the shell publishes this one.
	const overtaken = new Map<string, string>();
	shell.control.beforeChange = (change) => {
		const path = join(root, change.path);
		const theirs = overtaken.get(path);
		if (theirs === undefined) return;
		overtaken.delete(path);
		writeFileSync(path, theirs);
	};
	const created = mustRow(
		await folder.tables.todos.create({
			fields: { title: 'Mine', done: false },
			body: '',
		}),
	);
	const path = join(root, created.path);
	const theirs = '---\ntitle: Theirs\ndone: false\n---\n';
	overtaken.set(path, theirs);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	expectOk(
		await folder.tables.todos.write(stem, created.row, {
			...created.row,
			fields: { ...created.row.fields, title: 'Mine, edited' },
		}),
	);
	expect(await readFile(path, 'utf8')).toContain('title: Mine, edited');
	// Each refused stream removed what it staged.
	const scratchDirectory = join(root, '.git/epicenter/scratch');
	expect(await nodeFs.readdir(scratchDirectory)).toEqual([]);

	const note = join(root, 'notes/a.md');
	overtaken.set(note, 'theirs\n');
	const made = await folder.write('notes/a.md', null, 'mine\n');
	expect(made.error?.name).toBe('Occupied');
	expect(await readFile(note, 'utf8')).toBe('theirs\n');

	overtaken.set(note, 'theirs again\n');
	expectOk(await folder.write('notes/a.md', 'theirs\n', null));
	expect(await nodeFs.lstat(note).catch(() => undefined)).toBe(undefined);

	expectOk(await folder.write('notes/a.md', null, 'base\n'));
	overtaken.set(note, 'theirs once more\n');
	const mine = expectOk(await folder.write('notes/a.md', 'base\n', 'mine\n'));
	expect(mine.overridden).not.toEqual([]);
	expect(await readFile(note, 'utf8')).toBe('mine\n');
	expect(await nodeFs.readdir(scratchDirectory)).toEqual([]);
	// The page told the shell what each publish expected: the declaration,
	// published before the first save, is created where none is.
	expect(
		shell.calls
			.filter(
				({ cmd, args }) => cmd === 'put_folder_file' && args.remove === 'false',
			)
			.map(({ args }) => args['if-match'] ?? null),
	).toEqual([
		null,
		null,
		created.sha256,
		sha256(theirs),
		null,
		null,
		sha256('base\n'),
		sha256('theirs once more\n'),
	]);
	await folder.close();
});

/** Hand-formatted, as no publication would write it. */
const DECLARED = `{"type":"object","properties":{"title":{"type":"string"},"done":{"type":"boolean"}},"required":["title","done"]}`;
/** Where `DECLARED` makes `todos` a table. */
const SCHEMA = 'todos/.epicenter.json';

/** Every path the page asked the shell to change. */
const changedPaths = () =>
	shell.calls.flatMap(({ cmd, args }) =>
		[
			'put_folder_file',
			'make_folder_directory',
			'remove_folder_directory',
		].includes(cmd)
			? [args.path as string]
			: [],
	);

test('a data folder reads with its own table schemas, never writes them, and its first commit creates the repository', async () => {
	const root = await scratch('tauri-data-folder-');
	await nodeFs.mkdir(join(root, 'todos'));
	await nodeFs.writeFile(join(root, SCHEMA), DECLARED);
	await nodeFs.writeFile(
		join(root, 'todos/one.md'),
		'---\ntitle: One\ndone: false\n---\n',
	);
	grantRoot(root);
	const folder = expectOk(await openFolder({ id: 'so.epicenter.vault' }));
	expect(shell.calls[0]).toEqual({
		cmd: 'grant_directory',
		args: { scope: 'so.epicenter.vault' },
	});
	// Opening read the declaration and asked for no history.
	expect(shell.calls.some(({ cmd }) => HISTORY_COMMANDS.has(cmd))).toBe(false);
	expect(changedPaths()).toEqual([]);
	expect(existsSync(join(root, '.git'))).toBe(false);
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	const heard: string[] = [];
	folder.onFilesChanged((paths) => heard.push(...paths));

	const todos = folder.tables.todos!;
	const one = expectOk(await todos.get('one'));
	expectOk(
		await todos.write('one', one!.row, {
			fields: { title: 'One', done: true },
			body: '',
		}),
	);
	expectOk(
		await todos.create({ fields: { title: 'Two', done: false }, body: '' }),
	);
	expect(expectOk(await folder.git.status()).head).toBeUndefined();
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	await git(root, 'fsck', '--strict');

	expect(await readFile(join(root, SCHEMA), 'utf8')).toBe(DECLARED);
	expect(
		changedPaths().filter((path) => path.endsWith('.epicenter.json')),
	).toEqual([]);
	expect(heard).not.toContain(SCHEMA);
	await folder.close();
});

test('a data folder with no table schema opens with no tables, and files work', async () => {
	const root = await scratch('tauri-data-folder-none-');
	grantRoot(root);
	const folder = expectOk(await openFolder({ id: 'so.epicenter.vault' }));
	expect(folder.definition).toEqual({ tables: {} });
	expect(folder.tables).toEqual({});
	expectOk(await folder.write('notes/a.md', null, 'a\n'));
	expect(
		new TextDecoder().decode(
			expectOk(await folder.files.read('notes/a.md')).bytes,
		),
	).toBe('a\n');
	expect(existsSync(join(root, 'notes/.epicenter.json'))).toBe(false);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	await folder.close();
});

test('a data folder whose table schema cannot be used is InvalidDefinition and opens nothing', async () => {
	const root = await scratch('tauri-data-folder-invalid-');
	await nodeFs.mkdir(join(root, 'todos'));
	await nodeFs.writeFile(
		join(root, SCHEMA),
		'{"type":"object","properties":{},"required":["title"]}',
	);
	grantRoot(root);
	const refused = expectErr(await openFolder({ id: 'so.epicenter.vault' }));
	expect(refused).toMatchObject({ name: 'InvalidDefinition', path: SCHEMA });
	expect(refused.message).toContain("requires 'title'");
	expect(shell.calls.some(({ cmd }) => HISTORY_COMMANDS.has(cmd))).toBe(false);
	expect(changedPaths()).toEqual([]);
});

test('a data folder inside another repository blocks its first commit', async () => {
	const outer = await scratch('tauri-data-folder-outer-');
	await git(outer, 'init', '--quiet');
	const root = join(outer, 'vault');
	await nodeFs.mkdir(join(root, 'todos'), { recursive: true });
	await nodeFs.writeFile(join(root, SCHEMA), DECLARED);
	// The CLI names the folder and the repository by their real paths.
	const initProblem = `${await nodeFs.realpath(root)} is inside the repository at ${await nodeFs.realpath(outer)}; commit it with that repository's Git`;
	grantRoot(root);
	const folder = expectOk(await openFolder({ id: 'so.epicenter.vault' }));
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
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	await folder.close();
});

test('a data folder grant refused is the refusal', async () => {
	shell.control.grant = () => {
		throw { name: 'UnknownScope', scope: 'so.epicenter.vault' };
	};
	const refused = expectErr(await openFolder({ id: 'so.epicenter.vault' }));
	expect(refused.name).toBe('UnknownScope');
	expect(shell.calls.map(({ cmd }) => cmd)).toEqual(['grant_directory']);
});

test('a data folder read through a definition reads its fields, keeps the rest, and never writes a schema', async () => {
	const root = await scratch('tauri-data-folder-read-through-');
	await nodeFs.mkdir(join(root, 'todos'));
	await nodeFs.writeFile(join(root, SCHEMA), DECLARED);
	await nodeFs.writeFile(
		join(root, 'todos/one.md'),
		'---\ntitle: One\ndone: false\nsource: phone\n---\n',
	);
	grantRoot(root);
	const reader = defineFolder({
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const folder = expectOk(
		await openFolder({ id: 'so.epicenter.vault', definition: reader }),
	);
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	const todos = folder.tables.todos;
	// The folder requires `done`, which the definition does not declare.
	expect(todos.canCreate).toBe(false);
	expect(
		expectErr(await todos.create({ fields: { title: 'Two' }, body: '' })).name,
	).toBe('InvalidValues');
	expectOk(await todos.set('one', { title: 'One, renamed' }));
	expect(await readFile(join(root, 'todos/one.md'), 'utf8')).toBe(
		'---\ntitle: One, renamed\ndone: false\nsource: phone\n---\n',
	);
	expect(await readFile(join(root, SCHEMA), 'utf8')).toBe(DECLARED);
	expect(
		changedPaths().filter((path) => path.endsWith('.epicenter.json')),
	).toEqual([]);
	await folder.close();

	const mismatch = defineFolder({
		tables: { todos: defineTable({ fields: { done: field.string() } }) },
	});
	const refused = expectErr(
		await openFolder({ id: 'so.epicenter.vault', definition: mismatch }),
	);
	expect(refused).toMatchObject({
		name: 'DefinitionMismatch',
		problems: [{ kind: 'incompatibleField', table: 'todos', field: 'done' }],
	});
});

test("a data folder's Sync merges rows by its own declaration", async () => {
	const project = await scratch('tauri-data-folder-sync-');
	const bare = await createBareRemote(project);
	const native = join(project, 'native');
	await git(project, 'clone', '--quiet', bare, native);
	await nodeFs.mkdir(join(native, 'todos'));
	await nodeFs.writeFile(join(native, SCHEMA), DECLARED);
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
	const folder = expectOk(await openFolder({ id: 'so.epicenter.vault' }));

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
		await todos.write('one', one!.row, {
			fields: { title: 'One', done: true },
			body: '',
		}),
	);
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expect(await readFile(join(root, 'todos/one.md'), 'utf8')).toBe(
		'---\ntitle: One, renamed\ndone: true\n---\n',
	);
	expect(await readFile(join(root, SCHEMA), 'utf8')).toBe(DECLARED);
	await folder.close();
});

test("a page's Sync runs in the CLI, reports what it wrote once, and merges competing edits with this device winning", async () => {
	const project = await scratch('tauri-sync-cli-');
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
		await openFolder({ definition, app: 'so.epicenter.todos' }),
	);
	const heard: unknown[] = [];
	folder.onFilesChanged((change) => heard.push(change));
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');

	await nodeFs.writeFile(
		join(native, 'todos/two.md'),
		'---\ntitle: Two\ndone: false\n---\n',
	);
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: Remote\ndone: false\n---\n',
	);
	await git(native, 'add', '--all');
	await git(native, 'commit', '--quiet', '-m', 'Remote');
	await git(native, 'push', '--quiet', 'origin', 'main');
	heard.length = 0;
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expect(heard).toEqual([['todos/one.md', 'todos/two.md']]);
	expect(shell.calls.filter(({ cmd }) => cmd === 'sync')).toHaveLength(2);

	await git(native, 'pull', '--quiet', 'origin', 'main');
	await nodeFs.writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: Theirs\ndone: false\n---\n',
	);
	await git(native, 'commit', '--quiet', '-am', 'Theirs');
	await git(native, 'push', '--quiet', 'origin', 'main');
	const one = expectOk(await folder.tables.todos.get('one'))!;
	expectOk(
		await folder.tables.todos.write('one', one.row, {
			fields: { title: 'Mine', done: false },
			body: '',
		}),
	);
	heard.length = 0;
	expect(expectOk(await folder.sync.run()).kind).toBe('synced');
	expect(await readFile(join(root, 'todos/one.md'), 'utf8')).toBe(
		'---\ntitle: Mine\ndone: false\n---\n',
	);
	expect(await git(root, 'log', '-1', '--format=%B')).toContain(
		'field="title" "todos/one.md"',
	);
	expect(await git(bare, 'rev-parse', 'main')).toBe(
		await git(root, 'rev-parse', 'HEAD'),
	);
	expect(shell.calls.filter(({ cmd }) => cmd === 'sync')).toHaveLength(3);
	await folder.close();
});
