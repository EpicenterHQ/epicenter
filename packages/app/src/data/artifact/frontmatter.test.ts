import { describe, expect, test } from 'bun:test';

import { editField } from '@epicenter/matter-core/serialize';
import { frontmatter, parseRowFile, rowFile } from './frontmatter.js';

describe('frontmatter (ADR-0268)', () => {
	test('strings that YAML would reinterpret bare stay quoted strings', () => {
		// The exact values YAML famously mangles: bare `no` is a boolean, bare
		// `007` a number, a bare date a timestamp. Quoting every string is what
		// makes the artifact lossy of history and never of a value.
		expect(
			frontmatter({
				country: 'no',
				code: '007',
				day: '2024-03-05',
			}),
		).toBe(
			['---', 'code: "007"', 'country: "no"', 'day: "2024-03-05"', '---'].join(
				'\n',
			),
		);
	});

	test('every JSON shape emits exactly and deterministically', () => {
		expect(
			frontmatter({
				pinned: true,
				count: 3,
				folderId: null,
				tags: ['a', 'b'],
				meta: { nested: 'x' },
				tricky: 'line\nbreak "quoted"',
			}),
		).toBe(
			[
				'---',
				'count: 3',
				'folderId: null',
				'meta: {"nested":"x"}',
				'pinned: true',
				'tags: ["a","b"]',
				'tricky: "line\\nbreak \\"quoted\\""',
				'---',
			].join('\n'),
		);
	});

	test('a key outside the field grammar is quoted, not trusted bare', () => {
		expect(frontmatter({ 'weird: key': 1 })).toBe(
			['---', '"weird: key": 1', '---'].join('\n'),
		);
	});

	test('a row without a body is the block alone, a row with one separates it', () => {
		expect(rowFile({}, undefined)).toBe('---\n---\n');
		expect(rowFile({ a: 1 }, 'body text')).toBe(
			'---\na: 1\n---\n\nbody text\n',
		);
	});
});

test('a Matter title edit preserves every other artifact value and its body', () => {
	const fields = {
		title: 'Before',
		transcript: 'First line\nSecond line: detail\n',
		code: '007',
		flag: 'true',
		empty: 'null',
		at: '2026-09-21T10:00:00Z',
		nullable: null,
		metadata: { nested: ['a', 2, false] },
	};
	const original = rowFile(fields, 'Body stays here.');
	const edited = editField(original, 'title', 'After');
	expect(parseRowFile(edited)).toEqual({
		fields: { ...fields, title: 'After' },
		body: 'Body stays here.',
	});
	expect(parseRowFile(editField(original, 'title', 'Before'))).toEqual(
		parseRowFile(original),
	);
});

test('malformed and non-JSON frontmatter never becomes a partial artifact', () => {
	for (const yaml of [
		'title: [broken',
		'title: a\ntitle: b',
		'value: .nan',
		'value: .inf',
		'value: &self [*self]',
		'value: !unsupported x',
	]) {
		expect(parseRowFile(`---\n${yaml}\n---\n`)).toBeUndefined();
	}
	expect(parseRowFile('---\ntitle: x')).toBeUndefined();
	expect(parseRowFile('body only')).toBeUndefined();
});

test('general YAML values and artifact framing share one interpretation', () => {
	expect(
		parseRowFile("---\r\ntitle: 'A: title'\r\nempty:\r\n---\r\n\r\nBody\r\n"),
	).toEqual({ fields: { title: 'A: title', empty: null }, body: 'Body' });
	expect(parseRowFile('---\n---\n')).toEqual({ fields: {}, body: '' });
});

test('Unicode separators in field values cannot terminate frontmatter', () => {
	const title = 'a\u2028---\u2029b';
	expect(parseRowFile(rowFile({ title }, 'body'))).toEqual({
		fields: { title },
		body: 'body',
	});
	expect(parseRowFile('---\nnotes: |\n  foo\u2028---\u2028bar\n---\n')).toEqual(
		{ fields: { notes: 'foo\u2028---\u2028bar\n' }, body: '' },
	);
});
