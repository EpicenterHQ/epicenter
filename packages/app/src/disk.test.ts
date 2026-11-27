import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareEpicenter, replaceFile } from './disk.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});
async function tempFolder() {
	const home = await mkdtemp(join(tmpdir(), 'disk-'));
	homes.push(home);
	return home;
}

test('.epicenter is private and ignored by Git, and repairs an older one', async () => {
	const home = await tempFolder();
	mkdirSync(join(home, '.epicenter'));
	chmodSync(join(home, '.epicenter'), 0o755);
	prepareEpicenter(home);
	expect(statSync(join(home, '.epicenter')).mode & 0o777).toBe(0o700);
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

test('replaceFile makes its folder, replaces text or bytes, and leaves no temporary file', async () => {
	const folder = join(await tempFolder(), 'codex/drafts');
	replaceFile(join(folder, 'a.md'), 'first');
	replaceFile(join(folder, 'a.md'), 'second');
	replaceFile(join(folder, 'log.bin'), new Uint8Array([1, 2]));
	expect(await readFile(join(folder, 'a.md'), 'utf8')).toBe('second');
	expect(await readFile(join(folder, 'log.bin'))).toEqual(Buffer.from([1, 2]));
	expect(await readdir(join(folder, '.tmp'))).toEqual([]);
});

test('a failed replaceFile keeps the old file and leaves no temporary file', async () => {
	const home = await tempFolder();
	const blocked = join(home, 'blocked');
	mkdirSync(blocked);
	expect(() => replaceFile(blocked, 'x', join(home, 'held'))).toThrow();
	expect(statSync(blocked).isDirectory()).toBe(true);
	expect(await readdir(join(home, 'held'))).toEqual([]);
});
