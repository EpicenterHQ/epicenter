import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { openFolder, pathRefusal } from './folder.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

const write = (text: string) => () => Ok({ text, value: undefined });

test('a write outside data/ throws and touches nothing', async () => {
	const home = await mkdtemp(join(tmpdir(), 'epicenter-folder-'));
	homes.push(home);
	const folder = openFolder(home);
	for (const path of [
		'epicenter.ts',
		'local/cache.json',
		'data/../epicenter.ts',
		'/etc/hosts',
		'data\\x.md',
	])
		await expect(folder.edit(path, write('x'))).rejects.toThrow();
	expect(existsSync(join(home, 'local'))).toBe(false);
	await folder.edit('./data//notes/a.md', write('hello'));
	expect(await readFile(join(home, 'data/notes/a.md'), 'utf8')).toBe('hello');
});

test('pathRefusal names why a path is refused', () => {
	expect(pathRefusal('data/a.md')).toBeUndefined();
	expect(pathRefusal('../a')).toContain('climbs out');
	expect(pathRefusal('.git/config')).toContain('inside .git');
	expect(pathRefusal('/a')).toContain('not a relative path');
	expect(pathRefusal('')).toBe('a path is needed');
});
