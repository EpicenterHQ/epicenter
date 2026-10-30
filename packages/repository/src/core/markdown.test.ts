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
import { isMap, parseDocument } from 'yaml';
import { describe, expect, test } from 'bun:test';
import {
	BODY_SQL,
	bodyOf,
	formatMarkdown,
	headerOf,
	withBody,
	parseMarkdown,
	parsePointer,
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
		for (const text of [...samples, '---\na: [\n---\nB\n', '---\n- a\n---\n']) expect(query.get(text, null)?.body).toBe(bodyOf(text));
	});

	test('parse reads fields and body', () => {
		expect(parseMarkdown('---\ntitle: A\ntags: [x, y]\n---\nBody\n')).toEqual({
			fields: { title: 'A', tags: ['x', 'y'] },
			body: 'Body\n',
			hasFrontmatter: true,
			broken: [],
		});
		expect(parseMarkdown('just text')).toEqual({
			fields: {},
			body: 'just text',
			hasFrontmatter: false,
			broken: [],
		});
		expect(parseMarkdown('---\n---\nB').fields).toEqual({});
	});

	test('position decides the header; a broken key costs only that key', () => {
		for (const [text, body, broken] of <[string, string, string[]][]>[
			['---\na: [\n---\nB\n', 'B\n', ['a']],
			['---\na: 1\na: 2\n---\n', '', ['a']],
			['---\na: {b\n---', '', ['a']],
			['---\na: *missing\n---\nB\n', 'B\n', ['a']],
		])
			expect(parseMarkdown(text)).toEqual({ fields: {}, body, hasFrontmatter: true, broken });
		// A header with no key lines has no keys.
		expect(parseMarkdown('---\n- a\n- b\n---\n')).toEqual({ fields: {}, body: '', hasFrontmatter: true, broken: [] });
		expect(bodyOf('---\na: [\n---\nB\n')).toBe('B\n');
		expect(headerOf('---\na: [\n---\nB\n')).toBe('---\na: [\n---\n');
	});

	test('a broken title still yields done and tags', () => {
		expect(parseMarkdown('---\ntitle: "open\ndone: true\ntags:\n  - a\n  - b\n---\nB\n')).toEqual({ fields: { done: true, tags: ['a', 'b'] }, body: 'B\n', hasFrontmatter: true, broken: ['title'] });
	});

	test('with no closing fence there is no header: the whole text is body', () => {
		expect(parseMarkdown('---\ntitle: a\nbody\n')).toEqual({ fields: {}, body: '---\ntitle: a\nbody\n', hasFrontmatter: false, broken: [] });
	});

	test("an editor's body keeps a header that does not parse, byte for byte", () => {
		expect(withBody('---\na: [\n---\nB\n', 'C\n')).toBe('---\na: [\n---\nC\n');
		expect(writeMarkdown('---\na: [\n---\nB\n', { body: 'C\n' })).toBe('---\na: [\n---\nC\n');
	});

	test('a patch on a header that does not parse edits its lines: the broken line stays as typed, and the key gets its line', () => {
		const broken = '---\na: [\ntitle: x\n---\nB\n';
		expect(writeMarkdown(broken, { fields: { title: 'y' } })).toBe('---\na: [\ntitle: y\n---\nB\n');
		expect(writeMarkdown(broken, { fields: { done: true } })).toBe('---\na: [\ntitle: x\ndone: true\n---\nB\n');
		// A value over several lines is replaced whole, up to the next top-level line.
		expect(writeMarkdown('---\na: [\ntags:\n  - a\n- b\ntitle: x\n---\nB\n', { fields: { tags: ['c'] } })).toBe('---\na: [\ntags:\n  - c\ntitle: x\n---\nB\n');
		// A note with no fences gets a new header.
		expect(writeMarkdown('B\n', { fields: { done: true } })).toBe('---\ndone: true\n---\nB\n');
	});

	test('two patches of one key on a header that does not parse never duplicate it', () => {
		const once = writeMarkdown('---\na: [\n---\nB\n', { fields: { done: true } });
		expect(writeMarkdown(once, { fields: { done: false } })).toBe('---\na: [\ndone: false\n---\nB\n');
	});

	test('a delete on a header that does not parse removes the key\'s lines, and only them', () => {
		expect(writeMarkdown('---\na: [\ntags:\n  - a\n  - b\ntitle: x\n---\nB\n', { fields: { tags: undefined } })).toBe('---\na: [\ntitle: x\n---\nB\n');
	});
});

