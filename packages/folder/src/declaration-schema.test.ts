/**
 * Portable declaration validation checks document shape and complete schema scope.
 * Table readers interpret their own sections, so unrelated malformed
 * metadata cannot hide readable tables.
 */
import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { parseDeclaration, readDeclaredTables } from './declaration.js';
import {
	compileTableSchema,
	DeclarationSchema,
	validateTableSchema,
} from './declaration-schema.js';
import { parseDeclaredRow } from './row-text.js';

test('tables and named views are independently optional and the generated schema matches runtime validation', async () => {
	for (const value of [
		{},
		{ tables: {} },
		{ views: { all: { type: 'sql', title: 'All rows', sql: 'select 1' } } },
		{ views: {}, tables: {} },
	]) {
		expect(Check(DeclarationSchema, value)).toBe(true);
		expect<unknown>(expectOk(parseDeclaration(JSON.stringify(value)))).toEqual(
			value,
		);
	}
	expect(
		JSON.parse(
			await readFile(
				new URL('../epicenter.schema.json', import.meta.url),
				'utf8',
			),
		),
	).toEqual(JSON.parse(JSON.stringify(DeclarationSchema)));
	expectErr(
		parseDeclaration('{"views":{"all":{"type":"sql","title":"All rows"}}}'),
	);
});

test('table reading survives malformed views and removed policy keys are refused', () => {
	const value = {
		views: { invalid: null },
		tables: {
			notes: { type: 'object', properties: { title: { type: 'string' } } },
		},
	};
	expect<unknown>(expectOk(readDeclaredTables(JSON.stringify(value)))).toEqual(
		value.tables,
	);
	expectErr(parseDeclaration(JSON.stringify(value)));
	expect(expectErr(parseDeclaration('{"local":["audio/"]}')).reason).toContain(
		'unknown top-level key',
	);
});

test('complete table schemas keep root definitions, constraints, and annotations without a field-map roundtrip', () => {
	const table = {
		type: 'object',
		title: 'Notes',
		description: 'Keep this annotation',
		$defs: { title: { type: 'string', minLength: 3 } },
		properties: { title: { $ref: '#/$defs/title' } },
		required: ['title'],
		additionalProperties: false,
	};
	const declaration = expectOk(
		parseDeclaration(JSON.stringify({ tables: { notes: table } })),
	);
	const reread = declaration.tables!.notes!;
	expect<unknown>(reread).toEqual(table);
	expect(
		expectOk(parseDeclaredRow(reread, '---\ntitle: Hello\n---\nBody')),
	).toEqual({ fields: { title: 'Hello' }, body: 'Body' });
	expectErr(parseDeclaredRow(reread, '---\ntitle: Hi\n---\n'));
	expectErr(parseDeclaredRow(reread, '---\ntitle: Hello\nextra: false\n---\n'));
});

test('unsupported nested schema grammar and unresolved references fail before any rows are read', () => {
	for (const field of [
		{ type: 'made-up' },
		{ properties: { nested: { type: 'made-up' } } },
		{ $ref: '#/$defs/missing' },
		{ $ref: 'missing' },
		{ format: 'made-up' },
		{ '~optional': true, type: 'string' },
		{ pattern: '[' },
	]) {
		expectErr(
			parseDeclaration(
				JSON.stringify({
					tables: { notes: { type: 'object', properties: { title: field } } },
				}),
			),
		);
	}
	const schema = {
		type: 'object',
		properties: {
			data: { const: { type: 'made-up', $ref: 'data, not a schema' } },
		},
	};
	expectOk(parseDeclaration(JSON.stringify({ tables: { notes: schema } })));
});

test('references cannot escape schema positions into const or default data', () => {
	for (const keyword of ['const', 'default', 'examples']) {
		const data =
			keyword === 'examples' ? [{ type: 'made-up' }] : { type: 'made-up' };
		const ref = `#/$defs/data/${keyword}${keyword === 'examples' ? '/0' : ''}`;
		expectErr(
			parseDeclaration(
				JSON.stringify({
					tables: {
						notes: {
							type: 'object',
							$defs: { data: { [keyword]: data } },
							properties: { value: { $ref: ref } },
						},
					},
				}),
			),
		);
	}
	const table = expectOk(
		validateTableSchema({
			type: 'object',
			$defs: { allowed: true, forbidden: false },
			properties: { value: { $ref: '#/$defs/allowed' } },
		}),
	);
	expect(compileTableSchema(table).Check({ value: 3 })).toBe(true);
});

test('preparation owns frozen snapshots and never caches mutable caller schemas', () => {
	const source = { type: 'object', properties: { value: { type: 'string' } } };
	const first = expectOk(validateTableSchema(source));
	Object.assign(source.properties.value, { type: 'number' });
	const second = expectOk(validateTableSchema(source));
	expect(Object.isFrozen(first.properties.value)).toBe(true);
	expect(compileTableSchema(first).Check({ value: 'kept' })).toBe(true);
	expect(compileTableSchema(first).Check({ value: 3 })).toBe(false);
	expect(compileTableSchema(second).Check({ value: 3 })).toBe(true);
	expect(first).not.toBe(source);
});

test('the portable grammar uses draft 2020 tuple spellings and validator failures remain row issues', () => {
	expect(Reflect.get(DeclarationSchema, '$schema')).toBe(
		'https://json-schema.org/draft/2020-12/schema',
	);
	for (const schema of [
		{ type: 'array', items: [{ type: 'string' }] },
		{ type: 'array', additionalItems: false },
	]) {
		expectErr(
			validateTableSchema({ type: 'object', properties: { value: schema } }),
		);
	}
	const recursive = expectOk(
		validateTableSchema({ type: 'object', properties: {}, $ref: '#' }),
	);
	expect(
		expectErr(parseDeclaredRow(recursive, '---\n---\n'))[0]?.message,
	).toContain('could not be validated');
});

test('direct table validation refuses hidden runtime behavior without running it', () => {
	let called = false;
	const refined = Type.Refine(Type.String(), () => {
		called = true;
		return true;
	});
	expectErr(validateTableSchema(Type.Object({ value: refined })));
	expect(called).toBe(false);
});
