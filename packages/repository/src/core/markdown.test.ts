/**
 * Markdown Codec Tests
 *
 * A file keeps the formatting its writer gave it; only the edited span
 * changes. These tests pin the frontmatter split (shared with the SQL body
 * column), a note whose frontmatter does not parse (no fields, its whole
 * text the body), in-place field edits, and the
 * LFS pointer format.
 *
 * Key behaviors:
 * - The JS split and `BODY_SQL` agree on every sample
 * - Changing one field leaves other keys, comments and quoting byte-identical
 * - New keys append; removed keys disappear with their lines
 * - Pointers parse strictly and round-trip
 * - Replacing a body keeps the frontmatter byte for byte
 * - A text that does not open with parseable frontmatter has no fields, and its whole text is the body
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
	BODY_SQL,
	bodyOf,
	formatMarkdown,
	parseMarkdown,
	parsePointer,
	withBody,
	writeMarkdown,
	writePointer,
} from './markdown.js';

const samples = [
	'',
	'plain body\n',
	'---\n---\n',
	'---\n---\nbody',
	'---\ntitle: A\n---\nBody\n',
	'---\ntitle: A\n---',
	'---\ntitle: A\n---\n',
	'---\ntitle: A\nno close\n',
	'---\na: 1\n---\n---\nlooks like a fence\n',
	'--- \nnot frontmatter\n---\n',
	'---\n\n---\n\nbody after blank\n',
	'---\nx: "---"\n---\nå 中文 body\n',
];

describe('split', () => {
	test('the JS split and BODY_SQL agree', () => {
		const db = new Database(':memory:');
		const query = db.query<{ body: string }, [string, string | null]>(
			`SELECT ${BODY_SQL} AS body FROM (SELECT ?1 AS text, ?2 AS fields)`,
		);
		// The replica stores `fields` only for a text with frontmatter (`fieldsOf`).
		for (const text of [...samples, '---\na: [\n---\nB\n', '---\n- a\n---\n'])
			expect(
				query.get(text, parseMarkdown(text).hasFrontmatter ? '{}' : null)?.body,
			).toBe(bodyOf(text));
	});

	test('parse reads fields and body', () => {
		expect(parseMarkdown('---\ntitle: A\ntags: [x, y]\n---\nBody\n')).toEqual({
			fields: { title: 'A', tags: ['x', 'y'] },
			body: 'Body\n',
			hasFrontmatter: true,
		});
		expect(parseMarkdown('just text')).toEqual({
			fields: {},
			body: 'just text',
			hasFrontmatter: false,
		});
		expect(parseMarkdown('---\n---\nB').fields).toEqual({});
	});

	test('a text that does not open with parseable frontmatter is a note with no fields, its whole text the body', () => {
		for (const text of [
			'---\na: [\n---\nB\n',
			'---\n- a\n- b\n---\n',
			'---\na: 1\na: 2\n---\n',
			'---\na: {b\n---',
			'---\na: *missing\n---\nB\n',
		])
			expect(parseMarkdown(text)).toEqual({
				fields: {},
				body: text,
				hasFrontmatter: false,
			});
		expect(bodyOf('---\na: [\n---\nB\n')).toBe('---\na: [\n---\nB\n');
	});
});

describe('write', () => {
	const source = [
		'---',
		'# who owns this',
		'title:   "Hello"   # keep me',
		'tags:',
		'  - a',
		'  - b',
		"mood: 'ok'",
		'---',
		'Body text\n',
	].join('\n');

	test('changing one field leaves every other byte alone', () => {
		const out = writeMarkdown(source, { fields: { mood: 'great' } });
		expect(out).toBe(source.replace("mood: 'ok'", 'mood: great'));
	});

	test('changing a block value replaces only that pair', () => {
		const out = writeMarkdown(source, { fields: { tags: ['c'] } });
		expect(out).toBe(source.replace('tags:\n  - a\n  - b\n', 'tags:\n  - c\n'));
	});

	test('an unchanged value is not rewritten', () => {
		expect(writeMarkdown(source, { fields: { title: 'Hello' } })).toBe(source);
	});

	test('a new key is appended after the existing ones', () => {
		const out = writeMarkdown(source, { fields: { due: '2026-11-01' } });
		expect(out).toBe(
			source.replace("mood: 'ok'\n", "mood: 'ok'\ndue: 2026-11-01\n"),
		);
		expect(parseMarkdown(out).fields.due).toBe('2026-11-01');
	});

	test('a removed key disappears with its line and trailing comment', () => {
		const out = writeMarkdown(source, { fields: { title: undefined } });
		expect(out).toBe(source.replace('title:   "Hello"   # keep me\n', ''));
	});

	test('the body changes without touching the frontmatter', () => {
		const out = writeMarkdown(source, { body: 'New\n' });
		expect(out).toBe(source.replace('Body text\n', 'New\n'));
	});

	test('fields on a file without frontmatter add a header', () => {
		expect(writeMarkdown('Body\n', { fields: { a: 1 } })).toBe(
			'---\na: 1\n---\nBody\n',
		);
		expect(writeMarkdown(null, { fields: { a: 1 }, body: 'B' })).toBe(
			'---\na: 1\n---\nB',
		);
	});

	test('a body that looks like frontmatter is guarded on a header-less file', () => {
		const out = writeMarkdown('x', { body: '---\na: 1\n---\n' });
		expect(parseMarkdown(out).body).toBe('---\na: 1\n---\n');
	});

	test('a closing fence at the end stays bare', () => {
		expect(writeMarkdown('---\na: 1\n---', { fields: { a: 2 } })).toBe(
			'---\na: 2\n---',
		);
		expect(writeMarkdown('---\na: 1\n---', { body: 'B' })).toBe(
			'---\na: 1\n---\nB',
		);
	});

	test('a key needing quotes is written so it reads back', () => {
		const out = writeMarkdown('---\na: 1\n---\n', {
			fields: { 'b: c': 'd: e' },
		});
		expect(parseMarkdown(out).fields).toEqual({ a: 1, 'b: c': 'd: e' });
	});

	test('fields set on a note whose frontmatter does not parse go in a new header, and its text stays the body', () => {
		const broken = '---\na: [\n---\nB\n';
		const out = writeMarkdown(broken, { fields: { a: 1 } });
		expect(out).toBe(`---\na: 1\n---\n${broken}`);
		expect(parseMarkdown(out)).toEqual({
			fields: { a: 1 },
			body: broken,
			hasFrontmatter: true,
		});
	});

	test('a body typed over a note whose frontmatter does not parse is the whole text, and reads back as typed', () => {
		const broken = '---\na: [\n---\nB\n';
		for (const body of [
			'---\na: [\n---\nC\n',
			'plain\n',
			'---\na: 1\n---\nlooks like frontmatter\n',
		])
			expect(bodyOf(withBody(broken, body))).toBe(body);
	});
});

describe('house style', () => {
	test('the frontmatter is printed one way, comments, quoting and key order kept; the body is never touched', () => {
		const text =
			'---\n# who\ntitle:   "Hello"   # keep me\ntags: [a,  b]\nlist:\n    - a\n    - b\n---\nBody  \n\n  indented\n';
		expect(formatMarkdown(text)).toBe(
			'---\n# who\ntitle: "Hello" # keep me\ntags: [a, b]\nlist:\n  - a\n  - b\n---\nBody  \n\n  indented\n',
		);
		expect(formatMarkdown('---\n---\nB')).toBe('---\n---\nB');
		expect(formatMarkdown('---\na: 1\n---')).toBe('---\na: 1\n---\n');
	});

	test('a text with no parseable frontmatter is left as it is', () => {
		for (const text of [
			'plain\n',
			'---\na: [\n---\nB\n',
			'',
			'---\nno close\n',
		])
			expect(formatMarkdown(text)).toBe(text);
	});

	test('it is idempotent, and a formatted text reads the same fields and body', () => {
		for (const text of samples) {
			const once = formatMarkdown(text);
			expect(formatMarkdown(once)).toBe(once);
			expect(parseMarkdown(once).fields).toEqual(parseMarkdown(text).fields);
			expect(bodyOf(once)).toBe(bodyOf(text));
		}
	});
});

describe('LFS pointers', () => {
	const oid = 'a'.repeat(64);

	test('a pointer round-trips', () => {
		const text = writePointer({ oid, size: 12 });
		expect(text).toBe(
			`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`,
		);
		expect(parsePointer(text)).toEqual({ oid, size: 12 });
	});

	test('text that is not exactly a pointer is not one', () => {
		expect(parsePointer('hello')).toBeNull();
		expect(parsePointer(writePointer({ oid, size: 1 }).trimEnd())).toBeNull();
		expect(
			parsePointer(writePointer({ oid: 'z'.repeat(64), size: 1 })),
		).toBeNull();
	});
});

test('replacing a body keeps the frontmatter byte for byte, parsing or not, and the body reads back', () => {
	const cases = [
		['---\ntitle: A # kept\n---\none\n', 'two\n'],
		['---\ntitle: A\ntitle: B\n---\none\n', 'two\n'],
		['---\ntitle: A\n---', 'two\n'],
		['no frontmatter\n', '---\na: 1\n---\nlooks like frontmatter\n'],
		['---\ntitle: A\n---\none\n', ''],
	] as const;
	for (const [text, body] of cases) {
		const next = withBody(text, body);
		expect(bodyOf(next)).toBe(body);
		expect(
			next
				.slice(0, next.length - body.length)
				.startsWith(text.slice(0, text.length - bodyOf(text).length)),
		).toBe(true);
	}
});
