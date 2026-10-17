/**
 * Data Folder Tests
 *
 * `openFolder` from `@epicenter/folder/bun` opens a directory that already
 * exists with the schema in its own `epicenter.json` (ADR-0535).
 *
 * Key behaviors:
 * - The handle's tables are the declaration's, and `definition` is the
 *   prepared declaration
 * - The handle never writes `epicenter.json`: a hand-formatted declaration
 *   stays byte for byte through creates, writes, and commits
 * - A declaration an earlier build wrote, with the `kv` section settings once
 *   had, is `InvalidDeclaration` naming `kv`, as any unknown key is
 * - A folder without `epicenter.json` opens with no tables; files and
 *   history work
 * - An `epicenter.json` that cannot be used is `InvalidDeclaration`, and a
 *   missing root is `InvalidRoot`; neither creates anything
 * - Opening creates no repository: status is an empty history with every file
 *   uncommitted, and the first commit runs `git init`
 * - The first commit of a folder inside another repository's working tree is
 *   `blocked`, and creates no repository of its own
 * - Sync merges rows by the folder's own declaration
 * - A browser folder opened by `openFolder` reads with its own
 *   declaration, as of the open, and never writes it
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openFolder as openBrowserDataFolder } from './browser.js';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { openFolder, readFolder } from './bun.js';
import { defineFolder, defineTable, field } from './contract.js';
import {
	createBareRemote,
	GIT_ENV,
	git,
	scratch,
} from './git-http.test-support.js';
import { mustRow } from './row-write.test-support.js';

const author = { name: 'Vault', email: 'vault@localhost' };

/** Written by hand: one line, no `$schema` order a publication would keep. */
const DECLARED = `{"title":"Vault","tables":{"todos":{"type":"object","properties":{"title":{"type":"string"},"done":{"type":"boolean"}},"required":["title","done"]}}}`;

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

/** A directory holding `DECLARED` and one row, with no repository. */
async function dataFolder(prefix: string) {
	const root = await scratch(prefix);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	await mkdir(join(root, 'todos'));
	await writeFile(
		join(root, 'todos/one.md'),
		'---\ntitle: One\ndone: false\n---\n',
	);
	return root;
}

test('opens with its own declaration and never writes it', async () => {
	const root = await dataFolder('data-folder-declared-');
	const folder = expectOk(await openFolder({ root, git: { author } }));
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	expect(folder.definition.title).toBe('Vault');
	expect(folder.definition).toEqual(
		expectOk(await readFolder(root)).definition,
	);
	const heard: string[] = [];
	folder.onFilesChanged((paths) => heard.push(...paths));

	const todos = folder.tables.todos!;
	const [one] = expectOk(await todos.list());
	expect(one).toMatchObject({
		stem: 'one',
		result: { data: { row: { fields: { title: 'One', done: false } } } },
	});
	const created = mustRow(
		await todos.create({ fields: { title: 'Two', done: false }, body: '' }),
	);
	const stem = created.path.slice('todos/'.length, -'.md'.length);
	expectOk(
		await todos.write(stem, created.row, {
			fields: { title: 'Two', done: true },
			body: 'Done.\n',
		}),
	);
	// A row the declaration refuses is refused before anything is written.
	expect(
		expectErr(await todos.create({ fields: { title: 3 }, body: '' })).name,
	).toBe('InvalidValues');
	expect((await folder.git.commit()).status).toBe('committed');

	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	expect(heard).not.toContain('epicenter.json');
	expect(expectOk(await todos.list())).toHaveLength(2);
	await folder.close();
});

test('a folder without epicenter.json opens with no tables, and files and history work', async () => {
	const root = await scratch('data-folder-undeclared-');
	await writeFile(join(root, 'notes.txt'), 'kept\n');
	const folder = expectOk(await openFolder({ root, git: { author } }));
	expect(folder.definition).toEqual({ tables: {} });
	expect(folder.tables).toEqual({});
	expectOk(await folder.write('more/a.md', null, 'a\n'));
	expect((await folder.git.commit()).status).toBe('committed');
	expect(existsSync(join(root, 'epicenter.json'))).toBe(false);
	expect(await git(root, 'ls-files')).toBe('more/a.md\nnotes.txt');
	await folder.close();
});

test('an epicenter.json that cannot be used is InvalidDeclaration, and opening creates nothing', async () => {
	const root = await scratch('data-folder-invalid-');
	await writeFile(join(root, 'epicenter.json'), '{"tables":{}');
	const refused = expectErr(await openFolder({ root, git: { author } }));
	expect(refused.name).toBe('InvalidDeclaration');
	expect(refused.message).toContain('not JSON');
	expect(existsSync(join(root, '.git'))).toBe(false);

	await writeFile(join(root, 'epicenter.json'), '{"tables":{},"extra":1}');
	expect(expectErr(await openFolder({ root, git: { author } })).name).toBe(
		'InvalidDeclaration',
	);

	// The `kv` section settings once had is an unknown key like any other.
	await writeFile(
		join(root, 'epicenter.json'),
		'{"tables":{},"kv":{"theme":{"type":"string"}}}',
	);
	const kv = expectErr(await openFolder({ root, git: { author } }));
	expect(kv.name).toBe('InvalidDeclaration');
	expect(kv.message).toContain("'kv'");
	expect(existsSync(join(root, '.git'))).toBe(false);

	const missing = join(root, 'missing');
	expect(
		expectErr(await openFolder({ root: missing, git: { author } })).name,
	).toBe('InvalidRoot');
	expect(existsSync(missing)).toBe(false);
});

