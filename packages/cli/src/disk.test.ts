/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 * `update` changes what is there when it writes, never what was there when it read.
 */
import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { folderOnDisk } from './disk.ts';
import { gitIn } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
/** A repository to write in, and its folder. */
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-disk-'));
	roots.push(root);
	await gitIn(root, 'init', '-q');
	return { root, folder: folderOnDisk(root) };
}

test('writes make parents, replace whole files and leave no temporary files', async () => {
	const { root, folder } = await setup();
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

test('a write keeps the mode of the file it replaces', async () => {
	const { root, folder } = await setup();
	await folder.write('run.sh', 'echo one\n');
	await chmod(join(root, 'run.sh'), 0o755);
	await folder.write('run.sh', 'echo two\n');
	expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
	expect(await folder.read('run.sh')).toBe('echo two\n');
});

test('normalization refuses climbing, absolute and Git paths on every file method', async () => {
	const { folder } = await setup();
	for (const path of ['../x', '/abs', '.git/config']) {
		await expect(folder.read(path)).rejects.toThrow();
		await expect(folder.readBytes(path)).rejects.toThrow();
		await expect(folder.write(path, 'no')).rejects.toThrow();
		await expect(folder.writeBytes(path, new Uint8Array())).rejects.toThrow();
		await expect(folder.update(path, () => 'no')).rejects.toThrow();
		await expect(folder.delete(path)).rejects.toThrow();
		await expect(folder.list(path)).rejects.toThrow();
	}
});

test('listing is sorted and folder-relative and skips dependency trees and directory links', async () => {
	const { root, folder } = await setup();
	for (const file of [
		'z',
		'nested/b',
		'nested/a',
		'nested/.git/config',
		'nested/node_modules/pkg/file',
	]) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), 'data');
	}
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

test('update retries when another writer changes the file between its read and its write, and keeps both changes', async () => {
	const { root, folder } = await setup();
	await folder.write('list.txt', 'a\n');
	const seen: (string | undefined)[] = [];
	const written = await folder.update('list.txt', (text) => {
		seen.push(text);
		// Another writer, after this read and before this write.
		if (seen.length === 1) writeFileSync(join(root, 'list.txt'), `${text}b\n`);
		return `${text}c\n`;
	});
	expect(seen).toEqual(['a\n', 'a\nb\n']);
	expect(written).toBe('a\nb\nc\n');
	expect(await folder.read('list.txt')).toBe('a\nb\nc\n');
	expect(await folder.update('new.txt', (text) => `${text ?? 'made'}`)).toBe(
		'made',
	);
});

test('update gives up on a file that keeps changing, throwing Changed, and writes nothing', async () => {
	const { root, folder } = await setup();
	await folder.write('busy.txt', '0');
	let tries = 0;
	const error = await folder
		.update('busy.txt', () => {
			tries++;
			writeFileSync(join(root, 'busy.txt'), String(tries));
			return 'mine';
		})
		.catch((thrown: unknown) => thrown);
	expect(tries).toBe(10);
	expect(error).toEqual({
		name: 'Changed',
		message: 'busy.txt kept changing while it was updated',
	});
	expect(await folder.read('busy.txt')).toBe('10');
	expect((await readdir(root)).sort()).toEqual(['.git', 'busy.txt']);
});

test('update whose change throws writes nothing', async () => {
	const { root, folder } = await setup();
	await folder.write('kept.txt', 'kept');
	await expect(
		folder.update('kept.txt', () => {
			throw new Error('no change');
		}),
	).rejects.toThrow('no change');
	await expect(
		folder.update('absent.txt', () => {
			throw new Error('no file');
		}),
	).rejects.toThrow('no file');
	expect(await folder.read('kept.txt')).toBe('kept');
	expect((await readdir(root)).sort()).toEqual(['.git', 'kept.txt']);
});
