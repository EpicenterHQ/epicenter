/**
 * Canonical Row Document Tests
 *
 * Counterexamples for the codec every row is read and written through. Each test names a
 * way a canonical form could lose or invent data, and shows the codec either
 * keeps the data exactly or refuses.
 *
 * Key behaviors:
 * - Sources that differ only in YAML presentation format to identical bytes
 * - Declared keys come first in declared order; unknown keys are kept, sorted
 * - Anything without an exact JSON value is refused, never converted lossily
 * - The body is kept byte for byte; schema validation is not the codec's job
 * - An invalid row keeps its unknown and invalid fields: the table refuses to
 *   set fields over it, the one write repairs it from the `InvalidRow`'s
 *   exact text, and only an explicit create restores a deleted row
 *
 * See also:
 * - `row-text.test.ts` for `parseRow` and `formatRow` over this codec
 */
import { expect, test } from 'bun:test';
import {
	defineFolder,
	defineTable,
	field,
	openFolder,
	parseRow,
} from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { testBrowserStorage } from './browser-storage.test-support.js';
import {
	type CanonicalDocument,
	formatRowSource,
	parseRowSource,
} from './canonical.js';

/** A todos table's declared field order. */
const DECLARED = ['title', 'done', 'priority'] as const;

function parse(source: string): CanonicalDocument {
	return expectOk(parseRowSource(source)).document;
}

function format(document: CanonicalDocument): string {
	return expectOk(formatRowSource(document, DECLARED)).text;
}

const canonical = (source: string) => format(parse(source));

test('sources that differ only in YAML presentation format to identical bytes', () => {
	const plain = [
		'---',
		'title: Plan',
		'done: false',
		'owner: sam',
		'tags: [a, b]',
		'---',
		'Body.\n',
	].join('\n');
	const styled = [
		'﻿---',
		'# a comment that canonical form drops',
		'tags:\r\n  - \'a\'\r\n  - "b"',
		"owner: 'sam' # trailing comment",
		'"done": !!bool false',
		'title: >-\r\n  Plan',
		'---',
		'Body.\n',
	].join('\r\n');
	// The body must match too, so the styled source ends its fence with LF.
	const styledLfBody = styled.replace('---\r\nBody.\n', '---\nBody.\n');

	expect(canonical(styledLfBody)).toBe(canonical(plain));
	expect(canonical(plain)).toBe(
		[
			'---',
			'title: Plan',
			'done: false',
			'owner: sam',
			'tags:',
			'  - a',
			'  - b',
			'---',
			'Body.\n',
		].join('\n'),
	);
});

test('declared keys come first in declared order, then other keys in code unit order', () => {
	const text = canonical(
		[
			'---',
			'zeta: 1',
			'"10": ten',
			'priority: high',
			'"2": two',
			'Alpha: 3',
			'title: T',
			'---',
			'',
		].join('\n'),
	);
	// `done` is declared but absent, so it is not invented.
	expect(text).toBe(
		[
			'---',
			'title: T',
			'priority: high',
			'"10": ten',
			'"2": two',
			'Alpha: 3',
			'zeta: 1',
			'---',
			'',
		].join('\n'),
	);
	// Integer-like keys that JS objects reorder still format in code unit order.
	expect(Object.keys(parse(text).fields)).toEqual([
		'2',
		'10',
		'title',
		'priority',
		'Alpha',
		'zeta',
	]);
});

test('parse and format are idempotent byte for byte', () => {
	const source = [
		'---',
		'meta: {z: [3, {y: 1, x: null}], a: true}',
		'title: "Unicode é 漢字 😀 and a literal   separator"',
		'n: -0',
		'f: 1.5e-7',
		'---',
		'body',
	].join('\n');
	const first = canonical(source);
	const second = canonical(first);
	const third = canonical(second);
	expect(second).toBe(first);
	expect(third).toBe(first);
	// The separator is escaped: some YAML readers end a line at a raw one.
	expect(first).toContain('\\u2028');
	expect(parse(first).fields.title).toBe(
		'Unicode é 漢字 😀 and a literal   separator',
	);
});

