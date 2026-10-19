/**
 * Row source and schema boundary tests.
 * Reads preserve source and unvalidated data; writes change the draft without
 * filtering fields through a schema or rewriting untouched presentation.
 * Key behaviors:
 * - Invalid source stays visible, with positions for schema and YAML issues.
 * - Fields retain source order, undeclared data, and explicit deletion.
 * - Body-only saves preserve malformed but framed frontmatter for raw repair.
 */
import { expect, expectTypeOf, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { parseRowSource } from './content/canonical.js';
import { readRow, rowChange } from './row.js';

const schema = Type.Object({ title: Type.String(), count: Type.Number() });

test('a fitting row exposes typed fields while retaining exact source and extra fields', () => {
	const text =
		'\uFEFF---\r\n# keep this\r\ntitle: "hello"\r\ncount: 2\r\nextra: kept\r\n---\r\nBody\r\n';
	const row = readRow('note', new TextEncoder().encode(text), schema);
	expect(row).toMatchObject({
		id: 'note',
		text,
		body: 'Body\r\n',
		issues: null,
		fields: { title: 'hello', count: 2, extra: 'kept' },
	});
	if (row.issues === null)
		expectTypeOf(row.fields.title).toEqualTypeOf<string>();
});

test('literal JSON schemas infer fields and schema failures keep every raw field', () => {
	const literal = {
		type: 'object',
		properties: { count: { type: 'number' } },
		required: ['count'],
	} as const;
	const good = readRow('good', '---\ncount: 2\n---\n', literal);
	if (good.issues === null)
		expectTypeOf(good.fields.count).toEqualTypeOf<number>();
	const row = readRow(
		'bad',
		'---\ncount: wrong\nextra: true\n---\nBody',
		literal,
	);
	expect(row.fields).toEqual({ count: 'wrong', extra: true });
	expect(row.issues).toContainEqual({
		kind: 'schema',
		path: ['count'],
		message: 'must be number',
		line: 2,
	});
	expect(row.body).toBe('Body');
});

test('nested schema errors locate slash and tilde field names at the value line', () => {
	const nested = Type.Object({
		'a/b': Type.Object({ '~name': Type.Number() }),
	});
	const row = readRow('bad', '---\na/b:\n  ~name: wrong\n---\n', nested);
	expect(row.issues).toContainEqual({
		kind: 'schema',
		message: 'must be number',
		path: ['a/b', '~name'],
		line: 3,
	});
});

test('ambiguous TypeBox raw paths never point to an invented field location', () => {
	const nested = Type.Object({
		'a/b': Type.Number(),
		a: Type.Object({ b: Type.Number() }),
	});
	const row = readRow('bad', '---\na/b: wrong\na:\n  b: wrong\n---\n', nested);
	expect(row.issues).toEqual([
		{ kind: 'schema', message: 'must be number', path: [] },
		{ kind: 'schema', message: 'must be number', path: [] },
	]);
});

test('unparseable frontmatter exposes its whole source as body', () => {
	const text = '---\ntitle: [broken\n---\nBody';
	const row = readRow('bad', text, schema);
	expect(row.fields).toEqual({});
	expect(row.body).toBe(text);
	expect(row.text).toBe(text);
	expect(row.issues?.[0]).toMatchObject({ kind: 'frontmatter', line: 3 });
});

test('invalid UTF-8, NUL, and lone surrogates never become replacement-character source', () => {
	for (const content of [new Uint8Array([0xff]), 'a\0b', '\ud800']) {
		const row = readRow('bad', content, schema);
		expect(row.text).toBe('');
		expect(row.body).toBe('');
		expect(row.fields).toEqual({});
		expect(row.issues?.[0]?.kind).toBe('not-text');
		expect(expectErr(rowChange(row, { body: 'replacement' })).reason).toContain(
			'not text',
		);
	}
});

test('an unchanged fields patch keeps comments, BOM, quoting and line endings', () => {
	const text =
		'\uFEFF---\r\n# title\r\ntitle: "hello"\r\ncount: 2\r\n---\r\nBody';
	const row = readRow('note', text, schema);
	expect(expectOk(rowChange(row, { fields: { title: 'hello' } })).text).toBe(
		text,
	);
	expect(expectOk(rowChange(row, {})).text).toBe(text);
});

test('a changed field preserves undeclared fields and source key order then appends alphabetically', () => {
	const row = readRow(
		'note',
		'---\n"10": ten\n"2": two\ntitle: Before\ncount: 2\nextra: kept\n---\nBody',
		schema,
	);
	const { text } = expectOk(
		rowChange(row, {
			fields: { title: 'After', zebra: 1, alpha: 2, count: undefined },
		}),
	);
	expect(text).toBe(
		'---\n"10": ten\n"2": two\ntitle: After\nextra: kept\nalpha: 2\nzebra: 1\n---\nBody',
	);
	expect(expectOk(parseRowSource(text)).document.fields).toEqual({
		'10': 'ten',
		'2': 'two',
		title: 'After',
		extra: 'kept',
		alpha: 2,
		zebra: 1,
	});
});

test('a schema mismatch does not refuse saving a field or strip raw fields', () => {
	const row = readRow('note', '---\ntitle: 42\nextra: kept\n---\nBody', schema);
	const { text } = expectOk(
		rowChange(row, { fields: { count: 'still not a number' } }),
	);
	const sent = readRow('note', text, schema);
	expect(sent.fields).toEqual({
		title: 42,
		extra: 'kept',
		count: 'still not a number',
	});
	expect(sent.issues?.some((issue) => issue.kind === 'schema')).toBe(true);
});

test('body-only changes preserve valid and malformed framed header bytes', () => {
	for (const header of [
		'\uFEFF---\r\n# note\r\ntitle: "hello"\r\ncount: 2\r\n---\r\n',
		'---\ntitle: [broken\n---\n',
	]) {
		const row = readRow('note', header + 'Old body', schema);
		expect(expectOk(rowChange(row, { body: 'New body' })).text).toBe(
			header + 'New body',
		);
	}
});

test('adding a body after a closing fence at EOF inserts its missing line break', () => {
	const row = readRow('note', '---\r\ntitle: Hello\r\ncount: 2\r\n---', schema);
	expect(expectOk(rowChange(row, {})).text).toBe(row.text);
	const { text } = expectOk(rowChange(row, { body: 'New body' }));
	expect(text).toBe(row.text + '\r\nNew body');
	expect(readRow('note', text, schema).issues).toBeNull();
});

test('field writes on unparseable source refuse while body replaces unframed source', () => {
	const row = readRow('note', 'No frontmatter', schema);
	expect(
		expectErr(rowChange(row, { fields: { title: 'Hello' } })).reason,
	).toContain('does not start');
	expect(expectOk(rowChange(row, { body: 'New source' })).text).toBe(
		'New source',
	);
});

test('new rows have empty frontmatter and accept schema-invalid source', () => {
	expect(
		expectOk(
			rowChange(null, { fields: { zebra: true, alpha: 1 }, body: 'Body' }),
		).text,
	).toBe('---\nalpha: 1\nzebra: true\n---\nBody');
});

test('prototype-looking fields stay data and invalid values are refused without mutating the base', () => {
	const row = readRow('note', '---\ntitle: Hello\ncount: 2\n---\nBody', schema);
	const patch = JSON.parse('{"__proto__":{"safe":true}}') as Record<
		string,
		unknown
	>;
	const { text } = expectOk(rowChange(row, { fields: patch }));
	expect(
		Object.hasOwn(expectOk(parseRowSource(text)).document.fields, '__proto__'),
	).toBe(true);
	for (const fields of [
		{ bad: Number.NaN },
		{ bad: '\ud800' },
		{ bad: new Date() },
	])
		expect(expectErr(rowChange(row, { fields })).reason.length).toBeGreaterThan(
			0,
		);
	for (const body of ['bad\0body', '\ud800'])
		expect(expectErr(rowChange(row, { body })).reason).toMatch(/NUL|surrogate/);
	const escaped = expectOk(rowChange(row, { fields: { escaped: '\0' } })).text;
	expect(escaped.includes('\0')).toBe(false);
	expect(expectOk(parseRowSource(escaped)).document.fields.escaped).toBe('\0');
	expect(row.fields).toEqual({ title: 'Hello', count: 2 });
});
