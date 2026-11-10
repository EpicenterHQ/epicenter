/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 * `update` changes what is there when it writes, never what was there when it read,
 * and concurrent updates, through it or a collection's `update`, each land.
 */
import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
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

test('a new .local file is readable by its owner alone, made by write or update', async () => {
	const { root, folder } = await setup();
	const mode = async (path: string) =>
		(await stat(join(root, path))).mode & 0o777;
	await folder.write('google.local.md', '---\nrefreshToken: "a"\n---\n');
	await folder.update('tokens.local/mail.md', () => 'b');
	await folder.write('notes.md', 'shared');
	expect(await mode('google.local.md')).toBe(0o600);
	expect(await mode('tokens.local/mail.md')).toBe(0o600);
	expect(await mode('notes.md')).not.toBe(0o600);
	// A .local file whose owner widened it keeps what they chose.
	await chmod(join(root, 'google.local.md'), 0o640);
	await folder.write('google.local.md', 'again');
	expect(await mode('google.local.md')).toBe(0o640);
});

test('a new directory on a .local path is open to its owner alone, and one there already keeps its mode', async () => {
	const { root, folder } = await setup();
	const mode = async (path: string) =>
		(await stat(join(root, path))).mode & 0o777;
	await folder.write('accounts/keys.local/mail/token.md', 'a');
	expect(await mode('accounts')).toBe(0o755);
	expect(await mode('accounts/keys.local')).toBe(0o700);
	expect(await mode('accounts/keys.local/mail')).toBe(0o700);
	await mkdir(join(root, 'shared.local'), { mode: 0o755 });
	await folder.update('shared.local/token.md', () => 'b');
	expect(await mode('shared.local')).toBe(0o755);
	await folder.write('notes/today.md', 'c');
	expect(await mode('notes')).toBe(0o755);
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

test('update waits while another update holds its claim, and lands once it is released', async () => {
	const { root, folder } = await setup();
	await folder.write('held.txt', 'a\n');
	const held = claimOf(root, 'held.txt', 'a\n');
	await writeFile(held, 'another update');
	setTimeout(() => rmSync(held), 300);
	const started = Date.now();
	expect(await folder.update('held.txt', (text) => `${text}b\n`)).toBe(
		'a\nb\n',
	);
	expect(Date.now() - started).toBeGreaterThanOrEqual(300);
	expect((await readdir(root)).sort()).toEqual(['.git', 'held.txt']);
});

test('update gives up after 10 seconds, throwing Changed and writing nothing, on a file that keeps changing or a claim that is never released', async () => {
	const { root, folder } = await setup();
	await folder.write('busy.txt', '0');
	let tries = 0;
	const busy = folder
		.update('busy.txt', () => {
			tries++;
			writeFileSync(join(root, 'busy.txt'), String(tries));
			return 'mine';
		})
		.catch((thrown: unknown) => thrown);
	// A claim from a clock ahead of this one is never old enough to clear.
	await folder.write('stuck.txt', 'a\n');
	const stuck = claimOf(root, 'stuck.txt', 'a\n');
	await writeFile(stuck, 'another update');
	const ahead = new Date(Date.now() + 60_000);
	await utimes(stuck, ahead, ahead);
	const started = Date.now();
	const [kept, claimed] = await Promise.all([
		busy,
		folder
			.update('stuck.txt', (text) => `${text}b\n`)
			.catch((thrown: unknown) => thrown),
	]);
	expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
	expect(kept).toEqual({
		name: 'Changed',
		message: 'busy.txt kept changing while it was updated',
	});
	expect(tries).toBeGreaterThan(10);
	expect(await folder.read('busy.txt')).toBe(String(tries));
	expect(claimed).toEqual({
		name: 'Changed',
		message:
			'stuck.txt stayed claimed by another update while it was updated; if no epicenter is running, remove the stuck.txt.*.claim.local file beside it',
	});
	expect(await folder.read('stuck.txt')).toBe('a\n');
	expect(await readFile(stuck, 'utf8')).toBe('another update');
	await rm(stuck);
	expect((await readdir(root)).sort()).toEqual([
		'.git',
		'busy.txt',
		'stuck.txt',
	]);
}, 20_000);

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