describe('key blocks', () => {
	test("a header splits by position, never by yaml's error recovery: a broken line is its own key", () => {
		// Read whole, yaml folds these into one key; split by position, each line is its own.
		expect(parseMarkdown('---\ntitle: "Pasta\ndone: true\ntags: [dinner]\n---\n')).toMatchObject({ fields: { done: true, tags: ['dinner'] }, broken: ['title'] });
		expect(parseMarkdown('---\ntitle: x\n  bad: y\ndone: true\n---\n')).toMatchObject({ fields: { done: true }, broken: ['title'] });
		// A line with no key is an issue on the whole line; a key twice is an issue on that key.
		expect(parseMarkdown('---\noops\na: 1\na: 2\nb: 2\n---\n')).toMatchObject({ fields: { b: 2 }, broken: ['oops', 'a'] });
		// A quoted key is one key, broken or not.
		expect(parseMarkdown('---\n"a: b": [\n---\n').broken).toEqual(['a: b']);
		// A key that refers to another key's anchor is an issue (accepted).
		expect(parseMarkdown('---\na: &x 1\nb: *x\n---\n')).toMatchObject({ fields: { a: 1 }, broken: ['b'] });
	});

	test('wherever a header parses whole as a map with no aliases across keys, its key blocks read the same fields', () => {
		let state = 0x2545f491;
		const next = () => {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			return (state >>> 0) / 2 ** 32;
		};
		const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
		const KEYS = ['title', 'done', '"a b"', "'it''s'", 'url', 'k-1', 'tags'];
		const VALUES = [
			' x\n', ' 1\n', ' true\n', ' null\n', '\n', ' "a: b"\n', " 'q'\n", ' http://x.y/z\n', ' [a, b]\n', ' [\n  a,\n  b\n  ]\n', ' {a: 1}\n',
			' |\n  line one\n\n  line two\n', ' >-\n  folded\n  text\n', '\n  - a\n  - b\n', '\n- a\n- b\n', '\n  nested: 1\n  deep:\n    - x\n', ' x # trailing\n', ' ---\n', " '#'\n",
		];
		let checked = 0;
		for (let k = 0; k < 5_000; k++) {
			const keys = [...new Set(Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(KEYS)))];
			const yaml = keys.map((key) => `${next() < 0.2 ? '# about it\n' : ''}${key}:${pick(VALUES)}${next() < 0.1 ? '\n' : ''}`).join('') + (next() < 0.1 ? '# at the end\n' : '');
			const whole = parseDocument(yaml, { uniqueKeys: true });
			if (whole.errors.length > 0 || !isMap(whole.contents)) continue;
			checked++;
			expect(parseMarkdown(`---\n${yaml}---\n`)).toMatchObject({ fields: whole.toJS(), broken: [] });
		}
		// And over the merge fuzz's headers: every header the generator writes.
		for (let k = 0; k < 2_000; k++) {
			const fields = Object.fromEntries(KEYS.filter(() => next() < 0.5).map((key) => [key, pick([1, 'two', [1, 2], { n: 1 }, null, 'a: b', '---', '#x', 'line\nbreak'])]));
			const text = writeMarkdown(null, { fields });
			expect(parseMarkdown(text)).toMatchObject({ fields, broken: [] });
		}
		expect(checked).toBeGreaterThan(2_000);
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
		expect(out).toBe(source.replace("mood: 'ok'\n", "mood: 'ok'\ndue: 2026-11-01\n"));
		expect(parseMarkdown(out).fields.due).toBe('2026-11-01');
	});

	test('a removed key disappears with its block: its lines, its trailing comment and the comment lines above it', () => {
		const out = writeMarkdown(source, { fields: { title: undefined } });
		expect(out).toBe(source.replace('# who owns this\ntitle:   "Hello"   # keep me\n', ''));
	});

	test('the body changes without touching the frontmatter', () => {
		const out = writeMarkdown(source, { body: 'New\n' });
		expect(out).toBe(source.replace('Body text\n', 'New\n'));
	});

	test('fields on a file without frontmatter add a header', () => {
		expect(writeMarkdown('Body\n', { fields: { a: 1 } })).toBe('---\na: 1\n---\nBody\n');
		expect(writeMarkdown(null, { fields: { a: 1 }, body: 'B' })).toBe('---\na: 1\n---\nB');
	});

	test('a body that looks like frontmatter is guarded on a header-less file', () => {
		const out = writeMarkdown('x', { body: '---\na: 1\n---\n' });
		expect(parseMarkdown(out).body).toBe('---\na: 1\n---\n');
	});

	test('a closing fence at the end is closed as house style closes it, and a body after it starts on a line of its own', () => {
		expect(writeMarkdown('---\na: 1\n---', { fields: { a: 2 } })).toBe('---\na: 2\n---\n');
		expect(writeMarkdown('---\na: 1\n---', { body: 'B' })).toBe('---\na: 1\n---\nB');
	});

	test('a key needing quotes is written so it reads back', () => {
		const out = writeMarkdown('---\na: 1\n---\n', { fields: { 'b: c': 'd: e' } });
		expect(parseMarkdown(out).fields).toEqual({ a: 1, 'b: c': 'd: e' });
	});

	test('a field set on a header that does not parse replaces its own line, which can repair it; the body stays', () => {
		const out = writeMarkdown('---\na: [\n---\nB\n', { fields: { a: 1 } });
		expect(out).toBe('---\na: 1\n---\nB\n');
		expect(parseMarkdown(out)).toEqual({ fields: { a: 1 }, body: 'B\n', hasFrontmatter: true, broken: [] });
	});

	test('a body typed after a header that does not parse reads back as typed', () => {
		const broken = '---\na: [\n---\nB\n';
		for (const body of ['---\na: [\n---\nC\n', 'plain\n', '---\na: 1\n---\nlooks like frontmatter\n'])
			expect(bodyOf(withBody(broken, body))).toBe(body);
	});
});

