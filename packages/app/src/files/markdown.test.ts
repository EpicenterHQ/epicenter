/**
 * Markdown Row Source Tests
 *
 * Verifies frontmatter framing, schema-free reading, and source-preserving
 * patches. A patch replaces only touched value spans; anything it cannot do
 * safely is a refusal, never a rewrite or a throw.
 *
 * Key behaviors:
 * - BOM, CRLF, comments, quoting, and unknown keys survive a field update
 * - Invalid YAML and unconvertible aliases stay readable source with issues
 * - Unsafe patches (aliases, flow maps, unresolvable values) are refused
 *
 * See also:
 * - `browser.test.ts` for table updates and repair through `writeSource`
 */
import { describe, expect, test } from 'bun:test';
import {
	composeSource,
	frameSource,
	patchSource,
	readSource,
} from './markdown.js';

const BOM = '\uFEFF';

describe('frameSource', () => {
	test('locates frontmatter behind a BOM with CRLF lines', () => {
		const source = `${BOM}---\r\ntitle: A\r\n---\r\nBody\r\n`;
		const frame = frameSource(source);
		expect(frame.kind).toBe('frontmatter');
		if (frame.kind !== 'frontmatter') return;
		expect(frame.bom).toBe(BOM);
		expect(frame.newline).toBe('\r\n');
		expect(source.slice(frame.yamlStart, frame.yamlEnd)).toBe('title: A\r\n');
		expect(source.slice(frame.bodyStart)).toBe('Body\r\n');
	});

	test('reports an unclosed fence instead of guessing a body', () => {
		expect(frameSource('---\ntitle: A\nBody\n').kind).toBe('unclosed');
		const read = readSource('---\ntitle: A\nBody\n');
		expect(read.body).toBeUndefined();
		expect(read.issues[0]?.message).toContain('no closing');
	});

	test('treats text without an opening fence as body only', () => {
		const read = readSource('Just text\n---\nmore\n');
		expect(read.values).toEqual({});
		expect(read.body).toBe('Just text\n---\nmore\n');
	});
});

describe('patchSource', () => {
	test('replaces only the touched value, keeping BOM, CRLF, comments, quotes, and unknown keys', () => {
		const source = [
			`${BOM}---`,
			'# a leading comment',
			"title: 'Buy milk' # keep this note",
			'done: false',
			'unknown: {nested: [1, 2]}  # unknown key',
			'quoted: "yes"',
			'---',
			'Body line one',
			'',
		].join('\r\n');
		const patched = patchSource(source, { fields: { done: true } });
		expect(patched.error).toBeNull();
		expect(patched.data).toBe(source.replace('done: false', 'done: true'));
	});

	test('appends a missing key before the closing fence with the file newline style', () => {
		const source = '---\r\ntitle: A\r\n---\r\nBody';
		const patched = patchSource(source, { fields: { done: false } });
		expect(patched.data).toBe('---\r\ntitle: A\r\ndone: false\r\n---\r\nBody');
	});

	test('fills an empty value with a separating space', () => {
		const patched = patchSource('---\ntitle:\ndone: false\n---\n', {
			fields: { title: 'Named' },
		});
		expect(patched.data).toBe('---\ntitle: Named\ndone: false\n---\n');
	});

	test('quotes strings YAML would read as another type', () => {
		const patched = patchSource('---\ntitle: A\n---\n', {
			fields: { title: 'true' },
		});
		expect(patched.error).toBeNull();
		expect(readSource(patched.data!).values).toEqual({ title: 'true' });
	});

	test('writes multi-line strings on one line and keeps following keys intact', () => {
		const source = '---\ntitle: |\n  one\n  two\ndone: false\n---\n';
		const patched = patchSource(source, { fields: { title: 'a\nb' } });
		expect(patched.error).toBeNull();
		expect(patched.data).toBe('---\ntitle: "a\\nb"\ndone: false\n---\n');
	});

	test('replaces the body without touching frontmatter bytes', () => {
		const source = '---\r\ntitle: A # c\r\n---\r\nOld body\r\n';
		const patched = patchSource(source, { body: 'New body\r\n' });
		expect(patched.data).toBe('---\r\ntitle: A # c\r\n---\r\nNew body\r\n');
	});

	test('adds frontmatter to body-only source after the BOM', () => {
		const patched = patchSource(`${BOM}Body\r\n`, { fields: { title: 'A' } });
		expect(patched.data).toBe(`${BOM}---\r\ntitle: A\r\n---\r\nBody\r\n`);
	});

	test('refuses invalid YAML rather than rewriting it', () => {
		const patched = patchSource('---\ntitle: [unclosed\n---\n', {
			fields: { done: true },
		});
		expect(patched.error?.reason).toContain('not valid YAML');
	});

	test('refuses values reached through anchors or aliases', () => {
		const patched = patchSource('---\nbase: &b x\ntitle: *b\n---\n', {
			fields: { title: 'y' },
		});
		expect(patched.error?.reason).toContain('anchor, alias, or tag');
	});

	test('refuses a flow-mapping frontmatter', () => {
		expect(
			patchSource('---\n{title: A}\n---\n', { fields: { title: 'B' } }).error,
		).not.toBeNull();
	});

	test('composeSource writes declared order and reads back', () => {
		const source = composeSource(
			{ title: 'Walk: the dog', done: false },
			'Notes\n',
		);
		expect(source.data).toBe(
			'---\ntitle: "Walk: the dog"\ndone: false\n---\nNotes\n',
		);
		expect(readSource(source.data!).values).toEqual({
			title: 'Walk: the dog',
			done: false,
		});
	});
});

describe('unconvertible frontmatter', () => {
	const cases = {
		'an unresolvable alias': '---\nx: *missing\ntitle: A\n---\nbody\n',
		'a circular alias': '---\nloop: &a [*a]\ntitle: A\n---\nbody\n',
		// Each level repeats the previous one ten times: 10^4 nodes from a few lines.
		'an alias expansion past the limit': `---\nl0: &l0 [x, x, x, x, x, x, x, x, x, x]\n${[
			1, 2, 3, 4,
		]
			.map(
				(level) =>
					`l${level}: &l${level} [${Array(10)
						.fill(`*l${level - 1}`)
						.join(', ')}]`,
			)
			.join('\n')}\ntitle: A\n---\nbody\n`,
	};

	for (const [name, source] of Object.entries(cases)) {
		test(`${name} is a frontmatter issue with the body preserved`, () => {
			const read = readSource(source);
			expect(read.values).toBeUndefined();
			expect(read.body).toBe('body\n');
			expect(read.issues).toHaveLength(1);
			expect(read.issues[0]?.kind).toBe('frontmatter');
		});

		test(`${name} refuses a field patch without throwing`, () => {
			const patched = patchSource(source, { fields: { title: 'B' } });
			expect(patched.error?.reason).toContain('edit the complete source');
		});
	}

	test('a body-only change still preserves the unconvertible frontmatter bytes', () => {
		const source = cases['an unresolvable alias'];
		expect(patchSource(source, { body: 'new\n' }).data).toBe(
			source.replace('body\n', 'new\n'),
		);
	});
});
