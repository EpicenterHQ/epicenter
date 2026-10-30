/**
 * Navigation command tests across fresh CLI processes and isolated AppData.
 * Checks strict storage, reset cleanup, path identity, and concurrent writers.
 */

import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-folders-')),
	);
	temporary.push(root);
	const data = join(root, 'app-data');
	const folder = join(root, 'Notes');
	const authored = join(root, 'Epicenter');
	await Promise.all([folder, authored].map((path) => mkdir(path)));
	const navigation = join(data, 'navigation.sqlite');
	const bookmarks = join(data, 'bookmarks.json');
	const legacy = join(data, 'folders.json');
	async function write(path: string, value: unknown) {
		await mkdir(data, { recursive: true });
		await writeFile(
			path,
			typeof value === 'string' ? value : JSON.stringify(value),
		);
	}
	async function run(...args: string[]) {
		const child = Bun.spawn(
			[process.execPath, resolve(import.meta.dir, 'bin.ts'), ...args, '--json'],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					EPICENTER_DATA_DIR: data,
					EPICENTER_FOLDER_DIR: authored,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, reply: JSON.parse(stdout), stderr };
	}
	return {
		root,
		data,
		folder,
		authored,
		navigation,
		bookmarks,
		legacy,
		write,
		run,
	};
}

function seed(path: string, pins: string[], recent: string[]) {
	const db = new Database(path, { create: true, readwrite: true });
	db.exec(
		'CREATE TABLE pins(path TEXT NOT NULL PRIMARY KEY) STRICT, WITHOUT ROWID; CREATE TABLE recent(path TEXT NOT NULL PRIMARY KEY, sequence INTEGER NOT NULL) STRICT; PRAGMA application_id = 0x45504E56; PRAGMA user_version = 1',
	);
	for (const path of pins)
		db.query('INSERT INTO pins(path) VALUES (?)').run(path);
	for (const [i, path] of recent.entries())
		db.query('INSERT INTO recent(path, sequence) VALUES (?, ?)').run(
			path,
			recent.length - i,
		);
	db.close();
}
function facts(path: string) {
	const db = new Database(path, { readwrite: true });
	const pins = (
		db.query('SELECT path FROM pins ORDER BY path').all() as { path: string }[]
	).map((r) => r.path);
	const recent = (
		db.query('SELECT path FROM recent ORDER BY sequence DESC').all() as {
			path: string;
		}[]
	).map((r) => r.path);
	const id = (
		db.query('PRAGMA application_id').get() as { application_id: number }
	).application_id;
	const version = (
		db.query('PRAGMA user_version').get() as { user_version: number }
	).user_version;
	const mode = (
		db.query('PRAGMA journal_mode').get() as { journal_mode: string }
	).journal_mode;
	db.close();
	return { pins, recent, id, version, mode };
}

test('list creates nothing; pin initializes the strict SQLite database and is idempotent', async () => {
	const { data, folder, navigation, run } = await setup();
	expect((await run('folders', 'list')).reply).toEqual({
		pins: [],
		recent: [],
	});
	expect(existsSync(data)).toBe(false);
	expect((await run('folders', 'pin', 'Notes')).reply).toMatchObject({
		path: folder,
		changed: true,
	});
	expect((await run('folders', 'pin', folder)).reply.changed).toBe(false);
	expect(facts(navigation)).toEqual({
		pins: [folder],
		recent: [],
		id: 0x45504e56,
		version: 1,
		mode: 'delete',
	});
	expect(await readdir(data)).toEqual(['navigation.sqlite']);
});

test('unpin and remove-recent change independent facts without touching authored files', async () => {
	const { data, folder, navigation, run } = await setup();
	await mkdir(data);
	seed(navigation, [folder], [folder]);
	await writeFile(join(folder, 'keep.md'), 'Keep');
	expect((await run('folders', 'unpin', folder)).reply.changed).toBe(true);
	expect(facts(navigation)).toMatchObject({ pins: [], recent: [folder] });
	expect((await run('folders', 'remove-recent', folder)).reply.changed).toBe(
		true,
	);
	expect(facts(navigation)).toMatchObject({ pins: [], recent: [] });
	expect(await readFile(join(folder, 'keep.md'), 'utf8')).toBe('Keep');
});

test('obsolete bookmarks are unlinked without parsing or affecting folders.json', async () => {
	const { folder, bookmarks, legacy, navigation, write, run } = await setup();
	await write(bookmarks, 'not json');
	await write(legacy, 'not json');
	expect((await run('folders', 'list')).code).toBe(0);
	expect(existsSync(bookmarks)).toBe(false);
	expect(existsSync(folder)).toBe(true);
	expect(await readFile(legacy, 'utf8')).toBe('not json');
	expect(existsSync(navigation)).toBe(false);
});