test('opening creates no repository; status is every file uncommitted, and the first commit creates one', async () => {
	const root = await dataFolder('data-folder-repository-');
	await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
	await writeFile(join(root, 'ignored.txt'), 'local\n');
	const folder = expectOk(await openFolder({ root, git: { author } }));
	expect(existsSync(join(root, '.git'))).toBe(false);

	const status = expectOk(await folder.git.status());
	expect(status.head).toBeUndefined();
	expect(status.changes.map((change) => change.path).sort()).toEqual([
		'.gitignore',
		'epicenter.json',
		'todos/one.md',
	]);
	expect(expectOk(await folder.git.log(10))).toEqual([]);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);

	// A save stages its bytes under `.git`, and still creates no repository.
	expectOk(
		await folder.tables.todos!.create({
			fields: { title: 'Two', done: false },
			body: '',
		}),
	);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);

	const committed = await folder.git.commit();
	expect(committed).toMatchObject({ status: 'committed', parent: undefined });
	expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
	expect(await git(root, 'status', '--porcelain')).toBe('');
	expect(await git(root, 'ls-files')).not.toContain('ignored.txt');
	expect(await git(root, 'log', '--format=%an <%ae>', '-1')).toBe(
		'Vault <vault@localhost>',
	);
	await git(root, 'fsck', '--strict');
	expect(expectOk(await folder.git.status()).changes).toEqual([]);
	await folder.close();
});

test('the first commit inside another repository is blocked and creates no repository', async () => {
	const host = await realpath(await scratch('data-folder-host-'));
	await git(host, 'init', '--quiet', '--initial-branch=main');
	const root = join(host, 'plan');
	await mkdir(root);
	await writeFile(join(root, 'epicenter.json'), DECLARED);
	const folder = expectOk(await openFolder({ root, git: { author } }));
	expectOk(
		await folder.tables.todos!.create({
			fields: { title: 'Hosted', done: false },
			body: '',
		}),
	);
	const commit = await folder.git.commit();
	expect(commit).toMatchObject({ status: 'blocked' });
	expect(commit.status === 'blocked' && commit.reason).toContain(
		`inside the repository at ${host}`,
	);
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	// The host's Git sees the data folder's files as its own.
	expect(
		await git(host, 'status', '--porcelain', '--untracked-files=all'),
	).toContain('plan/todos/');
	await folder.close();
});

test("sync merges rows by the folder's own declaration", async () => {
	const project = await scratch('data-folder-sync-');
	const bare = await createBareRemote(project);
	const native = join(project, 'native');
	await git(project, 'clone', '--quiet', bare, native);
	await writeFile(join(native, 'epicenter.json'), DECLARED);
	await mkdir(join(native, 'todos'));
	await writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: One\ndone: false\n---\n',
	);
	await git(native, 'add', '--all');
	await git(native, 'commit', '--quiet', '-m', 'Start');
	await git(native, 'push', '--quiet', 'origin', 'HEAD:main');

	const root = join(project, 'desktop');
	await git(project, 'clone', '--quiet', bare, root);
	const folder = expectOk(await openFolder({ root, git: { author } }));

	// The title changes on one side and `done` on the other: adjacent lines,
	// which a line merge would hold for a person, and two fields, which a row
	// merge by the declaration combines.
	await writeFile(
		join(native, 'todos/one.md'),
		'---\ntitle: One, renamed\ndone: false\n---\n',
	);
	await git(native, 'commit', '--quiet', '-am', 'Rename');
	await git(native, 'push', '--quiet', 'origin', 'main');
	const todos = folder.tables.todos!;
	const one = expectOk(await todos.get('one'));
	expect(one).toBeDefined();
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
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(DECLARED);
	await folder.close();
});

test('openFolder still publishes its own definition, and exposes it', async () => {
	const root = await dataFolder('data-folder-app-');
	const definition = defineFolder({
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const folder = expectOk(
		await openFolder({
			app: basename(root),
			root,
			definition,
			git: { author },
		}),
	);
	expect(folder.definition).toBe(definition);
	// Opening creates no repository; the first commit does.
	expect(existsSync(join(root, '.git/HEAD'))).toBe(false);
	expectOk(await folder.write('notes.txt', null, 'a\n'));
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).not.toBe(
		DECLARED,
	);
	await folder.close();
});

test('a browser data folder reads with its own declaration, as of the open, and never writes it', async () => {
	const environment = createTestStorage();
	const open = async () =>
		expectOk(
			await openBrowserDataFolder({
				id: 'vault',
				browser: { ...browserStorage(environment), author },
			}),
		);
	const first = await open();
	// Nothing is created by opening; a folder nobody wrote to has no tables.
	expect(environment.opfs.directories()).toEqual([]);
	expect(first.definition).toEqual({ tables: {} });
	expectOk(await first.write('epicenter.json', null, DECLARED));
	expect(first.tables).toEqual({});
	await first.close();

	const folder = await open();
	expect(Object.keys(folder.definition.tables)).toEqual(['todos']);
	expectOk(
		await folder.tables.todos!.create({
			fields: { title: 'One', done: false },
			body: '',
		}),
	);
	expect((await folder.git.commit()).status).toBe('committed');
	expect(
		new TextDecoder().decode(
			expectOk(await folder.files.read('epicenter.json')).bytes,
		),
	).toBe(DECLARED);
	await folder.close();
});
