/**
 * Door Tests
 *
 * `admissible` is the one predicate the device, the server and an Action run,
 * so what it refuses is never shared and what it admits is cheap to read.
 * These pin the refusals a person can meet, the frontmatter parse-cost bound
 * against spike 3's pathological notes, and the conflict-block grammar.
 *
 * Key behaviors:
 * - notes parse, are LF-only, have no BOM, are at most 1 MB and are never pointers
 * - paths are portable, and Epicenter's control files are refused
 * - frontmatter over the key or nesting bound is refused quickly, before parsing
 * - ordinary frontmatter (long keys, long values, deep but sane nesting) is admitted
 * - escaped content never reads as a conflict block; well-formed blocks are found
 * - `slug` always yields a segment the door admits
 */
import { describe, expect, test } from 'bun:test';
import { writePointer } from './markdown.js';
import {
	admissible,
	block,
	escapeLines,
	FRONTMATTER_KEYS,
	FRONTMATTER_NESTING,
	findConflicts,
	fold,
	lint,
	MAX_FILE_BYTES,
	pathRefusal,
	slug,
} from './door.js';

const note = (yaml: string, body = 'body\n') => `---\n${yaml}\n---\n${body}`;

describe('admissible', () => {
	test('a note that parses is admitted, and a delete of a good path always is', () => {
		expect(admissible('notes/a.md', note('title: A'))).toBeNull();
		expect(admissible('notes/a.md', null)).toBeNull();
		expect(admissible('notes/a.MD', 'plain\n')).toBeNull();
	});

	test('a note is refused for what would break it as a shared note', () => {
		expect(admissible('a.md', note('title: [unclosed'))).toBe('does not parse');
		expect(admissible('a.md', '\uFEFFhello\n')).not.toBeNull();
		expect(admissible('a.md', 'line\r\n')).not.toBeNull();
		expect(admissible('a.md', 'x'.repeat(MAX_FILE_BYTES + 1))).not.toBeNull();
		expect(admissible('a.md', writePointer({ oid: '0'.repeat(64), size: 1 }))).not.toBeNull();
		expect(admissible('a.md', 'nul\0')).not.toBeNull();
	});

	test('a blob is a pointer at the path its content names', () => {
		const oid = 'a'.repeat(64);
		expect(admissible(`attachments/${oid}.png`, writePointer({ oid, size: 3 }))).toBeNull();
		expect(admissible(`attachments/${'b'.repeat(64)}.png`, writePointer({ oid, size: 3 }))).not.toBeNull();
	});

	test('paths are portable and control files belong to Epicenter', () => {
		for (const path of ['', '/a.md', 'a//b.md', '../a.md', '.git/config', 'a/CON.md', 'a/b?.md', 'a /b.md', 'x/.gitattributes', '.epicenter/x', 'e\u0301.md'])
			expect(pathRefusal(path)).not.toBeNull();
		expect(pathRefusal('notes/Café.md')).toBeNull();
		expect(fold('Notes/CAFE\u0301.md')).toBe(fold('notes/café.md'));
	});
});

describe('frontmatter parse cost', () => {
	const timed = (text: string) => {
		const start = performance.now();
		const refusal = admissible('a.md', text);
		return { refusal, ms: performance.now() - start };
	};

	test('spike 3 notes are refused before the YAML is parsed', () => {
		const cases = [
			note(Array.from({ length: 40_000 }, (_, i) => `key${i}: value ${i}`).join('\n')),
			note(`k: ${'['.repeat(500_000)}${']'.repeat(500_000)}`.slice(0, MAX_FILE_BYTES - 20)),
			note(`k: ${'{a: '.repeat(80_000)}1${'}'.repeat(80_000)}`),
			note(`${Array.from({ length: 1000 }, (_, i) => `${' '.repeat(i)}a:`).join('\n')} 1`),
			note(`k: {${Array.from({ length: 40_000 }, (_, i) => `a${i}`).join(', ')}}`),
		];
		for (const text of cases) {
			const { refusal, ms } = timed(text);
			expect(refusal).toMatch(/^the frontmatter may (hold|nest) at most/);
			expect(ms).toBeLessThan(250);
		}
	});

	test('the bounds are where they say', () => {
		const keys = (n: number) => note(Array.from({ length: n }, (_, i) => `k${i}: ${i}`).join('\n'));
		expect(admissible('a.md', keys(FRONTMATTER_KEYS))).toBeNull();
		expect(admissible('a.md', keys(FRONTMATTER_KEYS + 1))).toBe(`the frontmatter may hold at most ${FRONTMATTER_KEYS} keys`);
		const brackets = (n: number) => note(`k: ${'['.repeat(n)}${']'.repeat(n)}`);
		expect(admissible('a.md', brackets(FRONTMATTER_NESTING))).toBeNull();
		expect(admissible('a.md', brackets(FRONTMATTER_NESTING + 1))).toBe(`the frontmatter may nest at most ${FRONTMATTER_NESTING} deep`);
	});

	test('ordinary frontmatter is admitted', () => {
		const ordinary = [
			`${'a_long_key_name_'.repeat(8)}: [1, 2, {b: c}]`,
			`title: ${'word '.repeat(150_000)}`,
			'tags:\n  - one\n  - - two\n    - three\nnested:\n  a:\n    b:\n      c:\n        d: 1',
			'text: |\n' + `${' '.repeat(80)}indented block content\n`.repeat(10),
			"? complex\n: value\nquoted: 'a: b, c: d'\n# a comment far to the right" + ' '.repeat(100),
		];
		for (const yaml of ordinary) expect(admissible('a.md', note(yaml))).toBeNull();
	});
});

describe('conflict blocks', () => {
	test('content that looks like a delimiter is escaped and never read as a block', () => {
		const tricky = '<<<<<<< mine\n=======\n>>>>>>> theirs\n';
		expect(findConflicts(escapeLines(tricky))).toEqual([]);
		const written = block({ current: tricky, incoming: 'b\n' }, { current: 'alice', incoming: 'bob' });
		expect(findConflicts(written)).toEqual([{ line: 1, current: 'alice', incoming: 'bob' }]);
	});

	test('lint warns about blocks and malformed openings, and refuses nothing', () => {
		const written = block({ current: 'a\n', incoming: 'b\n' }, { current: 'alice', incoming: 'bob' });
		expect(lint('a.md', written)).toEqual(['1 unresolved conflict block']);
		expect(lint('a.md', '<<<<<<< open only\n')).toEqual(['a malformed conflict block']);
		expect(lint('a.txt', 'a\r\n')).toEqual(['CR line endings']);
	});
});

test('slug yields a segment the door admits', () => {
	expect(slug('Fix the Login, Now!')).toBe('fix-the-login,-now!');
	for (const title of ['', '...', 'CON', 'git', 'a/b\\c', ' Trip: Day 1? ', 'x'.repeat(400), 'Café'])
		expect(pathRefusal(`notes/${slug(title)}.md`)).toBeNull();
});
