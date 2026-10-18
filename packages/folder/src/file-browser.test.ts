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
 * - Failed reads preserve their refusal
 */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { FileError } from './errors.js';
import { readTextFile, visibleRows } from './file-browser.js';

test('the caller owns the exact byte limit, and editable text keeps BOM and CRLF', async () => {
	const bytes = new TextEncoder().encode('\ufeffhi\r\n');
	const files = {
		read: async () => Ok({ bytes, sha256: 'read' }),
	};
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

test('a failed read preserves its refusal instead of classifying an absent file', async () => {
	const { error } = FileError.NotFound({ path: 'missing.txt' });
	const files = { read: async () => Err(error) };
	expect(await readTextFile(files, 'missing.txt', 10)).toEqual(Err(error));
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
		const files = {
			read: async () => Ok({ bytes, sha256: 'read' }),
		};
		expect(expectOk(await readTextFile(files, 'a.bin', 10))).toEqual({
			kind: 'binary',
			size: bytes.byteLength,
		});
	}
});