test('nested unknown values are kept, with nested keys sorted', () => {
	const document = parse(
		[
			'---',
			'title: T',
			'extra:',
			'  zed: [1, two, null, false, {b: 2, a: [ ]}]',
			'  alpha: {inner: {deep: "x"}}',
			'---',
			'',
		].join('\n'),
	);
	expect(document.fields.extra).toEqual({
		zed: [1, 'two', null, false, { b: 2, a: [] }],
		alpha: { inner: { deep: 'x' } },
	});
	expect(format(document)).toBe(
		[
			'---',
			'title: T',
			'extra:',
			'  alpha:',
			'    inner:',
			'      deep: x',
			'  zed:',
			'    - 1',
			'    - two',
			'    - null',
			'    - false',
			'    - a: []',
			'      b: 2',
			'---',
			'',
		].join('\n'),
	);
});

test.each([
	['an unsafe integer', 'n: 9007199254740993', 'outside the safe range'],
	[
		'a rounded decimal integer',
		'n: 9007199254740993.0',
		'outside the safe range',
	],
	[
		'a rounded exponent integer',
		'n: 9.007199254740993e15',
		'outside the safe range',
	],
	[
		'an integer-valued float beyond the safe range',
		'n: 1e300',
		'outside the safe range',
	],
	['a non-finite number', 'n: .inf', 'not finite'],
	['a custom tag', 'n: !foo bar', 'Unresolved tag'],
	['binary', 'n: !!binary aGVsbG8=', 'binary is not supported'],
	['a set', 'n: !!set {x: null}', 'set is not supported'],
	['a timestamp', 'n: !!timestamp 2020-01-01', 'timestamp is not supported'],
	['a nested non-string key', 'n: {1: b}', 'key is not a string'],
	['a top-level non-string key', '1: b', 'key is not a string'],
	['a cyclic alias', 'n: &x [1, *x]', 'circular'],
	['a lone surrogate', 'n: "\\ud800"', 'lone surrogate'],
	['a duplicate key', 'n: 1\nn: 2', 'not supported YAML'],
])('refuses %s', (_, yaml, reason) => {
	const source = `---\n${yaml}\n---\nbody\n`;
	const result = parseRowSource(source);
	expect(expectErr(result).reason).toContain(reason);
});

test('format refuses values that have no exact JSON form', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	for (const value of [
		2 ** 53,
		Number.NaN,
		10n,
		new Date(0),
		cyclic,
		'\ud800',
		// biome-ignore lint/suspicious/noSparseArray: a hole is the counterexample
		[1, , 3],
	]) {
		const result = formatRowSource(
			{ fields: { x: value } as never, body: '' },
			DECLARED,
		);
		expectErr(result);
	}
});

test('format refuses a malformed document shape instead of throwing, and reads only fields and body', () => {
	const malformed: unknown[] = [
		null,
		'---\n---\n',
		{ fields: {} },
		{ fields: {}, body: 42 },
		{ body: '' },
		{ fields: null, body: '' },
	];
	const reasons = malformed.map(
		(document) =>
			expectErr(formatRowSource(document as never, DECLARED)).reason,
	);
	expect(reasons).toEqual([
		'The document is not an object',
		'The document is not an object',
		'The body is not a string',
		'The body is not a string',
		'The fields are not a plain object',
		'The fields are not a plain object',
	]);
	expect(
		expectErr(formatRowSource({ fields: {} } as never, DECLARED)).path,
	).toEqual(['body']);

	// Other properties, such as a public row's status and text, are not input.
	const row = {
		status: 'valid',
		text: '---\n"title": "Injected"\n---\n',
		fields: { title: 'Plan' },
		body: 'Body.\n',
	};
	expect(format(row)).toBe('---\ntitle: Plan\n---\nBody.\n');
});

