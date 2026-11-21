import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineLocal } from './local.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});
async function tempHome() {
	const home = await mkdtemp(join(tmpdir(), 'local-'));
	homes.push(home);
	return home;
}
const mode = (path: string) => statSync(path).mode & 0o777;

test('opening a folder and reading it touch no file', async () => {
	const home = await tempHome();
	const mail = defineLocal(home)('mail');
	expect(mail.readText('a.md')).toBeUndefined();
	expect(mail.list()).toEqual([]);
	mail.delete('a.md');
	expect(await readdir(home)).toEqual([]);
});

test('path makes the folder, with local/ private and ignored by Git', async () => {
	const home = await tempHome();
	const path = defineLocal(home)('mail').path();
	expect(path).toBe(join(home, 'local', 'mail'));
	expect(statSync(path).isDirectory()).toBe(true);
	expect(mode(join(home, 'local'))).toBe(0o700);
	expect(await readFile(join(home, 'local/.gitignore'), 'utf8')).toBe('*\n');
});

test('a home made before this release gets the same promises', async () => {
	const home = await tempHome();
	mkdirSync(join(home, 'local'));
	chmodSync(join(home, 'local'), 0o755);
	defineLocal(home)('mail').path();
	expect(mode(join(home, 'local'))).toBe(0o700);
	expect(await readFile(join(home, 'local/.gitignore'), 'utf8')).toBe('*\n');
});

test('an existing .gitignore is kept', async () => {
	const home = await tempHome();
	mkdirSync(join(home, 'local'));
	await Bun.write(join(home, 'local/.gitignore'), '*\n!keep\n');
	defineLocal(home)('mail').path();
	expect(await readFile(join(home, 'local/.gitignore'), 'utf8')).toBe(
		'*\n!keep\n',
	);
});

test('write replaces a file, making its folder, and leaves nothing in .tmp', async () => {
	const home = await tempHome();
	const codex = defineLocal(home)('codex');
	codex.write('drafts/a.md', 'first');
	codex.write('drafts/a.md', 'second');
	codex.write('log.bin', new Uint8Array([1, 2]));
	expect(codex.readText('drafts/a.md')).toBe('second');
	expect(await readFile(join(codex.path(), 'log.bin'))).toEqual(
		Buffer.from([1, 2]),
	);
	expect(await readdir(join(home, 'local/.tmp'))).toEqual([]);
});

test('a missing file reads as undefined, and deleting one is not an error', async () => {
	const local = defineLocal(await tempHome())('flights');
	expect(local.readText('settings.md')).toBeUndefined();
	local.delete('settings.md');
	local.write('settings.md', 'x');
	local.delete('settings.md');
	expect(local.readText('settings.md')).toBeUndefined();
});

test('list names the files directly in a folder, sorted, and none for a missing one', async () => {
	const local = defineLocal(await tempHome())('messages');
	local.write('drafts/b.md', 'b');
	local.write('drafts/a.md', 'a');
	local.write('drafts/old/c.md', 'c');
	local.write('beeper.md', 't');
	expect(local.list('drafts')).toEqual(['drafts/a.md', 'drafts/b.md']);
	expect(local.list()).toEqual(['beeper.md']);
	expect(local.list('suggestions')).toEqual([]);
});

test('a file that manages itself opens at the folder path with no setup', async () => {
	const local = defineLocal(await tempHome())('mail');
	const db = new Database(join(local.path(), 'a.sqlite'), {
		create: true,
		strict: true,
	});
	db.run('CREATE TABLE t (x)');
	db.close();
	expect(statSync(join(local.path(), 'a.sqlite')).isFile()).toBe(true);
});
