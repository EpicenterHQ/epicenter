/**
 * The folder on disk (ADR-0964): `path`, `write`, `edit` and `delete`.
 *
 * Key behaviors:
 * - A write replaces a whole file at once, keeps the mode of the file it
 *   replaces, and leaves no temporary file beside it.
 * - Every write and delete outside `data/` and `local/` throws, and so does a
 *   path that climbs out, is absolute, or reaches into `.git`.
 * - A new file under `local/` is `0600`, and making `local/` writes
 *   `local/.gitignore` containing `*` (ADR-0963).
 * - `edit` changes what is there when it writes, never what was there when
 *   it read; concurrent edits in one process each land, and `Ok({})` or an
 *   error writes nothing.
 */
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { normalizePath } from './folder.ts';
import { ActionError, defineData, Err, field, Ok } from './index.ts';
import { tempFolder } from './temp-folder.test-support.ts';

test('path is the directory the folder was made on', async () => {
	const { dir, folder } = await tempFolder();
	expect(folder.path).toBe(dir);
});

test('writes make parents, replace whole files and take text or bytes', async () => {
	const { dir, folder, read } = await tempFolder();
	await folder.write('data/nested/a.txt', 'first');
	await folder.write('data/nested/a.txt', 'second');
	expect(await read('data/nested/a.txt')).toBe('second');
	expect(await readdir(join(dir, 'data/nested'))).toEqual(['a.txt']);
	await folder.write('data/bytes', new Uint8Array([0, 255]));
	expect(
		new Uint8Array(await Bun.file(join(dir, 'data/bytes')).bytes()),
	).toEqual(new Uint8Array([0, 255]));
	await folder.delete('data/missing');
	await folder.delete('data/bytes');
	expect(await read('data/bytes')).toBeUndefined();
});

test('a write keeps the mode of the file it replaces', async () => {
	const { dir, folder, read } = await tempFolder();
	await folder.write('data/run.sh', 'echo one\n');
	await chmod(join(dir, 'data/run.sh'), 0o755);
	await folder.write('data/run.sh', 'echo two\n');
	expect((await stat(join(dir, 'data/run.sh'))).mode & 0o777).toBe(0o755);
	expect(await read('data/run.sh')).toBe('echo two\n');
});

test('a new file under local/ is readable by its owner alone and a new directory there is open to its owner alone', async () => {
	const { dir, folder } = await tempFolder();
	const mode = async (path: string) =>
		(await stat(join(dir, path))).mode & 0o777;
	await folder.write('local/google.md', 'a');
	await folder.edit('local/tokens/mail.md', () => Ok({ text: 'b' }));
	expect(await mode('local')).toBe(0o700);
	expect(await mode('local/tokens')).toBe(0o700);
	expect(await mode('local/google.md')).toBe(0o600);
	expect(await mode('local/tokens/mail.md')).toBe(0o600);
	// What the owner widened keeps what they chose.
	await chmod(join(dir, 'local/google.md'), 0o640);
	await folder.write('local/google.md', 'again');
	expect(await mode('local/google.md')).toBe(0o640);
	await chmod(join(dir, 'local/tokens'), 0o755);
	await folder.write('local/tokens/calendar.md', 'd');
	expect(await mode('local/tokens')).toBe(0o755);
	expect(await mode('local/tokens/calendar.md')).toBe(0o600);
});

test('the first write anywhere makes local/ with an ignore file for everything in it', async () => {
	const { dir, folder, read } = await tempFolder();
	await folder.write('data/a.md', 'a');
	expect(await read('local/.gitignore')).toBe('*\n');
	expect((await stat(join(dir, 'local'))).mode & 0o777).toBe(0o700);
});

test('a local/ that already exists is not given an ignore file', async () => {
	const { folder, read } = await tempFolder({ 'local/token.md': 'kept' });
	await folder.write('local/other.md', 'b');
	expect(await read('local/.gitignore')).toBeUndefined();
});

