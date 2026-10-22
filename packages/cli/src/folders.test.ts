/**
 * Folder commands run in fresh processes over isolated AppData. They preserve
 * the selected records folder, migrate existing lists without losing paths,
 * retain unavailable entries, and leave malformed configuration untouched.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
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
	const records = join(root, 'My setup');
	const authored = join(root, 'Epicenter');
	await Promise.all([folder, records, authored].map((path) => mkdir(path)));
	const config = join(data, 'folders.json');
	async function write(value: unknown) {
		await mkdir(data, { recursive: true });
		await writeFile(
			config,
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
	return { root, data, folder, records, authored, config, write, run };
}

test('list and help create nothing; add is idempotent and does not select a records folder', async () => {
	const { data, folder, config, run } = await setup();
	expect(await run('folders', 'list')).toMatchObject({
		code: 0,
		reply: { epicenter: null, folders: [] },
	});
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
	const before = await readFile(config, 'utf8');
	expect(await run('folders', 'add', folder)).toMatchObject({
		code: 0,
		reply: { changed: false },
	});
	expect(await readFile(config, 'utf8')).toBe(before);
	expect(JSON.parse(before)).toEqual({ homes: {}, folders: [folder] });
});

test('add and forget preserve the selected folder and delete no source files', async () => {
	const { folder, records, config, write, run } = await setup();
	await write({ epicenter: records, folders: [] });
	await writeFile(join(folder, 'keep.md'), 'Keep this.');
	await run('folders', 'add', folder);
	expect(await run('folders', 'forget', folder)).toMatchObject({
		code: 0,
		reply: { changed: true },
	});
	expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
		homes: { epicenter: records },
		folders: [],
	});
	expect(await readFile(join(folder, 'keep.md'), 'utf8')).toBe('Keep this.');
});

test('old arrays retain exact spellings and convert on the first real change', async () => {
	const { folder, config, write, run } = await setup();
	const original = '["relative/entry", "/gone/away"]';
	await write(original);
	expect((await run('folders', 'list')).reply.folders).toHaveLength(2);
	expect(await readFile(config, 'utf8')).toBe(original);
	await run('folders', 'add', folder);
	expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
		homes: {},
		folders: ['relative/entry', '/gone/away', folder],
	});
	await run('folders', 'forget', 'relative/entry');
	await run('folders', 'forget', '/gone/away');
	expect(JSON.parse(await readFile(config, 'utf8')).folders).toEqual([folder]);
});

test('unavailable shortcuts stay listed with a problem and can be forgotten', async () => {
	const { folder, run } = await setup();
	await run('folders', 'add', folder);
	await rm(folder, { recursive: true });
	const result = await run('folders', 'list');
	expect(result.code).toBe(0);
	expect(result.reply.folders[0]).toMatchObject({
		path: folder,
		problem: expect.any(String),
	});
	expect((await run('folders', 'forget', folder)).code).toBe(0);
	expect((await run('folders', 'add', folder)).code).toBe(2);
});

test('malformed and newer configuration is never overwritten by either mutation', async () => {
	const { folder, config, write, run } = await setup();
	for (const text of [
		'not json',
		'{"folders":[]}',
		'{"epicenter":"relative","folders":[]}',
		'{"epicenter":null,"folders":[],"future":true}',
	]) {
		await write(text);
		for (const action of ['add', 'forget']) {
			expect((await run('folders', action, folder)).code).toBe(2);
			expect(await readFile(config, 'utf8')).toBe(text);
		}
	}
});

test('concurrent CLI writers preserve every shortcut and the selected records folder', async () => {
	const { root, records, config, write, run } = await setup();
	await write({ epicenter: records, folders: [] });
	const folders = Array.from({ length: 6 }, (_, i) =>
		join(root, `folder-${i}`),
	);
	await Promise.all(folders.map((path) => mkdir(path)));
	const replies = await Promise.all(
		folders.map((path) => run('folders', 'add', path)),
	);
	expect(replies.map(({ code }) => code)).toEqual(folders.map(() => 0));
	const saved = JSON.parse(await readFile(config, 'utf8'));
	expect(saved.homes.epicenter).toBe(records);
	expect(saved.folders.sort()).toEqual(folders);
});

test('shortcut and connection writers preserve every shared app home', async () => {
	const { folder, records, authored, config, write, run } = await setup();
	const homes = {
		epicenter: records,
		todos: folder,
		honeycrisp: join(authored, 'Notes'),
	};
	await write({ homes, folders: [] });
	expect((await run('folders', 'list')).reply.homes).toEqual(homes);
	expect((await run('folders', 'add', folder)).code).toBe(0);
	expect((await run('whispering-connection', 'read', 'text')).code).toBe(0);
	expect((await run('folders', 'forget', folder)).code).toBe(0);
	expect(JSON.parse(await readFile(config, 'utf8'))).toEqual({
		homes,
		folders: [],
	});
});

test('invalid UTF-8 inside a path is refused without replacing its bytes', async () => {
	const { folder, config, data, run } = await setup();
	await mkdir(data);
	const bytes = Buffer.concat([
		Buffer.from('{"epicenter":null,"folders":["/'),
		Buffer.from([255]),
		Buffer.from('"]}'),
	]);
	await writeFile(config, bytes);
	expect((await run('folders', 'add', folder)).code).toBe(2);
	expect(await readFile(config)).toEqual(bytes);
});

test('connection commands use a renamed records folder and refuse to recreate a missing selection', async () => {
	const { records, authored, write, run } = await setup();
	await mkdir(join(records, 'connections'));
	await writeFile(
		join(records, 'connections/whispering-text.md'),
		'---\nkind: openai-compatible\ntitle: My model\nmodel: test-model\n---\n',
	);
	await write({ epicenter: records, folders: [] });
	const selected = await run('whispering-connection', 'read', 'text');
	expect(selected.code).toBe(0);
	expect(selected.reply.row.text).toContain('My model');
	await rm(records, { recursive: true });
	expect((await run('whispering-connection', 'read', 'text')).code).toBe(2);
	expect(existsSync(records)).toBe(false);
	expect(existsSync(join(authored, 'so.epicenter'))).toBe(false);
});
