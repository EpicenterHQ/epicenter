/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 * `update` changes what is there when it writes, never what was there when it read,
 * and concurrent updates in one process, through it or a data handle's `update`,
 * each land. Across processes a call's lock keeps writers apart (`layout.test.ts`).
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
import {
	ActionError,
	createMemoryContext,
	defineData,
	field,
	inRun,
	Ok,
} from '@epicenter/app';
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

test('a new file under local/ is readable by its owner alone and a new directory there is open to its owner alone', async () => {
	const { root, folder } = await setup();
	const mode = async (path: string) =>
		(await stat(join(root, path))).mode & 0o777;
	await folder.write('local/google.md', 'a');
	await folder.update('local/tokens/mail.md', () => 'b');
	expect(await mode('local')).toBe(0o700);
	expect(await mode('local/tokens')).toBe(0o700);
	expect(await mode('local/google.md')).toBe(0o600);
	expect(await mode('local/tokens/mail.md')).toBe(0o600);
	// What the owner widened keeps what they chose.
	await chmod(join(root, 'local/google.md'), 0o640);
	await folder.write('local/google.md', 'again');
	expect(await mode('local/google.md')).toBe(0o640);
	await chmod(join(root, 'local/tokens'), 0o755);
	await folder.write('local/tokens/calendar.md', 'd');
	expect(await mode('local/tokens')).toBe(0o755);
	expect(await mode('local/tokens/calendar.md')).toBe(0o600);
});

test('a write under data/ keeps its temporary file in local/, and a failed write removes it', async () => {
	const { root, folder } = await setup();
	await folder.write('data/a.md', 'first');
	await folder.update('data/a.md', (text) => `${text} second`);
	// A file cannot take the name of a directory, so this rename fails.
	await mkdir(join(root, 'data/taken'));
	await expect(folder.write('data/taken', 'no')).rejects.toThrow();
	expect(await folder.list()).toEqual(['data/a.md']);
	expect((await stat(join(root, 'local/.tmp'))).mode & 0o777).toBe(0o700);
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

test('update changes a file that starts with a byte order mark, comparing what is there as bytes', async () => {
	const { root, folder } = await setup();
	await writeFile(join(root, 'bom.txt'), '﻿a\n');
	expect(await folder.update('bom.txt', (text) => `${text}b\n`)).toBe('a\nb\n');
	expect(await folder.read('bom.txt')).toBe('a\nb\n');
});

test('concurrent updates of one file each land, and leave nothing beside it', async () => {
	const { folder } = await setup();
	await folder.write('log.txt', '');
	await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			folder.update('log.txt', (text = '') => `${text}${n}\n`),
		),
	);
	const lines = (await folder.read('log.txt'))?.trimEnd().split('\n');
	expect(lines?.sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
	expect(await folder.list()).toEqual(['log.txt']);
});

test('concurrent updates of one data file each land, each computed from the record it replaces', async () => {
	const { root, folder } = await setup();
	const { counters } = defineData({
		counters: { fields: { n: field.integer({ optional: true }) } },
	});
	await folder.write('data/counters/a.md', '---\nn: 0\n---\n');
	const context = { folder };
	await Promise.all(
		Array.from({ length: 5 }, () =>
			inRun(context, () =>
				counters.edit('a', (record) => Ok({ n: (record?.n ?? 0) + 1 })),
			),
		),
	);
	expect(await folder.read('data/counters/a.md')).toBe('---\nn: 5\n---\n');
	expect((await readdir(join(root, 'data/counters'))).sort()).toEqual(['a.md']);
});

test('an update that changes nothing leaves the file untouched', async () => {
	const { root, folder } = await setup();
	await folder.write('same.txt', 'a\n');
	const before = await stat(join(root, 'same.txt'));
	expect(await folder.update('same.txt', (text) => text ?? '')).toBe('a\n');
	const after = await stat(join(root, 'same.txt'));
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
});

test('update runs its change once and does not look at the file again', async () => {
	const { root, folder } = await setup();
	await folder.write('once.txt', '0');
	let runs = 0;
	const written = await folder.update('once.txt', () => {
		runs++;
		// A writer outside epicenter is not guarded against: the update wins.
		writeFileSync(join(root, 'once.txt'), 'outside');
		return 'mine';
	});
	expect([runs, written]).toEqual([1, 'mine']);
	expect(await folder.read('once.txt')).toBe('mine');
	expect(await folder.list()).toEqual(['once.txt']);
});

test('update whose change throws writes nothing', async () => {
	const { folder } = await setup();
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
	expect(await folder.list()).toEqual(['kept.txt']);
});

test('a data update forwards returned Changed and lets a thrown Changed escape, including on an absent file', async () => {
	const disk = await setup();
	const data = defineData({
		'counter.md': { fields: { n: field.integer({ optional: true }) } },
	});
	const counter = data['counter.md'];
	for (const folder of [disk.folder, createMemoryContext().folder]) {
		const path = 'data/counter.md';
		const refusal = ActionError.Changed({ path, cause: 'quote' });
		expect(await inRun({ folder }, () => counter.edit(() => refusal))).toBe(
			refusal,
		);
		const thrown = await inRun({ folder }, () =>
			counter.edit(() => {
				throw refusal.error;
			}),
		).catch((cause: unknown) => cause);
		expect(thrown).toBe(refusal.error);
		expect(await folder.read(path)).toBeUndefined();
	}
});
