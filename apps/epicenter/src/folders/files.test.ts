/**
 * Folder File Tests
 *
 * How the Folders window shows a folder's files and which files it edits as
 * text.
 *
 * Key behaviors:
 * - The tree shows every directory a file is below, expanded, directories
 *   before files, each by name
 * - UTF-8 text is editable; a byte-order mark stays in the text
 * - `\r\n` files are edited as `\n` text and saved with `\r\n` again
 * - Mixed line endings and binary files are not edited
 */
import { describe, expect, test } from 'bun:test';
import { fileText, fileTree, savedText } from './files';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('fileTree', () => {
	test('directories come before files at each level, by name', () => {
		expect(
			fileTree([
				'epicenter.json',
				'notes/b.md',
				'notes/a.md',
				'notes/2026/x.md',
				'README.md',
			]).map(({ kind, path, depth }) => [kind, path, depth]),
		).toEqual([
			['directory', 'notes', 0],
			['directory', 'notes/2026', 1],
			['file', 'notes/2026/x.md', 2],
			['file', 'notes/a.md', 1],
			['file', 'notes/b.md', 1],
			['file', 'epicenter.json', 0],
			['file', 'README.md', 0],
		]);
	});

	test('names sort numerically', () => {
		expect(fileTree(['10.md', '9.md', '1.md']).map((row) => row.name)).toEqual([
			'1.md',
			'9.md',
			'10.md',
		]);
	});

	test('a deep file adds each directory above it once', () => {
		expect(fileTree(['a/b/c/d.md', 'a/b/e.md']).map((row) => row.path)).toEqual(
			['a', 'a/b', 'a/b/c', 'a/b/c/d.md', 'a/b/e.md'],
		);
	});

	test('an empty folder shows nothing', () => {
		expect(fileTree([])).toEqual([]);
	});
});

describe('fileText', () => {
	test('UTF-8 text is editable as it is', () => {
		expect(fileText(bytes('---\ntitle: A\n---\nBody\n'))).toEqual({
			kind: 'text',
			text: '---\ntitle: A\n---\nBody\n',
			crlf: false,
		});
	});

	test('a byte-order mark stays in the text, so saving keeps it', () => {
		const read = fileText(bytes('﻿hello'));
		expect(read).toEqual({ kind: 'text', text: '﻿hello', crlf: false });
		if (read.kind !== 'text') throw new Error('not text');
		expect(bytes(savedText(read.text, read.crlf))).toEqual(bytes('﻿hello'));
	});

	test('\\r\\n files edit as \\n text and save with \\r\\n', () => {
		const read = fileText(bytes('a\r\nb\r\n'));
		expect(read).toEqual({ kind: 'text', text: 'a\nb\n', crlf: true });
		expect(savedText('a\nb\nc\n', true)).toBe('a\r\nb\r\nc\r\n');
	});

	test('mixed line endings are shown, not edited', () => {
		expect(fileText(bytes('a\r\nb\n')).kind).toBe('mixed');
		expect(fileText(bytes('a\rb')).kind).toBe('mixed');
	});

	test('bytes that are not UTF-8, or hold NUL, are not text', () => {
		expect(fileText(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({
			kind: 'binary',
			size: 3,
		});
		expect(fileText(bytes('a\0b'))).toEqual({ kind: 'binary', size: 3 });
	});
});
