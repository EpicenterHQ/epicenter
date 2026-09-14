import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { editBody, editField, serializeEntry } from './serialize';

describe('serializeEntry', () => {
	test('an empty mapping is body only (no fence)', () => {
		expect(serializeEntry({}, '# Body\ntext')).toBe('# Body\ntext');
	});

	test('emits a fence that reparses to the same values', () => {
		const out = serializeEntry(
			{ title: 'Hello', status: 'draft', count: 3 },
			'# Body',
		);
		expect(out.startsWith('---\n')).toBe(true);
		expect(parseMarkdown(out).data).toEqual({
			frontmatter: { title: 'Hello', status: 'draft', count: 3 },
			body: '# Body',
		});
	});

	test('preserves value types: a number stays a number, a numeric string stays a string', () => {
		const out = serializeEntry({ count: 3, code: '007' }, 'body');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			count: 3,
			code: '007',
		});
	});

	test('an existing null value round-trips (never invented, never dropped)', () => {
		const out = serializeEntry({ title: null }, 'body');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: null });
	});

	test('the body is written verbatim', () => {
		const body = '# Heading\n\n- a\n- b\n\ntrailing text';
		const out = serializeEntry({ title: 'x' }, body);
		expect(parseMarkdown(out).data?.body).toBe(body);
	});
});

/**
 * The full save cycle the vault runs: parse the freshest disk bytes, apply ONE
 * edit to the frontmatter object, re-emit. Exercises the real write logic
 * without Tauri, and is where round-trip identity (by value) is the contract.
 */
describe('edit cycle (parse -> edit -> serialize -> parse)', () => {
	test('round-trip identity by VALUE: a no-op cycle preserves every value and the body', () => {
		const raw =
			'---\ntitle: My Post\nstatus: draft\ntags:\n  - a\n  - b\n---\n# Body\n\ntext';
		const before = parseMarkdown(raw).data;
		const after = parseMarkdown(editField(raw, 'status', 'draft')).data;
		expect(after).toEqual(before);
	});

	test('setting one field keeps the others and their order', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = editField(raw, 'status', 'published');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			title: 'Hello',
			status: 'published',
		});
		expect(out.indexOf('title')).toBeLessThan(out.indexOf('status'));
	});

	test('clearing a field removes the key, never writes null', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\nbody';
		const out = editField(raw, 'status', undefined);
		expect(out).not.toContain('status');
		expect(out).not.toContain('null');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: 'Hello' });
	});

	// The string widget commits `""` (a present, valid value) and clears via separate
	// chrome: only `undefined` deletes the key, so `""` must survive as a real value.
	test('the empty string is a saved value, NOT a clear', () => {
		const raw = '---\ntitle: Hello\n---\nbody';
		const out = editField(raw, 'title', '');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({ title: '' });
	});

	test('clearing the last field drops the fence to body-only', () => {
		expect(
			editField('---\ntitle: Hello\n---\n# Body\ntext', 'title', undefined),
		).toBe('# Body\ntext');
	});

	test('an invalid-against-the-contract value survives by value (stays editable)', () => {
		// `duration` held as a string while the contract wants an integer: still valid
		// YAML, so it round-trips and the grid keeps showing it INVALID to fix.
		const raw = '---\nduration: "1240s"\n---\nbody';
		const out = editField(raw, 'title', 'New');
		expect(parseMarkdown(out).data?.frontmatter).toEqual({
			duration: '1240s',
			title: 'New',
		});
	});

	test('setting a field on a file with no frontmatter creates the block', () => {
		const out = editField('# Just a body\n\ntext', 'title', 'New');
		expect(parseMarkdown(out).data).toEqual({
			frontmatter: { title: 'New' },
			body: '# Just a body\n\ntext',
		});
	});

	test('editing the body keeps the frontmatter values', () => {
		const raw = '---\ntitle: Keep\nstatus: draft\n---\nold';
		expect(parseMarkdown(editBody(raw, 'new body')).data).toEqual({
			frontmatter: { title: 'Keep', status: 'draft' },
			body: 'new body',
		});
	});

	// `yaml` emits `Part 1 --- Introduction` as a plain scalar, so the written
	// file carries `---` mid-line inside the block. The next parse must still
	// find the real fence, or the fields after that value fall into the body
	// and the following edit writes them there for good.
	test('a value containing --- survives the edit cycle with every other field', () => {
		const raw = '---\ntitle: Hello\nstatus: draft\n---\n# Body';
		const titled = editField(raw, 'title', 'Part 1 --- Introduction');
		expect(parseMarkdown(titled).data).toEqual({
			frontmatter: { title: 'Part 1 --- Introduction', status: 'draft' },
			body: '# Body',
		});
		const published = editField(titled, 'status', 'published');
		expect(parseMarkdown(published).data).toEqual({
			frontmatter: { title: 'Part 1 --- Introduction', status: 'published' },
			body: '# Body',
		});
	});
});
