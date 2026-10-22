/**
 * Folder commands run in fresh processes over isolated AppData. Bookmarks
 * are one JSON array in `bookmarks.json`; unavailable entries are retained,
 * malformed contents are left untouched, and concurrent writers keep every
 * entry. An earlier build's `folders.json` is never read or changed, and
 * connection commands use the fixed records folder whatever it says.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
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
	return { root, data, folder, authored, bookmarks, legacy, write, run };
}

test('list and help create nothing; add is idempotent and writes one array', async () => {
	const { data, folder, bookmarks, run } = await setup();
	expect(await run('folders', 'list')).toMatchObject({
		code: 0,
		reply: { folders: [] },
	});
	expect(Object.keys((await run('folders', 'list')).reply)).toEqual([
		'folders',
	]);
	expect(existsSync(data)).toBe(false);
	expect(
		(await run('folders', '--help')).reply.commands.map(
			(entry: { command: string }) => entry.command,
		),
	).toEqual(['folders add', 'folders list', 'folders forget']);
	expect(await run('folders', 'add', 'Notes')).toMatchObject({
		code: 0,
		reply: { path: folder, changed: true },
	});
	const before = await readFile(bookmarks, 'utf8');
	expect(await run('folders', 'add', folder)).toMatchObject({
		code: 0,
		reply: { changed: false },
	});
	expect(await readFile(bookmarks, 'utf8')).toBe(before);
	expect(JSON.parse(before)).toEqual([folder]);
	expect((await readdir(data)).sort()).toEqual([
		'.bookmarks.json.epicenter-save-lock',
		'bookmarks.json',
	]);
});

test('add and forget delete no source files', async () => {
	const { folder, bookmarks, run } = await setup();
	await writeFile(join(folder, 'keep.md'), 'Keep this.');
	await run('folders', 'add', folder);
	expect(await run('folders', 'forget', folder)).toMatchObject({
		code: 0,
		reply: { changed: true },
	});
	expect(JSON.parse(await readFile(bookmarks, 'utf8'))).toEqual([]);
	expect(await readFile(join(folder, 'keep.md'), 'utf8')).toBe('Keep this.');
});

test("an earlier build's folders.json is never read, migrated, or changed", async () => {
	const { folder, bookmarks, legacy, write, run } = await setup();
	const original = JSON.stringify({
		homes: { epicenter: '/old/records', todos: '/old/Todos' },
		folders: ['/old/shortcut'],
	});
	await write(legacy, original);
	expect((await run('folders', 'list')).reply).toEqual({ folders: [] });
	await run('folders', 'add', folder);
	expect(JSON.parse(await readFile(bookmarks, 'utf8'))).toEqual([folder]);
	expect(await readFile(legacy, 'utf8')).toBe(original);
	await write(legacy, 'not json');
	expect((await run('folders', 'forget', folder)).code).toBe(0);
	expect(await readFile(legacy, 'utf8')).toBe('not json');
});

test('entries kept as written survive a change and stay forgettable', async () => {
	const { folder, bookmarks, write, run } = await setup();
	const original = '["relative/entry", "/gone/away"]';
	await write(bookmarks, original);
	expect((await run('folders', 'list')).reply.folders).toHaveLength(2);
	expect(await readFile(bookmarks, 'utf8')).toBe(original);
	await run('folders', 'add', folder);
	expect(JSON.parse(await readFile(bookmarks, 'utf8'))).toEqual([
		'relative/entry',
		'/gone/away',
		folder,
	]);
	await run('folders', 'forget', 'relative/entry');
	await run('folders', 'forget', '/gone/away');
	expect(JSON.parse(await readFile(bookmarks, 'utf8'))).toEqual([folder]);
});

test('unavailable bookmarks stay listed with a problem and can be forgotten', async () => {
	const { folder, run } = await setup();
	await run('folders', 'add', folder);
	await rm(folder, { recursive: true });
	const result = await run('folders', 'list');
	expect(result.code).toBe(0);
	expect(result.reply.folders[0]).toEqual({
		path: folder,
		problem: expect.any(String),
	});
	expect((await run('folders', 'forget', folder)).code).toBe(0);
	expect((await run('folders', 'add', folder)).code).toBe(2);
});

test('malformed bookmarks are never overwritten by either mutation', async () => {
	const { folder, bookmarks, write, run } = await setup();
	for (const text of [
		'not json',
		'{"folders":[]}',
		'{"homes":{},"folders":[]}',
		'["/ok", 7]',
		'[{"path":"/with/id"}]',
	]) {
		await write(bookmarks, text);
		expect((await run('folders', 'list')).code).toBe(2);
		for (const action of ['add', 'forget']) {
			expect((await run('folders', action, folder)).code).toBe(2);
			expect(await readFile(bookmarks, 'utf8')).toBe(text);
		}
	}
});

test('concurrent CLI writers preserve every bookmark', async () => {
	const { root, bookmarks, run } = await setup();
	const folders = Array.from({ length: 6 }, (_, i) =>
		join(root, `folder-${i}`),
	);
	await Promise.all(folders.map((path) => mkdir(path)));
	const replies = await Promise.all(
		folders.map((path) => run('folders', 'add', path)),
	);
	expect(replies.map(({ code }) => code)).toEqual(folders.map(() => 0));
	expect(JSON.parse(await readFile(bookmarks, 'utf8')).sort()).toEqual(folders);
});

test('invalid UTF-8 inside a path is refused without replacing its bytes', async () => {
	const { folder, bookmarks, data, run } = await setup();
	await mkdir(data);
	const bytes = Buffer.concat([
		Buffer.from('["/'),
		Buffer.from([255]),
		Buffer.from('"]'),
	]);
	await writeFile(bookmarks, bytes);
	expect((await run('folders', 'add', folder)).code).toBe(2);
	expect(await readFile(bookmarks)).toEqual(bytes);
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
