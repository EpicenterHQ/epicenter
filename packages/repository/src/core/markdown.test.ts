/**
 * Markdown Codec Tests
 *
 * A file keeps the formatting its writer gave it; only the edited span
 * changes. These tests pin the frontmatter split (shared with the SQL body
 * column), refusal of unparseable frontmatter, in-place field edits, and the
 * LFS pointer format.
 *
 * Key behaviors:
 * - The JS split and `BODY_SQL` agree on every sample
 * - Changing one field leaves other keys, comments and quoting byte-identical
 * - New keys append; removed keys disappear with their lines
 * - Pointers parse strictly and round-trip
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	BODY_SQL,
	parseMarkdown,
	parsePointer,
	splitMarkdown,
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
		const query = db.query<{ body: string }, [string]>(
			`SELECT ${BODY_SQL} AS body FROM (SELECT ? AS text)`,
		);
		for (const text of samples)
			expect(query.get(text)?.body).toBe(text.slice(splitMarkdown(text).bodyStart));
	});

	test('parse reads fields and body', () => {
		expect(expectOk(parseMarkdown('---\ntitle: A\ntags: [x, y]\n---\nBody\n'))).toEqual({
			fields: { title: 'A', tags: ['x', 'y'] },
			body: 'Body\n',
			hasFrontmatter: true,
		});
		expect(expectOk(parseMarkdown('just text'))).toEqual({
			fields: {},
			body: 'just text',
			hasFrontmatter: false,
		});
		expect(expectOk(parseMarkdown('---\n---\nB')).fields).toEqual({});
	});

	test('unparseable frontmatter is refused', () => {
		expect(expectErr(parseMarkdown('---\na: [\n---\n')).name).toBe('Unparseable');
		expect(expectErr(parseMarkdown('---\n- a\n- b\n---\n')).name).toBe('Unparseable');
		expect(expectErr(parseMarkdown('---\na: 1\na: 2\n---\n')).name).toBe('Unparseable');
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
		const out = expectOk(writeMarkdown(source, { fields: { mood: 'great' } }));
		expect(out).toBe(source.replace("mood: 'ok'", 'mood: great'));
	});

	test('changing a block value replaces only that pair', () => {
		const out = expectOk(writeMarkdown(source, { fields: { tags: ['c'] } }));
		expect(out).toBe(source.replace('tags:\n  - a\n  - b\n', 'tags:\n  - c\n'));
	});

	test('an unchanged value is not rewritten', () => {
		expect(expectOk(writeMarkdown(source, { fields: { title: 'Hello' } }))).toBe(source);
	});

	test('a new key is appended after the existing ones', () => {
		const out = expectOk(writeMarkdown(source, { fields: { due: '2026-11-01' } }));
		expect(out).toBe(source.replace("mood: 'ok'\n", "mood: 'ok'\ndue: 2026-11-01\n"));
		expect(expectOk(parseMarkdown(out)).fields.due).toBe('2026-11-01');
	});

	test('a removed key disappears with its line and trailing comment', () => {
		const out = expectOk(writeMarkdown(source, { fields: { title: undefined } }));
		expect(out).toBe(source.replace('title:   "Hello"   # keep me\n', ''));
	});

	test('the body changes without touching the frontmatter', () => {
		const out = expectOk(writeMarkdown(source, { body: 'New\n' }));
		expect(out).toBe(source.replace('Body text\n', 'New\n'));
	});

	test('fields on a file without frontmatter add a header', () => {
		expect(expectOk(writeMarkdown('Body\n', { fields: { a: 1 } }))).toBe('---\na: 1\n---\nBody\n');
		expect(expectOk(writeMarkdown(null, { fields: { a: 1 }, body: 'B' }))).toBe('---\na: 1\n---\nB');
	});

	test('a body that looks like frontmatter is guarded on a header-less file', () => {
		const out = expectOk(writeMarkdown('x', { body: '---\na: 1\n---\n' }));
		expect(expectOk(parseMarkdown(out)).body).toBe('---\na: 1\n---\n');
	});

	test('a closing fence at the end stays bare', () => {
		expect(expectOk(writeMarkdown('---\na: 1\n---', { fields: { a: 2 } }))).toBe('---\na: 2\n---');
		expect(expectOk(writeMarkdown('---\na: 1\n---', { body: 'B' }))).toBe('---\na: 1\n---\nB');
	});

	test('a key needing quotes is written so it reads back', () => {
		const out = expectOk(writeMarkdown('---\na: 1\n---\n', { fields: { 'b: c': 'd: e' } }));
		expect(expectOk(parseMarkdown(out)).fields).toEqual({ a: 1, 'b: c': 'd: e' });
	});

	test('a write over unparseable frontmatter is refused', () => {
		expect(expectErr(writeMarkdown('---\na: [\n---\n', { fields: { a: 1 } })).name).toBe(
			'Unparseable',
		);
	});
});

describe('LFS pointers', () => {
	const oid = 'a'.repeat(64);

	test('a pointer round-trips', () => {
		const text = writePointer({ oid, size: 12 });
		expect(text).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`);
		expect(parsePointer(text)).toEqual({ oid, size: 12 });
	});

	test('text that is not exactly a pointer is not one', () => {
		expect(parsePointer('hello')).toBeNull();
		expect(parsePointer(writePointer({ oid, size: 1 }).trimEnd())).toBeNull();
		expect(parsePointer(writePointer({ oid: 'z'.repeat(64), size: 1 }))).toBeNull();
	});
});
