/**
 * Shared file-browser tests.
 *
 * Tree ordering, expanded directories, and text classification belong to the
 * folder package. Apps supply their editing limit; failed reads keep their
 * refusal, and editable text is the exact text of the file's bytes.
 *
 * Key behaviors:
 * - Folders precede files, only expanded descendants appear, and Git is hidden
 * - The byte limit includes its boundary, and BOM and CRLF survive decoding
 * - NUL bytes and invalid UTF-8 open as binary details
 * - Failed reads preserve their refusal, and an absent file is `undefined`
 */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { readTextFile, visibleRows } from './file-browser.js';
import { ReadError } from './shared/errors.js';

/** A folder's `files.read` that answers `bytes` for every path. */
const holding = (bytes: Uint8Array) => ({
	read: async (path: string) =>
		Ok({ path, content: new Blob([new Uint8Array(bytes)]) }),
});

test('the caller owns the exact byte limit, and editable text keeps BOM and CRLF', async () => {
	const bytes = new TextEncoder().encode('\ufeffhi\r\n');
	const files = holding(bytes);
	expect(
		expectOk(await readTextFile(files, 'note.txt', bytes.byteLength - 1)),
	).toEqual({
		kind: 'tooLarge',
		size: bytes.byteLength,
	});
	expect(
		expectOk(await readTextFile(files, 'note.txt', bytes.byteLength)),
	).toEqual({ kind: 'text', text: '\ufeffhi\r\n' });
});

test('a failed read preserves its refusal, and an absent file is undefined', async () => {
	const { error } = ReadError.StorageFailed({ cause: new Error('disk') });
	const failing = { read: async () => Err(error) };
	expect(await readTextFile(failing, 'note.txt', 10)).toEqual(Err(error));
	const absent = { read: async () => Ok(undefined) };
	expect(expectOk(await readTextFile(absent, 'missing.txt', 10))).toBe(
		undefined,
	);
});

const listing = {
	files: [
		{ path: 'todos/b.md', size: 20 },
		{ path: 'todos/a.md', size: 10 },
		{ path: 'notes/deep/x.txt', size: 3 },
		{ path: 'readme.txt', size: 5 },
		{ path: '.git/HEAD', size: 23 },
	],
	directories: ['empty', 'notes', 'notes/deep', 'todos', '.git'],
};

test('folders list before files, and only expanded folders show children', () => {
	const rows = visibleRows(listing, new Set(['todos']));
	expect(rows.map((row) => [row.path, row.depth])).toEqual([
		['empty', 0],
		['notes', 0],
		['todos', 0],
		['todos/a.md', 1],
		['todos/b.md', 1],
		['readme.txt', 0],
	]);
	expect(rows.find((row) => row.path === 'empty')).toMatchObject({
		kind: 'directory',
		children: 0,
	});
	expect(rows.find((row) => row.path === 'notes')).toMatchObject({
		children: 1,
	});

	const nested = visibleRows(listing, new Set(['notes', 'notes/deep']));
	expect(nested.map((row) => row.path)).toContain('notes/deep/x.txt');
	expect(nested.find((row) => row.path === 'notes/deep/x.txt')?.depth).toBe(2);
});

test('NUL bytes and invalid UTF-8 open as binary details', async () => {
	for (const bytes of [
		new Uint8Array([0x68, 0, 0x69]),
		new Uint8Array([0xff, 0xfe, 0x41]),
	]) {
		expect(expectOk(await readTextFile(holding(bytes), 'a.bin', 10))).toEqual({
			kind: 'binary',
			size: bytes.byteLength,
		});
	}
});
