/**
 * Secret inputs are whole top-level fields, where every calling surface can
 * recognize them. Definitions refuse uncovered nested writeOnly markers
 * without mistaking literal defaults, examples, or property names for markers.
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { defineAction } from './action.js';
import { defineCollection } from './collection.js';
import { field, writeOnlyKeys } from './field.js';

const secret = field.text({ writeOnly: true });

test('a write-only field carries JSON Schema writeOnly, and only text takes it', () => {
	expect(secret).toMatchObject({ type: 'string', writeOnly: true });
	expect(field.text()).not.toHaveProperty('writeOnly');
});

test('an action refuses a write-only positional, and a collection refuses a write-only field', () => {
	expect(() =>
		defineAction({
			description: 'Connect',
			input: { token: secret },
			positional: ['token'],
			run: () => true,
		}),
	).toThrow('write-only "token" as a positional');
	expect(() =>
		defineCollection({
			path: 'data/keys/{name}.md',
			fields: { token: secret },
		}),
	).toThrow('write-only field "token"');
});

const nested: [string, TSchema][] = [
	['object', Type.Object({ token: secret })],
	['union', Type.Union([secret, Type.Null()])],
	['intersection', Type.Intersect([Type.String(), secret])],
	['array', Type.Array(secret)],
	['tuple', Type.Tuple([secret])],
	['record', Type.Record(Type.String(), secret)],
	['definition', { $defs: { token: secret }, $ref: '#/$defs/token' }],
	['conditional', Type.String({ if: secret })],
	[
		'encoded content',
		Type.String({ contentSchema: Type.Object({ token: secret }) }),
	],
	['property named default', Type.Object({ default: secret })],
];

test.each(nested)(
	'an action refuses a nested write-only marker: %s',
	(_name, schema) => {
		expect(() =>
			defineAction({
				description: 'Connect',
				input: { credentials: schema },
				run: () => true,
			}),
		).toThrow('"credentials" with a write-only part inside it');
	},
);

test('an action refuses a nested secret before it can become a positional commit name', () => {
	expect(() =>
		defineAction({
			description: 'Connect',
			input: { credentials: Type.Object({ token: secret }) },
			positional: ['credentials'],
			run: () => true,
		}),
	).toThrow('"credentials" with a write-only part inside it');
});

test('a root write-only mark covers a whole field, including its nested parts', () => {
	for (const schema of [
		Type.Number({ writeOnly: true }),
		Type.Object({}, { writeOnly: true }),
		Type.Union([Type.String(), Type.Null()], { writeOnly: true }),
		Type.Object({ token: secret }, { writeOnly: true }),
	]) {
		const action = defineAction({
			description: 'Connect',
			input: { token: schema },
			run: () => true,
		});
		expect(writeOnlyKeys(action.input)).toEqual(['token']);
	}
});

test('top-level raw and optional text secrets keep their write-only mark', () => {
	for (const schema of [
		Type.String({ writeOnly: true }),
		field.text({ writeOnly: true, optional: true }),
	]) {
		const action = defineAction({
			description: 'Connect',
			input: { token: schema },
			run: () => true,
		});
		expect(writeOnlyKeys(action.input)).toEqual(['token']);
	}
});

test('literal data and a property named writeOnly do not mark an action as secret', () => {
	for (const schema of [
		Type.Object({ writeOnly: Type.Boolean() }),
		Type.Object({}, { default: { writeOnly: true } }),
		Type.Object({}, { examples: [{ writeOnly: true }] }),
		{ const: { writeOnly: true } },
		{ enum: [{ writeOnly: true }] },
	]) {
		const action = defineAction({
			description: 'Read data',
			input: { value: schema },
			run: () => true,
		});
		expect(writeOnlyKeys(action.input)).toEqual([]);
	}
});

test('a collection refuses a nested write-only field because reads return every part', () => {
	expect(() =>
		defineCollection({
			path: 'data/connections/{name}.md',
			fields: { credentials: Type.Object({ token: secret }) },
		}),
	).toThrow('write-only field "credentials"');
});