test('safe aliases expand; alias expansion is bounded', () => {
	const document = parse(
		['---', 'base: &b {x: 1, y: [a]}', 'copy: *b', '---', ''].join('\n'),
	);
	expect(document.fields.copy).toEqual({ x: 1, y: ['a'] });
	// `y` is quoted because a YAML 1.1 reader reads a bare y as true.
	expect(format(document)).toContain('copy:\n  x: 1\n  "y":\n    - a\n');

	const laughs = ['---', 'a: &a [x, x, x, x, x, x, x, x, x, x]'];
	for (const [name, previous] of [
		['b', 'a'],
		['c', 'b'],
		['d', 'c'],
		['e', 'd'],
	])
		laughs.push(
			`${name}: &${name} [${Array(10).fill(`*${previous}`).join(', ')}]`,
		);
	laughs.push('---', '');
	const result = parseRowSource(laughs.join('\n'));
	expect(expectErr(result).reason).toContain('too many');
});

test('the row reader applies exactly the codec alias bound, so both accept the same aliases', () => {
	const notes = defineFolder({
		tables: { notes: defineTable({ fields: { title: field.string() } }) },
	}).tables.notes;

	// A large anchored list aliased a few times weighs little in both.
	const items = Array.from({ length: 50 }, (_, i) => `i${i}`).join(', ');
	const list = `---\ntitle: Plan\nlist: &l [${items}]\na: *l\nb: *l\nc: *l\n---\n`;
	expect(parse(list).fields.c).toHaveLength(50);
	expect<object>(expectOk(parseRow(notes, list)).fields).toEqual(
		parse(list).fields,
	);

	// Only the expansions the codec counts are bounded: 64 aliases expand
	// here, under its limit, however many earlier uses each one follows.
	const uses = Array.from({ length: 60 }, (_, i) => `u${i}: *a`).join('\n');
	const weighted = `---\ntitle: Plan\na: &a x\n${uses}\nb: &b [*a]\nc: *b\nd: *b\n---\n`;
	expect(parse(weighted).fields.d).toEqual(['x']);
	expect<object>(expectOk(parseRow(notes, weighted)).fields).toEqual(
		parse(weighted).fields,
	);
});

test('a __proto__ key is an own field and never a prototype', () => {
	const source = [
		'---',
		'"__proto__": {"__proto__": {polluted: true}, constructor: 1}',
		'---',
		'',
	].join('\n');
	const document = parse(source);
	expect(Object.hasOwn(document.fields, '__proto__')).toBe(true);
	expect(Object.getPrototypeOf(document.fields)).toBe(Object.prototype);
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	const text = format(document);
	expect(text).toBe(
		[
			'---',
			'__proto__:',
			'  __proto__:',
			'    polluted: true',
			'  constructor: 1',
			'---',
			'',
		].join('\n'),
	);
	expect(format(parse(text))).toBe(text);
	// Inherited properties are not fields.
	const inherited = Object.create({ inherited: 1 }) as Record<string, never>;
	expectErr(formatRowSource({ fields: inherited, body: '' }, DECLARED));
});

test('-0 survives parse and format', () => {
	for (const spelling of ['-0', '-0.0', '!!int "-0"']) {
		const document = parse(`---\nn: ${spelling}\n---\n`);
		expect(Object.is(document.fields.n, -0)).toBe(true);
		const text = format(document);
		// The key is quoted: a YAML 1.1 reader reads a bare n as false. The
		// value is a float, since -0 is integer zero to a YAML 1.1 reader.
		expect(text).toBe('---\n"n": -0.0\n---\n');
		expect(Object.is(parse(text).fields.n, -0)).toBe(true);
	}
	expect(Object.is(parse('---\nn: 0\n---\n').fields.n, 0)).toBe(true);
});