test('legacy symlink is unlinked, while a directory is refused', async () => {
	const { data, bookmarks, run } = await setup();
	await mkdir(data);
	const target = join(data, 'target');
	await writeFile(target, 'keep');
	await symlink(target, bookmarks);
	expect((await run('folders', 'list')).code).toBe(0);
	expect(await readFile(target, 'utf8')).toBe('keep');
	expect(existsSync(bookmarks)).toBe(false);
	await mkdir(bookmarks);
	expect((await run('folders', 'list')).code).toBe(2);
	expect(existsSync(bookmarks)).toBe(true);
});

test('missing references remain visible and removable', async () => {
	const { root, data, navigation, run } = await setup();
	const missing = join(root, 'Missing');
	await mkdir(data);
	seed(navigation, [missing], [missing]);
	const listed = (await run('folders', 'list')).reply;
	expect(listed.pins[0].problem).toEqual(expect.any(String));
	expect(listed.recent[0].problem).toEqual(expect.any(String));
	expect((await run('folders', 'unpin', missing)).code).toBe(0);
	expect((await run('folders', 'remove-recent', missing)).code).toBe(0);
	expect(facts(navigation)).toMatchObject({ pins: [], recent: [] });
});

test('corrupt and foreign databases are refused without replacement', async () => {
	const { data, folder, navigation, run } = await setup();
	await mkdir(data);
	const bytes = Buffer.from([0, 255, 1, 2]);
	await writeFile(navigation, bytes);
	for (const action of ['list', 'pin', 'unpin', 'remove-recent']) {
		expect(
			(await run('folders', action, ...(action === 'list' ? [] : [folder])))
				.code,
		).toBe(2);
		expect(await readFile(navigation)).toEqual(bytes);
	}
	await rm(navigation);
	const db = new Database(navigation, { create: true });
	db.exec('CREATE TABLE foreign_table(x TEXT)');
	db.close();
	expect((await run('folders', 'pin', folder)).code).toBe(2);
	const foreign = new Database(navigation);
	expect(
		foreign
			.query("SELECT name FROM sqlite_schema WHERE name='foreign_table'")
			.get(),
	).toBeTruthy();
	foreign.close();
});

test('concurrent CLI processes preserve every pin', async () => {
	const { root, navigation, run } = await setup();
	const folders = Array.from({ length: 6 }, (_, i) =>
		join(root, `folder-${i}`),
	);
	await Promise.all(folders.map((path) => mkdir(path)));
	expect(
		(await Promise.all(folders.map((path) => run('folders', 'pin', path)))).map(
			(r) => r.code,
		),
	).toEqual(folders.map(() => 0));
	expect(facts(navigation).pins).toEqual(folders);
});

test('alias membership is evaluated inside each SQLite write', async () => {
	const { data, folder, navigation, run } = await setup();
	await mkdir(data);
	const alias = join(folder, '.');
	seed(navigation, [alias], [alias]);
	expect((await run('folders', 'pin', folder)).reply.changed).toBe(false);
	expect((await run('folders', 'unpin', folder)).reply.changed).toBe(true);
	expect((await run('folders', 'remove-recent', folder)).reply.changed).toBe(
		true,
	);
	expect(facts(navigation)).toMatchObject({ pins: [], recent: [] });
});

test('stray JSON navigation is ignored during the clean SQLite reset', async () => {
	const { data, navigation, folder, run } = await setup();
	await mkdir(data);
	const old = join(data, 'navigation.json');
	await writeFile(old, 'broken');
	expect((await run('folders', 'list')).reply).toEqual({
		pins: [],
		recent: [],
	});
	expect((await run('folders', 'pin', folder)).code).toBe(0);
	expect(facts(navigation).pins).toEqual([folder]);
	expect(await readFile(old, 'utf8')).toBe('broken');
});

test('connection commands use the fixed records folder whatever folders.json names', async () => {
	const { root, authored, legacy, write, run } = await setup();
	const old = join(root, 'My setup');
	await mkdir(join(old, 'connections'), { recursive: true });
	await writeFile(
		join(old, 'connections/whispering-text.md'),
		'---\nkind: openai-compatible\ntitle: Old model\nmodel: old\n---\n',
	);
	const original = JSON.stringify({ homes: { epicenter: old }, folders: [] });
	await write(legacy, original);
	const records = join(authored, 'so.epicenter');
	expect(await run('whispering-connection', 'read', 'text')).toMatchObject({
		code: 0,
		reply: { row: null },
	});
	expect(existsSync(records)).toBe(false);
	await mkdir(join(records, 'connections'), { recursive: true });
	await writeFile(
		join(records, 'connections/whispering-text.md'),
		'---\nkind: openai-compatible\ntitle: My model\nmodel: test-model\n---\n',
	);
	const fixed = await run('whispering-connection', 'read', 'text');
	expect(fixed.code).toBe(0);
	expect(fixed.reply.row.text).toContain('My model');
	expect(await readFile(legacy, 'utf8')).toBe(original);
	expect(await readdir(join(root, 'app-data'))).toEqual(['folders.json']);
});
