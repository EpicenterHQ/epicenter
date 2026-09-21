import { expect, test } from 'bun:test';
import { defineApp, defineTable, field } from '@epicenter/app';
import { recognize, compile } from '@epicenter/matter-core/field';
import { editField } from '@epicenter/matter-core/serialize';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { compileData, jsonValue } from '../definition/index.js';
import { fieldChanges, matterContract } from './field-changes.js';
import { parseRowFile, rowFile } from './frontmatter.js';

const definition = defineApp({
	id: 'so.epicenter.file-test',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			folder: field.nullable(field.string()),
			count: field.number(),
			payload: field.json(jsonValue),
			transcript: field.string(),
		}),
	},
});
const table = expectOk(compileData(definition)).tables.get('notes')!;

test('clearing the final field in Matter preserves the artifact body', () => {
	for (const body of ['', 'Body']) {
		const parsed = parseRowFile(
			editField(rowFile({ folder: 'x' }, body), 'folder', undefined),
		)!;
		expect(parsed).toEqual({ fields: {}, body });
		expect(
			expectOk(fieldChanges(table, ['folder'], { folder: 'x' }, parsed.fields)),
		).toEqual({ folder: null });
	}
});

test('prototype names are read and written as own field values', () => {
	const source = expectOk(
		compileData(
			defineApp({
				id: 'so.epicenter.prototype-fields',
				kv: {},
				tables: {
					rows: defineTable({ constructor: field.nullable(field.string()) }),
				},
			}),
		),
	).tables.get('rows')!;
	const patch = expectOk(
		fieldChanges(source, ['constructor'], { constructor: 'x' }, {}),
	);
	expect(Object.hasOwn(patch, 'constructor')).toBe(true);
	expect(patch.constructor).toBeNull();
	expect(
		expectErr(fieldChanges(source, [], {}, JSON.parse('{"__proto__": {}}'))),
	).toMatchObject({ fields: [{ field: '__proto__', reason: 'undeclared' }] });
});

test('only the edited Matter field is submitted, independent of current store values', () => {
	const base = {
		title: 'Before',
		folder: null,
		count: 3,
		payload: { a: 1, b: 2 },
		transcript: 'line one\nline two',
	};
	const file = parseRowFile(
		editField(rowFile(base, 'body'), 'title', 'After'),
	)!;
	expect(expectOk(fieldChanges(table, ['title'], base, file.fields))).toEqual({
		title: 'After',
	});
	expect(
		expectOk(
			fieldChanges(table, ['title'], base, {
				...base,
				payload: { b: 2, a: 1 },
			}),
		),
	).toEqual({});
});

test('nullable spellings are equal and removing a populated nullable field clears it', () => {
	expect(
		expectOk(fieldChanges(table, ['folder'], { folder: null }, {})),
	).toEqual({});
	expect(
		expectOk(fieldChanges(table, ['folder'], {}, { folder: null })),
	).toEqual({});
	expect(
		expectOk(fieldChanges(table, ['folder'], { folder: 'x' }, {})),
	).toEqual({ folder: null });
});

test('preflight refuses forbidden edits and required null, even for a JSON field', () => {
	expect(
		expectErr(
			fieldChanges(
				table,
				['title', 'payload'],
				{ title: 'x', payload: {} },
				{ payload: null, unknown: 1, count: 4 },
			),
		),
	).toMatchObject({
		fields: [
			{ field: 'title', reason: 'invalid-value' },
			{ field: 'payload', reason: 'invalid-value' },
			{ field: 'unknown', reason: 'undeclared' },
			{ field: 'count', reason: 'not-permitted' },
		],
	});
	expect(
		expectOk(
			fieldChanges(
				table,
				['title'],
				{ title: 'x', count: 'old invalid value' },
				{ title: 'y', count: 'old invalid value' },
			),
		),
	).toEqual({ title: 'y' });
});

test('Matter recognizes the emitted inner schema and agrees on nonempty values', () => {
	const contract = expectOk(matterContract(table));
	expect(contract.optional).toEqual(['folder']);
	for (const source of table.fields.values()) {
		const mapped = recognize(contract.fields[source.name]);
		expect(mapped?.kind).toBe(source.kind);
		const check = compile(mapped!.schema);
		for (const value of ['hello', 3, false, [], {}, ['x']])
			expect(check(value)).toBe(source.check(value));
	}
});

test('all declared field kinds map without silently losing constraints', () => {
	const all = defineApp({
		id: 'so.epicenter.all-fields',
		kv: {},
		tables: {
			rows: defineTable({
				select: field.select(['x', 'y']),
				url: field.url(),
				datetime: field.datetime(),
				instant: field.instant(),
				date: field.date(),
				integer: field.integer({ minimum: 2 }),
				number: field.number({ maximum: 10 }),
				boolean: field.boolean(),
				string: field.string({ maxLength: 5 }),
				bytes: field.string({ maxBytes: 4 }),
				reference: field.reference('rows'),
				multi: field.multiSelect(['x', 'y']),
				tags: field.tags(),
				json: field.json(jsonValue),
			}),
		},
	});
	const source = expectOk(compileData(all)).tables.get('rows')!;
	const contract = expectOk(matterContract(source));
	for (const descriptor of source.fields.values()) {
		const mapped = recognize(contract.fields[descriptor.name]);
		expect(mapped?.kind).toBe(descriptor.kind);
		for (const value of [
			'',
			'éé',
			'ééé',
			'x',
			'too-long-value',
			'https://example.com',
			'2026-09-22',
			'2026-09-22T00:00:00Z',
			1,
			3,
			20,
			true,
			[],
			['x'],
			{},
			null,
		]) {
			expect(compile(mapped!.schema)(value)).toBe(descriptor.check(value));
		}
	}
});

test('reserved Matter query columns refuse schema export', () => {
	const source = expectOk(
		compileData(
			defineApp({
				id: 'so.epicenter.collision',
				kv: {},
				tables: { notes: defineTable({ body: field.string() }) },
			}),
		),
	).tables.get('notes')!;
	expect(expectErr(matterContract(source)).name).toBe('UnsupportedField');
});

test('field names that collide in SQLite refuse schema export', () => {
	const source = expectOk(
		compileData(
			defineApp({
				id: 'so.epicenter.case-collision',
				kv: {},
				tables: {
					notes: defineTable({ title: field.string(), Title: field.string() }),
				},
			}),
		),
	).tables.get('notes')!;
	expect(expectErr(matterContract(source)).name).toBe('UnsupportedField');
});