test('the body is kept exactly: CRLF, trailing spaces, and blank lines', () => {
	const body = '\r\n\r\nline one  \r\n\t\r\n\n\nline two \t\r\n\r\n';
	const source = `---\r\ntitle: T\r\n---\r\n${body}`;
	const document = parse(source);
	expect(document.body).toBe(body);
	const text = format(document);
	expect(text).toBe(`---\ntitle: T\n---\n${body}`);
	expect(parse(text).body).toBe(body);
	// A body line that looks like a fence is still body.
	expect(parse(format({ fields: {}, body: '---\nnot: yaml\n' })).body).toBe(
		'---\nnot: yaml\n',
	);
});

test('schema-invalid values survive: validation is outside the codec', () => {
	// The table declares `done` boolean and `priority` one of low/normal/high.
	const document = parse(
		['---', "title: 'A'", 'done: A', 'priority: 7', '---', ''].join('\n'),
	);
	expect(document.fields).toEqual({ title: 'A', done: 'A', priority: 7 });
	expect(format(document)).toBe(
		['---', 'title: A', 'done: A', 'priority: 7', '---', ''].join('\n'),
	);
});

test('a body that UTF-8 encoding would change is refused rather than rewritten', () => {
	const body = 'before\ud800after';
	expect(expectErr(parseRowSource(`---\ntitle: T\n---\n${body}`)).path).toEqual(
		['body'],
	);
	expect(
		expectErr(formatRowSource({ fields: {}, body }, DECLARED)).path,
	).toEqual(['body']);
});

test('an invalid row keeps unknown and invalid fields through a raw write from its exact text, and restores only explicitly', async () => {
	const definition = defineFolder({
		tables: {
			todos: defineTable({
				fields: { title: field.string(), done: field.boolean() },
			}),
		},
	});
	const folder = expectOk(
		await openFolder({
			id: 'so.epicenter.canonical-test',
			definition,
			browser: {
				author: { name: 'Canonical', email: 'canonical@example.test' },
				...testBrowserStorage(),
			},
		}),
	);
	try {
		const source =
			'---\n# presentation\ntitle: Milk\ndone: invalid\nowner: {agent: alice}\n---\nBody\r\n';
		expectOk(await folder.write('todos/milk.md', null, source));
		const invalid = expectErr(await folder.tables.todos.get('milk'));
		if (invalid.name !== 'InvalidRow') throw new Error(invalid.message);
		expect(invalid.text).toBe(source);
		const document = parse(invalid.text);
		const edited = {
			...document,
			fields: { ...document.fields, title: 'Oat milk' },
		};
		const { text } = expectOk(
			formatRowSource(edited, Object.keys(definition.tables.todos.fields)),
		);

		// The table writes only valid rows.
		expect(
			expectErr(await folder.tables.todos.set('milk', { title: 'Oat milk' }))
				.name,
		).toBe('InvalidValues');
		// The one write lands the repair, from the text that was read.
		expectOk(await folder.write(invalid.path, invalid.text, text));
		const repaired = expectErr(await folder.tables.todos.get('milk'));
		if (repaired.name !== 'InvalidRow') throw new Error(repaired.message);
		expect(repaired.text).toBe(text);
		expect(parse(repaired.text)).toEqual({
			fields: { title: 'Oat milk', done: 'invalid', owner: { agent: 'alice' } },
			body: 'Body\r\n',
		});
		expect(repaired.issues).toHaveLength(1);
		expect(repaired.issues[0].field).toBe('done');

		const captured = expectOk(await folder.files.read(repaired.path));
		expectOk(await folder.tables.todos.delete('milk'));
		// An edit of a row deleted since writes nothing: the delete stands.
		expect(
			expectOk(await folder.write(repaired.path, captured.bytes, text)).file,
		).toBeNull();
		expect(expectOk(await folder.tables.todos.get('milk'))).toBeUndefined();
		expectOk(await folder.write('todos/milk.md', null, text));
		const restored = expectErr(await folder.tables.todos.get('milk'));
		expect(restored).toMatchObject({ name: 'InvalidRow', text });
	} finally {
		await folder.close();
	}
});
