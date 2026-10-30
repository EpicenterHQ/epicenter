/**
 * House Style Tests
 *
 * `formatNote` is the one house style every Epicenter writer applies
 * (decision 29). A regression here would make two writers disagree about a
 * note's bytes, which shows up as spurious diffs and merges.
 *
 * Key behaviors:
 * - The contract's keys come first in its order, other keys after them sorted
 * - Formatting is idempotent and reads back as the same document
 * - The body is kept byte for byte; a note with no front matter gains none
 * - Front matter that does not parse is refused, never rewritten
 *
 * See also:
 * - `canonical.test.ts` for the codec's refusals and source locations
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { formatNote, parseRowSource } from './index.js';

test('declared keys come first in declared order, then the rest sorted', () => {
	const text = '---\nzeta: 1\ntags: [a, b]\nalpha: x\ntitle: Hi\n---\nBody\n';
	expect(expectOk(formatNote(text, ['title', 'tags']))).toBe(
		'---\ntitle: Hi\ntags:\n  - a\n  - b\nalpha: x\nzeta: 1\n---\nBody\n',
	);
});

test('formatting is idempotent and reads back as the source document', () => {
	const sources = [
		'---\n# a comment\ntitle: "quoted"\ncount: 3\n---\n# Heading\n\nText.\n',
		'---\nnested: {b: 2, a: [1, {z: true}]}\nwhen: "2026-10-30"\n---\n',
		'---\nmulti: "line one\\nline two\\n"\nflag: "yes"\n---\nBody without newline',
		'---\r\ntitle: CRLF header\r\n---\r\nCRLF body\r\n',
	];
	for (const source of sources) {
		const once = expectOk(formatNote(source, ['title']));
		expect(expectOk(formatNote(once, ['title']))).toBe(once);
		expect(expectOk(parseRowSource(once)).document).toEqual(
			expectOk(parseRowSource(source)).document,
		);
	}
});

test('a note with no front matter is returned as its body', () => {
	expect(expectOk(formatNote('Just a body.\n', ['title']))).toBe(
		'Just a body.\n',
	);
	expect(expectOk(formatNote('﻿Body', []))).toBe('Body');
});

test('front matter that does not parse is refused with its line', () => {
	const error = expectErr(formatNote('---\ntitle: [unclosed\n---\n', []));
	expect(error.line).toBeGreaterThanOrEqual(2);
});
