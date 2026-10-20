/**
 * Every supported assertion must reject a counterexample through both TypeBox
 * execution paths. This prevents the portable grammar from promising checks
 * which the app reader or the CLI validator silently ignores.
 */
import { expect, test } from 'bun:test';
import { Check } from 'typebox/value';
import { expectOk } from 'wellcrafted/testing';
import {
	compileTableSchema,
	validateTableSchema,
} from './declaration-schema.js';

const assertions: {
	keyword: string;
	schema: object;
	pass: unknown;
	fail: unknown;
}[] = [
	{ keyword: 'type', schema: { type: 'string' }, pass: 'yes', fail: 1 },
	{ keyword: 'const', schema: { const: 'yes' }, pass: 'yes', fail: 'no' },
	{
		keyword: 'enum',
		schema: { enum: ['yes', 'maybe'] },
		pass: 'yes',
		fail: 'no',
	},
	{
		keyword: 'minimum',
		schema: { type: 'number', minimum: 2 },
		pass: 2,
		fail: 1,
	},
	{
		keyword: 'maximum',
		schema: { type: 'number', maximum: 2 },
		pass: 2,
		fail: 3,
	},
	{
		keyword: 'exclusiveMinimum',
		schema: { type: 'number', exclusiveMinimum: 2 },
		pass: 3,
		fail: 2,
	},
	{
		keyword: 'exclusiveMaximum',
		schema: { type: 'number', exclusiveMaximum: 2 },
		pass: 1,
		fail: 2,
	},
	{
		keyword: 'multipleOf',
		schema: { type: 'number', multipleOf: 2 },
		pass: 4,
		fail: 3,
	},
	{
		keyword: 'minLength',
		schema: { type: 'string', minLength: 2 },
		pass: 'ab',
		fail: 'a',
	},
	{
		keyword: 'maxLength',
		schema: { type: 'string', maxLength: 2 },
		pass: 'ab',
		fail: 'abc',
	},
	{
		keyword: 'pattern',
		schema: { type: 'string', pattern: '^a' },
		pass: 'ab',
		fail: 'ba',
	},
	{
		keyword: 'properties',
		schema: { type: 'object', properties: { a: { type: 'string' } } },
		pass: { a: 'x' },
		fail: { a: 1 },
	},
	{
		keyword: 'patternProperties',
		schema: { type: 'object', patternProperties: { '^a': { type: 'string' } } },
		pass: { a: 'x' },
		fail: { a: 1 },
	},
	{
		keyword: 'required',
		schema: { type: 'object', required: ['a'] },
		pass: { a: 1 },
		fail: {},
	},
	{
		keyword: 'additionalProperties',
		schema: { type: 'object', additionalProperties: { type: 'number' } },
		pass: { a: 1 },
		fail: { a: 'x' },
	},
	{
		keyword: 'propertyNames',
		schema: { type: 'object', propertyNames: { pattern: '^a' } },
		pass: { a: 1 },
		fail: { b: 1 },
	},
	{
		keyword: 'minProperties',
		schema: { type: 'object', minProperties: 1 },
		pass: { a: 1 },
		fail: {},
	},
	{
		keyword: 'maxProperties',
		schema: { type: 'object', maxProperties: 1 },
		pass: { a: 1 },
		fail: { a: 1, b: 2 },
	},
	{
		keyword: 'dependentRequired',
		schema: { type: 'object', dependentRequired: { a: ['b'] } },
		pass: { a: 1, b: 2 },
		fail: { a: 1 },
	},
	{
		keyword: 'dependentSchemas',
		schema: { type: 'object', dependentSchemas: { a: { required: ['b'] } } },
		pass: { a: 1, b: 2 },
		fail: { a: 1 },
	},
	{
		keyword: 'items',
		schema: { type: 'array', items: { type: 'string' } },
		pass: ['a'],
		fail: [1],
	},
	{
		keyword: 'prefixItems',
		schema: { type: 'array', prefixItems: [{ type: 'string' }] },
		pass: ['a'],
		fail: [1],
	},
	{
		keyword: 'contains',
		schema: { type: 'array', contains: { type: 'number' } },
		pass: ['a', 1],
		fail: ['a'],
	},
	{
		keyword: 'minContains',
		schema: { type: 'array', contains: { type: 'number' }, minContains: 2 },
		pass: [1, 2],
		fail: [1],
	},
	{
		keyword: 'maxContains',
		schema: { type: 'array', contains: { type: 'number' }, maxContains: 1 },
		pass: [1],
		fail: [1, 2],
	},
	{
		keyword: 'minItems',
		schema: { type: 'array', minItems: 1 },
		pass: [1],
		fail: [],
	},
	{
		keyword: 'maxItems',
		schema: { type: 'array', maxItems: 1 },
		pass: [1],
		fail: [1, 2],
	},
	{
		keyword: 'uniqueItems',
		schema: { type: 'array', uniqueItems: true },
		pass: [1, 2],
		fail: [1, 1],
	},
	{
		keyword: 'allOf',
		schema: { allOf: [{ type: 'number' }, { minimum: 2 }] },
		pass: 2,
		fail: 1,
	},
	{
		keyword: 'anyOf',
		schema: { anyOf: [{ type: 'number' }, { type: 'boolean' }] },
		pass: 2,
		fail: 'x',
	},
	{
		keyword: 'oneOf',
		schema: { oneOf: [{ type: 'number' }, { minimum: 2 }] },
		pass: 1,
		fail: 2,
	},
	{ keyword: 'not', schema: { not: { type: 'number' } }, pass: 'x', fail: 1 },
	{
		keyword: 'if/then',
		schema: { if: { type: 'number' }, then: { minimum: 2 } },
		pass: 2,
		fail: 1,
	},
	{
		keyword: 'if/else',
		schema: { if: { type: 'number' }, else: { type: 'string' } },
		pass: 'x',
		fail: true,
	},
	{
		keyword: '$defs/$ref',
		schema: { $defs: { value: { type: 'string' } }, $ref: '#/$defs/value' },
		pass: 'x',
		fail: 1,
	},
	{
		keyword: 'definitions/$ref',
		schema: {
			definitions: { value: { type: 'string' } },
			$ref: '#/definitions/value',
		},
		pass: 'x',
		fail: 1,
	},
];