test('a write after local/ was removed makes it again, with its ignore file', async () => {
	const { dir, folder, read } = await tempFolder();
	await folder.write('data/a.md', 'a');
	await rm(join(dir, 'local'), { recursive: true });
	await folder.write('data/a.md', 'b');
	expect(await read('data/a.md')).toBe('b');
	expect(await read('local/.gitignore')).toBe('*\n');
});

test('a write under data/ keeps its temporary file in local/, and a failed write removes it', async () => {
	const { dir, folder, files } = await tempFolder();
	await folder.write('data/a.md', 'first');
	await folder.edit('data/a.md', (text) => Ok({ text: `${text} second` }));
	// A file cannot take the name of a directory, so this rename fails.
	await mkdir(join(dir, 'data/taken'));
	await expect(folder.write('data/taken', 'no')).rejects.toThrow();
	expect(await files('data')).toEqual(['data/a.md']);
	expect(await files('local')).toEqual(['local/.gitignore']);
	expect((await stat(join(dir, 'local/.tmp'))).mode & 0o777).toBe(0o700);
});

test('every write and delete outside data/ and local/ throws, and nothing is written', async () => {
	const { folder, files } = await tempFolder({ 'README.md': 'code' });
	const refused =
		'report.md is outside data/ and local/, and an action writes only there';
	await expect(folder.write('report.md', 'text')).rejects.toThrow(refused);
	await expect(folder.write('report.md', new Uint8Array([1]))).rejects.toThrow(
		refused,
	);
	await expect(
		folder.edit('report.md', () => Ok({ text: 'text' })),
	).rejects.toThrow(refused);
	await expect(folder.delete('report.md')).rejects.toThrow(refused);
	await expect(folder.write('locals/x.md', 'text')).rejects.toThrow(
		'locals/x.md is outside data/ and local/',
	);
	await expect(folder.delete('README.md')).rejects.toThrow(
		'README.md is outside data/ and local/',
	);
	expect(await files('')).toEqual(['README.md']);
});

test('a climbing, absolute or Git path throws on every call', async () => {
	const { folder } = await tempFolder();
	for (const path of ['../x', '/abs', '.git/config', 'data/../../x']) {
		await expect(folder.write(path, 'no')).rejects.toThrow();
		await expect(folder.edit(path, () => Ok({ text: 'no' }))).rejects.toThrow();
		await expect(folder.delete(path)).rejects.toThrow();
	}
});

test('normalizePath tidies a relative path and refuses one that leaves the folder', () => {
	expect(normalizePath('./a//b.md')).toBe('a/b.md');
	for (const path of [
		'',
		'/etc/passwd',
		'../x',
		'a/../../x',
		'.git/config',
		'a\\b',
	])
		expect(() => normalizePath(path)).toThrow();
});

test('edit creates a file from undefined and answers the value it returned', async () => {
	const { folder, read } = await tempFolder();
	const made = await folder.edit('data/2026.csv', (before = 'minutes\n') =>
		Ok({ text: `${before}30\n`, value: before }),
	);
	expect(expectOk(made)).toBe('minutes\n');
	expect(await read('data/2026.csv')).toBe('minutes\n30\n');
	expect(
		expectOk(
			await folder.edit('data/2026.csv', (before = '') =>
				Ok({ text: `${before}10\n` }),
			),
		),
	).toBeUndefined();
	expect(await read('data/2026.csv')).toBe('minutes\n30\n10\n');
});

test('edit that returns Ok({}) or an error writes nothing', async () => {
	const { dir, folder, read } = await tempFolder();
	await folder.write('data/same.txt', 'a\n');
	const before = await stat(join(dir, 'data/same.txt'));
	expect(expectOk(await folder.edit('data/same.txt', () => Ok({})))).toBe(
		undefined,
	);
	const refusal = expectErr(
		await folder.edit('data/same.txt', () =>
			Err({ name: 'Taken', message: 'no' }),
		),
	);
	expect(refusal).toEqual({ name: 'Taken', message: 'no' });
	expectOk(await folder.edit('data/absent.txt', () => Ok({})));
	expect(await read('data/absent.txt')).toBeUndefined();
	const after = await stat(join(dir, 'data/same.txt'));
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
});