describe('house style', () => {
	test('a broken key is left exactly as typed, and every key that parses is printed in house style', () => {
		expect(formatMarkdown('---\ntitle: "open   \ntags: [a,  b]   # kept\n---\nB\n')).toBe('---\ntitle: "open   \ntags: [a, b] # kept\n---\nB\n');
	});

	test('the frontmatter is printed one way, comments, quoting and key order kept; the body is never touched', () => {
		const text = '---\n# who\ntitle:   "Hello"   # keep me\ntags: [a,  b]\nlist:\n    - a\n    - b\n---\nBody  \n\n  indented\n';
		expect(formatMarkdown(text)).toBe('---\n# who\ntitle: "Hello" # keep me\ntags: [a, b]\nlist:\n  - a\n  - b\n---\nBody  \n\n  indented\n');
		expect(formatMarkdown('---\n---\nB')).toBe('---\n---\nB');
		expect(formatMarkdown('---\na: 1\n---')).toBe('---\na: 1\n---\n');
	});

	test('a text with no parseable frontmatter is left as it is', () => {
		for (const text of ['plain\n', '---\na: [\n---\nB\n', '', '---\nno close\n']) expect(formatMarkdown(text)).toBe(text);
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
		expect(text).toBe(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12\n`);
		expect(parsePointer(text)).toEqual({ oid, size: 12 });
	});

	test('text that is not exactly a pointer is not one', () => {
		expect(parsePointer('hello')).toBeNull();
		expect(parsePointer(writePointer({ oid, size: 1 }).trimEnd())).toBeNull();
		expect(parsePointer(writePointer({ oid: 'z'.repeat(64), size: 1 }))).toBeNull();
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
		expect(next.slice(0, next.length - body.length).startsWith(text.slice(0, text.length - bodyOf(text).length))).toBe(true);
	}
});
