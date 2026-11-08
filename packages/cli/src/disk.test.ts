/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { folderOnDisk } from './disk.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-disk-'));
	roots.push(root);
	return root;
}

test('writes make parents, replace whole files and leave no temporary files', async () => {
	const root = await setup();
	const folder = folderOnDisk(root);
	await folder.write('nested/a.txt', 'first');
	await folder.write('nested/a.txt', 'second');
	expect(await folder.read('nested/a.txt')).toBe('second');
	expect(await readdir(join(root, 'nested'))).toEqual(['a.txt']);
	await folder.writeBytes('bytes', new Uint8Array([0, 255]));
	expect(await folder.readBytes('bytes')).toEqual(Buffer.from([0, 255]));
	expect(await folder.read('missing')).toBeUndefined();
	await folder.delete('missing');
	await folder.delete('bytes');
	expect(await folder.readBytes('bytes')).toBeUndefined();
});

test('normalization refuses climbing, absolute and Git paths on every file method', async () => {
	const folder = folderOnDisk(await setup());
	for (const path of ['../x', '/abs', '.git/config']) {
		await expect(folder.read(path)).rejects.toThrow();
		await expect(folder.readBytes(path)).rejects.toThrow();
		await expect(folder.write(path, 'no')).rejects.toThrow();
		await expect(folder.writeBytes(path, new Uint8Array())).rejects.toThrow();
		await expect(folder.delete(path)).rejects.toThrow();
		await expect(folder.list(path)).rejects.toThrow();
	}
});

test('listing is sorted and folder-relative and skips dependency trees and directory links', async () => {
	const root = await setup();
	const folder = folderOnDisk(root);
	for (const file of [
		'z',
		'nested/b',
		'nested/a',
		'nested/.git/config',
		'nested/node_modules/pkg/file',
	])
		await folder.write(file, 'data');
	await mkdir(join(root, '.git'));
	await writeFile(join(root, '.git/config'), 'ignored');
	await symlink(join(root, 'nested'), join(root, 'directory-link'));
	await symlink(join(root, 'z'), join(root, 'file-link'));
	expect(await folder.list()).toEqual([
		'file-link',
		'nested/a',
		'nested/b',
		'z',
	]);
	expect(await folder.list('nested')).toEqual(['nested/a', 'nested/b']);
	expect(await folder.list('missing')).toEqual([]);
	expect(await folder.list('directory-link')).toEqual([]);
	expect(await folder.list('nested/node_modules')).toEqual([]);
});
