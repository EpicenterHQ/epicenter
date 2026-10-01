/**
 * File Browser Helper Tests
 *
 * What the browser lists from a folder listing, and which files open as
 * editable text. A file that is not editable text must never reach a text
 * editor, because saving decoded text would rewrite its bytes.
 *
 * Key behaviors:
 * - Folders list before files; only expanded folders show their children
 * - Empty folders the shell created are listed; `.git` never is
 * - Only UTF-8 without NUL bytes opens as text, and a byte order mark survives
 */
import { expect, test } from 'bun:test';
import { captureVersion, type FolderFiles } from '@epicenter/app/files';
import { Ok } from 'wellcrafted/result';
import { EDITABLE_TEXT_LIMIT, readTextFile, visibleRows } from './files.js';

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

function filesWith(bytes: Uint8Array) {
	return {
		async read() {
			return Ok({ bytes, version: await captureVersion(bytes) });
		},
	} as unknown as FolderFiles;
}

test('only UTF-8 text without NUL bytes opens for editing', async () => {
	const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
	const text = await readTextFile(filesWith(withBom), 'a.txt');
	expect(text.data?.kind).toBe('text');
	const source = text.data?.kind === 'text' ? text.data.file.source : '';
	expect(new TextEncoder().encode(source)).toEqual(withBom);

	const nul = await readTextFile(
		filesWith(new Uint8Array([0x68, 0, 0x69])),
		'a.bin',
	);
	expect(nul.data).toEqual({ kind: 'binary', size: 3 });

	const invalid = await readTextFile(
		filesWith(new Uint8Array([0xff, 0xfe, 0x41])),
		'b.bin',
	);
	expect(invalid.data).toEqual({ kind: 'binary', size: 3 });

	const large = new Uint8Array(EDITABLE_TEXT_LIMIT + 1).fill(0x61);
	const tooLarge = await readTextFile(filesWith(large), 'big.txt');
	expect(tooLarge.data).toEqual({
		kind: 'tooLarge',
		size: EDITABLE_TEXT_LIMIT + 1,
	});
});
