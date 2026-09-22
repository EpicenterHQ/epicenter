/**
 * Declaration compilation preserves codecs and compiles trusted field schemas.
 * Key behaviors: malformed codecs and compiler failures report errors; nullable
 * wrappers remain closed; conformance requires stored fields to be present.
 */
import { expect, test } from 'bun:test';
import { defineApp } from '@epicenter/app';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { compileData } from './compile.js';
import { plainText } from './content.js';
import { field } from './declaration.js';
import { defineTable } from './define.js';

const database = defineApp({
	id: 'so.epicenter.data',
	kv: { name: field.string() },
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

test('trusted TypeScript definitions compile and retain their codecs', () => {
	const result = expectOk(compileData(database));
	expect(result.tables.get('notes')?.content).toBeDefined();
	expect([...(result.tables.get('notes')?.fields.keys() ?? [])]).toEqual([
		'title',
	]);
});

test('compilation is memoized by definition identity', () => {
	expect(compileData(database)).toBe(compileData(database));
});

test('omitting a codec compiles only the declared fields', () => {
	const definition = defineApp({
		id: 'so.epicenter.fields-only',
		kv: {},
		tables: {
			queries: defineTable({ name: field.string(), sql: field.string() }),
		},
	});
	const table = expectOk(compileData(definition)).tables.get('queries');
	expect(table?.content).toBeUndefined();
	expect([...table!.fields.keys()]).toEqual(['name', 'sql']);
});

test('an explicitly malformed codec is refused at compilation', () => {
	for (const content of [undefined, null, {}, { encode() {}, decode() {} }]) {
		expect(() =>
			defineApp({
				id: 'so.epicenter.invalid-codec',
				kv: {},
				tables: {
					// @ts-expect-error malformed table also fails the branded definition contract
					notes: defineTable({
						// @ts-expect-error exercise the runtime declaration boundary
						content,
					}),
				},
			}),
		).toThrow('invalid content codec');
	}
});

test('unserializable or non-finite field descriptors return a malformed declaration error', () => {
	const cycle: Record<string, unknown> = { type: 'string' };
	cycle.self = cycle;
	for (const descriptor of [
		cycle,
		{ type: 'string', bad: 1n },
		{ type: 'number', minimum: Infinity },
		{ type: 'string', bad: Symbol('bad') },
	]) {
		const result = compileData({
			id: 'test.invalid',
			tables: {},
			kv: { value: descriptor },
		});
		expect(expectErr(result).name).toBe('Malformed');
	}
});

test('field compiler failures identify the table and field', () => {
	const error = expectErr(
		compileData({
			id: 'test.invalid-pattern',
			kv: {},
			tables: {
				notes: { title: field.json({ type: 'string', pattern: '[' }) },
			},
		}),
	);
	expect(error).toMatchObject({
		name: 'UnrecognizedField',
		table: 'notes',
		field: 'title',
	});
	expect(error.message).toContain('regular expression');
});

test('nullable wrappers refuse extra keywords that would otherwise be ignored', () => {
	const error = expectErr(
		compileData({
			id: 'test.invalid-nullable',
			kv: { title: { ...field.nullable(field.string()), maxLength: 2 } },
			tables: {},
		}),
	);
	expect(error).toMatchObject({
		name: 'UnrecognizedField',
		table: 'kv',
		field: 'title',
	});
});

test('nullable fields accept explicit null but still require stored presence', () => {
	const definition = expectOk(
		compileData({
			id: 'test.nullable',
			kv: { title: field.nullable(field.string()) },
			tables: {},
		}),
	);
	expect(definition.kv.conformance({ title: null })).toEqual({
		conforming: { title: null },
		issues: [],
	});
	expect(definition.kv.conformance({}).issues).toEqual([
		{ field: 'title', message: 'title is missing' },
	]);
});

test('trusted JSON fields retain compiler support for local schema references', () => {
	const definition = expectOk(
		compileData({
			id: 'test.json-reference',
			kv: {
				value: field.json({
					$defs: { text: { type: 'string', minLength: 2 } },
					$ref: '#/$defs/text',
				}),
			},
			tables: {},
		}),
	);
	expect(definition.kv.conformance({ value: 'yes' }).issues).toEqual([]);
	expect(definition.kv.conformance({ value: 'x' }).issues).toHaveLength(1);
});
