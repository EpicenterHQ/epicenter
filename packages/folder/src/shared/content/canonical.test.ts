/**
 * Row codec tests
 *
 * Checks the shared merge and table codec keeps exact JSON-compatible values,
 * refuses lossy or unbounded YAML, and retains source locations for repair.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { formatRowSource, parseRowSource } from './canonical.js';

test('source key order retains integer-looking names that objects reorder', () => {
	const parsed = expectOk(
		parseRowSource('---\n"10": ten\n"2": two\nlast: final\n---\n'),
	);
	expect(parsed.keyOrder).toEqual(['10', '2', 'last']);
	expect(expectOk(parseRowSource('---\n---\n')).keyOrder).toEqual([]);
});

test('the codec roundtrips unknown fields, __proto__ keys and JSON values', () => {
	const source =
		'---\n__proto__: safe\ntitle: "yes"\nitems: [1, null, false]\nnested: {z: 2, a: 1}\n---\nBody\n';
	const { document } = expectOk(parseRowSource(source));
	expect(Object.hasOwn(document.fields, '__proto__')).toBe(true);
	expect(document.fields.__proto__).toBe('safe');
	expect(document.fields.title).toBe('yes');
	const formatted = expectOk(formatRowSource(document, ['title', '__proto__']));
	expect(expectOk(parseRowSource(formatted.text)).document).toEqual(document);
	expect(formatted.text.indexOf('title:')).toBeLessThan(
		formatted.text.indexOf('__proto__:'),
	);
});

test('lossy, duplicate or cyclic YAML is refused with source locations', () => {
	for (const yaml of [
		'n: 9007199254740993\n',
		'n: .nan\n',
		'title: one\ntitle: two\n',
		'n: !!timestamp 2026-10-19\n',
		'items: &loop [*loop]\n',
		'? [a, b]\n: value\n',
	]) {
		const error = expectErr(parseRowSource(`---\n${yaml}---\n`));
		expect(error.line).toBeGreaterThanOrEqual(2);
		expect(error.reason.length).toBeGreaterThan(0);
	}
});

test('alias expansion is bounded before turning a tiny YAML graph into large values', () => {
	const source = `---\noriginal: &value [a, b]\nrepeated: [${Array.from({ length: 101 }, () => '*value').join(', ')}]\n---\n`;
	const error = expectErr(parseRowSource(source));
	expect(error.reason).toBe('The frontmatter expands too many aliases');
	expect(error.field).toBe('repeated');
});

test('field locations refer to the original BOM and CRLF source', () => {
	const parsed = expectOk(
		parseRowSource(
			'\uFEFF---\r\n# note\r\ntitle: Title\r\noptions:\r\n  nested: false\r\n---\r\nBody',
		),
	);
	expect(parsed.lineOf('title')).toBe(3);
	expect(parsed.lineOf('options', '/nested')).toBe(5);
	expect(parsed.lineOf('absent')).toBeUndefined();
	expect(parsed.document.body).toBe('Body');
});

test('formatting refuses values that serialization would silently discard or alter', () => {
	for (const value of [
		new Date(0),
		NaN,
		Infinity,
		9007199254740992,
		new Set(['a']),
		'\ud800',
	]) {
		expect(
			expectErr(formatRowSource({ fields: { value }, body: '' }, [])).field,
		).toBe('value');
	}
});
