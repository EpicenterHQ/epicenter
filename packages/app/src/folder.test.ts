import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEpicenter } from './disk.ts';
import { folderAt } from './folder.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});
async function tempFolder() {
	const home = await mkdtemp(join(tmpdir(), 'folder-'));
	homes.push(home);
	return home;
}
const mode = (path: string) => statSync(path).mode & 0o777;

test('opening a folder and reading it touch no file', async () => {
	const home = await tempFolder();
	const mail = folderAt(join(home, 'mail'));
	expect(mail.readText('a.md')).toBeUndefined();
	expect(mail.list()).toEqual([]);
	mail.delete('a.md');
	expect(await readdir(home)).toEqual([]);
});

test('.epicenter is private and ignored by Git, and repairs an older one', async () => {
	const home = await tempFolder();
	mkdirSync(join(home, '.epicenter'));
	chmodSync(join(home, '.epicenter'), 0o755);
	prepareEpicenter(home);
	expect(mode(join(home, '.epicenter'))).toBe(0o700);
	expect(await readFile(join(home, '.epicenter/.gitignore'), 'utf8')).toBe(
		'*\n',
	);
});

test('an existing .gitignore is kept', async () => {
	const home = await tempFolder();
	mkdirSync(join(home, '.epicenter'));
	await Bun.write(join(home, '.epicenter/.gitignore'), '*\n!keep\n');
	prepareEpicenter(home);
	expect(await readFile(join(home, '.epicenter/.gitignore'), 'utf8')).toBe(
		'*\n!keep\n',
	);
});

test('write replaces a file, making its folder, and leaves nothing in .tmp', async () => {
	const codex = folderAt(join(await tempFolder(), 'codex'));
	codex.write('drafts/a.md', 'first');
	codex.write('drafts/a.md', 'second');
	codex.write('log.bin', new Uint8Array([1, 2]));
	expect(codex.readText('drafts/a.md')).toBe('second');
	expect(await readFile(join(codex.path(), 'log.bin'))).toEqual(
		Buffer.from([1, 2]),
	);
	expect(await readdir(join(codex.path(), '.tmp'))).toEqual([]);
});

test('a missing file reads as undefined, and deleting one is not an error', async () => {
	const folder = folderAt(join(await tempFolder(), 'flights'));
	expect(folder.readText('settings.md')).toBeUndefined();
	folder.delete('settings.md');
	folder.write('settings.md', 'x');
	folder.delete('settings.md');
	expect(folder.readText('settings.md')).toBeUndefined();
});

test('list names the files directly in a folder, sorted, and none for a missing one', async () => {
	const folder = folderAt(join(await tempFolder(), 'messages'));
	folder.write('drafts/b.md', 'b');
	folder.write('drafts/a.md', 'a');
	folder.write('drafts/old/c.md', 'c');
	folder.write('beeper.md', 't');
	expect(folder.list('drafts')).toEqual(['drafts/a.md', 'drafts/b.md']);
	expect(folder.list()).toEqual(['beeper.md']);
	expect(folder.list('suggestions')).toEqual([]);
});

test('a file that manages itself opens at the folder path with no setup', async () => {
	const folder = folderAt(join(await tempFolder(), 'mail'));
	const db = new Database(join(folder.path(), 'a.sqlite'), {
		create: true,
		strict: true,
	});
	db.run('CREATE TABLE t (x)');
	db.close();
	expect(statSync(join(folder.path(), 'a.sqlite')).isFile()).toBe(true);
});