test('edit whose text is what is there leaves the file untouched', async () => {
	const { dir, folder } = await tempFolder();
	await folder.write('data/same.txt', 'a\n');
	const before = await stat(join(dir, 'data/same.txt'));
	await folder.edit('data/same.txt', (text = '') => Ok({ text }));
	const after = await stat(join(dir, 'data/same.txt'));
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
});

test('edit changes a file that starts with a byte order mark, comparing what is there as bytes', async () => {
	const { dir, folder, read } = await tempFolder();
	await mkdir(join(dir, 'data'));
	await writeFile(join(dir, 'data/bom.txt'), '﻿a\n');
	await folder.edit('data/bom.txt', (text) => Ok({ text: `${text}b\n` }));
	expect(await read('data/bom.txt')).toBe('a\nb\n');
});

test('concurrent edits of one file each land, and leave nothing beside it', async () => {
	const { folder, read, files } = await tempFolder();
	await folder.write('data/log.txt', '');
	await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			folder.edit('data/log.txt', (text = '') => Ok({ text: `${text}${n}\n` })),
		),
	);
	const lines = (await read('data/log.txt'))?.trimEnd().split('\n');
	expect(lines?.sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
	expect(await files('data')).toEqual(['data/log.txt']);
});

test('concurrent edits of one data file each land, each computed from the record it replaces', async () => {
	const { dir, folder, read } = await tempFolder({
		'data/counters/a.md': '---\nn: 0\n---\n',
	});
	const { counters } = defineData(folder, {
		counters: { fields: { n: field.integer({ optional: true }) } },
	});
	await Promise.all(
		Array.from({ length: 5 }, () =>
			counters.edit('a', (record) => Ok({ n: (record?.n ?? 0) + 1 })),
		),
	);
	expect(await read('data/counters/a.md')).toBe('---\nn: 5\n---\n');
	expect((await readdir(join(dir, 'data/counters'))).sort()).toEqual(['a.md']);
});

test('edit runs its decision once and does not look at the file again', async () => {
	const { dir, folder, read } = await tempFolder({ 'data/once.txt': '0' });
	let runs = 0;
	await folder.edit('data/once.txt', () => {
		runs++;
		// A writer outside epicenter is not guarded against: the edit wins.
		writeFileSync(join(dir, 'data/once.txt'), 'outside');
		return Ok({ text: 'mine' });
	});
	expect(runs).toBe(1);
	expect(await read('data/once.txt')).toBe('mine');
});

test('edit whose decision throws writes nothing', async () => {
	const { folder, read } = await tempFolder({ 'data/kept.txt': 'kept' });
	await expect(
		folder.edit('data/kept.txt', () => {
			throw new Error('no change');
		}),
	).rejects.toThrow('no change');
	await expect(
		folder.edit('data/absent.txt', () => {
			throw new Error('no file');
		}),
	).rejects.toThrow('no file');
	expect(await read('data/kept.txt')).toBe('kept');
	expect(await read('data/absent.txt')).toBeUndefined();
});

test('a data edit forwards a returned Changed and lets a thrown Changed escape, including on an absent file', async () => {
	const { folder, read } = await tempFolder();
	const counter = defineData(folder, {
		'counter.md': { fields: { n: field.integer({ optional: true }) } },
	})['counter.md'];
	const path = 'data/counter.md';
	const refusal = ActionError.Changed({ path, cause: 'quote' });
	expect(await counter.edit(() => refusal)).toBe(refusal);
	const thrown = await counter
		.edit(() => {
			throw refusal.error;
		})
		.catch((cause: unknown) => cause);
	expect(thrown).toBe(refusal.error);
	expect(await read(path)).toBeUndefined();
});