for (const { keyword, schema, pass, fail } of assertions) {
	test(`${keyword} enforces its assertion in compiled and interpreted validation`, () => {
		// Reference scopes here are at the complete table root.
		const table = expectOk(
			validateTableSchema({
				type: 'object',
				properties: { value: { $id: 'field', ...schema } },
				required: ['value'],
			}),
		);
		const validator = compileTableSchema(table);
		expect(validator.Check({ value: pass })).toBe(true);
		expect(validator.Check({ value: fail })).toBe(false);
		expect(Check(table, { value: pass })).toBe(true);
		expect(Check(table, { value: fail })).toBe(false);
	});
}

const formatCases: [string, string, string][] = [
	['date-time', '2026-10-20T12:30:00Z', 'not a date'],
	['date', '2026-10-20', '2026-15-40'],
	['duration', 'P3D', 'three days'],
	['email', 'a@example.com', 'no-at-sign'],
	['hostname', 'example.com', 'bad host'],
	['idn-email', 'a@example.com', 'no-at-sign'],
	['idn-hostname', 'example.com', 'bad host'],
	['ipv4', '127.0.0.1', '999.0.0.1'],
	['ipv6', '::1', '::invalid'],
	['iri-reference', '/notes', 'bad uri'],
	['iri', 'https://example.com/é', 'bad uri'],
	['json-pointer-uri-fragment', '#/notes/0', '#notes'],
	['json-pointer', '/notes/0', 'notes/0'],
	['regex', '^[a-z]+$', '['],
	['relative-json-pointer', '0/name', 'next'],
	['time', '12:30:00Z', '25:00'],
	['uri-reference', '/notes', 'bad uri'],
	['uri-template', '/notes/{id}', '/notes/{id'],
	['uri', 'https://example.com/notes', 'bad uri'],
	['url', 'https://example.com', 'bad url'],
	['uuid', '550e8400-e29b-41d4-a716-446655440000', 'bad uuid'],
];
for (const [format, pass, fail] of formatCases) {
	test(`portable format ${format} is enforced by both validation paths`, () => {
		const table = expectOk(
			validateTableSchema({
				type: 'object',
				properties: { value: { type: 'string', format } },
			}),
		);
		const validator = compileTableSchema(table);
		expect(validator.Check({ value: pass })).toBe(true);
		expect(validator.Check({ value: fail })).toBe(false);
		expect(Check(table, { value: pass })).toBe(true);
		expect(Check(table, { value: fail })).toBe(false);
	});
}
