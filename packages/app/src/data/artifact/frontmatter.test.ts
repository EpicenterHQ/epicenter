import { describe, expect, test } from 'bun:test';

import { frontmatter, rowFile } from './frontmatter.js';

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
