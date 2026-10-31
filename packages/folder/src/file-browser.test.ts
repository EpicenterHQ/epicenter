/**
 * Shared file-browser tests.
 *
 * Text classification belongs to the folder package. Apps supply their
 * editing limit, and editable text is the exact text of the file's bytes.
 *
 * Key behaviors:
 * - The byte limit includes its boundary, and BOM and CRLF survive decoding
 * - NUL bytes and invalid UTF-8 open as binary details
 */
import { expect, test } from 'bun:test';
import { openedFile } from './file-browser.js';

test('the caller owns the exact byte limit, and editable text keeps BOM and CRLF', () => {
	const bytes = new TextEncoder().encode('\ufeffhi\r\n');
	expect(openedFile(bytes, bytes.byteLength - 1)).toEqual({
		kind: 'tooLarge',
		size: bytes.byteLength,
	});
	expect(openedFile(bytes, bytes.byteLength)).toEqual({
		kind: 'text',
		text: '\ufeffhi\r\n',
	});
});

test('NUL bytes and invalid UTF-8 open as binary details', () => {
	for (const bytes of [
		new Uint8Array([0x68, 0, 0x69]),
		new Uint8Array([0xff, 0xfe, 0x41]),
	]) {
		expect(openedFile(bytes, 10)).toEqual({
			kind: 'binary',
			size: bytes.byteLength,
		});
	}
});
