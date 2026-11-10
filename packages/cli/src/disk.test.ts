/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 * `update` changes what is there when it writes, never what was there when it read,
 * and concurrent updates, through it or a collection's `update`, each land.
 */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defineCollection, field, inRun } from '@epicenter/app';
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

test('new local files are private, including files in a local directory', async () => {
	const { root, folder } = await setup();
	await folder.write('google.local.md', 'token');
	await folder.writeBytes('tokens.local/item.md', new Uint8Array([1]));
	expect((await stat(join(root, 'google.local.md'))).mode & 0o777).toBe(0o600);
	expect((await stat(join(root, 'tokens.local/item.md'))).mode & 0o777).toBe(
		0o600,
	);
});

test('a local one-file collection gets, sets, and updates on disk', async () => {
	const { root, folder } = await setup();
	const google = defineCollection({
		path: 'google.local.md',
		fields: { refreshToken: field.text({ optional: true }) },
	});
	const context = { folder };
	await inRun(context, () => google.set({ refreshToken: 'first' }));
	expect(await inRun(context, () => google.get())).toMatchObject({
		refreshToken: 'first',
	});
	await inRun(context, () =>
		google.update((before) => ({
			refreshToken: `${before.refreshToken} second`,
		})),
	);
	expect(await folder.read('google.local.md')).toContain('first second');
	expect((await stat(join(root, 'google.local.md'))).mode & 0o777).toBe(0o600);
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

test('update changes a file that starts with a byte order mark, comparing what is there as bytes', async () => {
	const { root, folder } = await setup();
	await writeFile(join(root, 'bom.txt'), '﻿a\n');
	expect(await folder.update('bom.txt', (text) => `${text}b\n`)).toBe('a\nb\n');
	expect(await folder.read('bom.txt')).toBe('a\nb\n');
});

test('concurrent updates of one file each land, and leave nothing beside it', async () => {
	const { root, folder } = await setup();
	await folder.write('log.txt', '');
	await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			folder.update('log.txt', (text = '') => `${text}${n}\n`),
		),
	);
	const lines = (await folder.read('log.txt'))?.trimEnd().split('\n');
	expect(lines?.sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
	expect((await readdir(root)).sort()).toEqual(['.git', 'log.txt']);
});

test('concurrent updates of one collection file each land, each computed from the record it replaces', async () => {
	const { root, folder } = await setup();
	const counters = defineCollection({
		path: 'counters/{id}.md',
		fields: { n: field.integer({ optional: true }) },
	});
	await folder.write('counters/a.md', '---\nn: 0\n---\n');
	const context = { folder };
	const at = { path: 'counters/a.md' };
	await Promise.all(
		Array.from({ length: 5 }, () =>
			inRun(context, () =>
				counters.update(at, (record) => ({ n: (record.n ?? 0) + 1 })),
			),
		),
	);
	expect(await folder.read('counters/a.md')).toBe('---\nn: 5\n---\n');
	expect((await readdir(join(root, 'counters'))).sort()).toEqual(['a.md']);
});

/** The claim an update of `path` makes while it holds `text`. */
function claimOf(root: string, path: string, text: string) {
	const tag = createHash('sha256').update(text).digest('hex').slice(0, 16);
	return join(root, `${path}.${tag}.claim.local`);
}

test('update clears a claim a crash left, and lands, even when two updates find it', async () => {
	const { root, folder } = await setup();
	await folder.write('list.txt', 'a\n');
	const left = claimOf(root, 'list.txt', 'a\n');
	await writeFile(left, 'crashed');
	const old = new Date(Date.now() - 60_000);
	await utimes(left, old, old);
	await Promise.all([
		folder.update('list.txt', (text) => `${text}b\n`),
		folder.update('list.txt', (text) => `${text}c\n`),
	]);
	const lines = (await folder.read('list.txt'))?.trimEnd().split('\n');
	expect(lines?.sort()).toEqual(['a', 'b', 'c']);
	expect((await readdir(root)).sort()).toEqual(['.git', 'list.txt']);
});

test('update waits on a fresh claim, which another update holds, and gives up with Changed', async () => {
	const { root, folder } = await setup();
	await folder.write('held.txt', 'a\n');
	const held = claimOf(root, 'held.txt', 'a\n');
	await writeFile(held, 'another update');
	const error = await folder
		.update('held.txt', (text) => `${text}b\n`)
		.catch((thrown: unknown) => thrown);
	expect(error).toMatchObject({ name: 'Changed' });
	expect(await folder.read('held.txt')).toBe('a\n');
	expect(await readFile(held, 'utf8')).toBe('another update');
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
