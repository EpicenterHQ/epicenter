/**
 * A reserved writeOnly marker anywhere in schema JSON makes the whole action
 * confidential. Nested and positional markers are valid; collections refuse
 * them, and cyclic schema graphs fail before they can enter discovery.
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { defineAction } from './action.js';
import { defineCollection } from './collection.js';
import { containsWriteOnly, field } from './field.js';

const secret = field.text({ writeOnly: true });

test('a write-only text field carries its JSON Schema marker', () => {
	expect(secret).toMatchObject({ type: 'string', writeOnly: true });
	expect(containsWriteOnly(field.text())).toBe(false);
});

test('nested and positional secret inputs remain ordinary action definitions', () => {
	const action = defineAction({
		description: 'Connect',
		input: { credentials: Type.Object({ token: secret }) },
		positional: ['credentials'],
		run: () => true,
	});
	expect(containsWriteOnly(action.input)).toBe(true);
});

test('the marker is reserved in schema data and arbitrary metadata too', () => {
	for (const schema of [
		Type.Object({}, { default: { writeOnly: true } }),
		Type.String({ examples: [{ writeOnly: true }] }),
		{ const: { writeOnly: true } },
		{ enum: [{ writeOnly: true }] },
		{ extension: { '': { writeOnly: true } } },
	]) {
		expect(containsWriteOnly(schema)).toBe(true);
		expect(() =>
			defineCollection({
				path: 'data/records/{id}.md',
				fields: { value: schema },
			}),
		).toThrow('write-only field "value"');
	}
});

test('a property name, false marker, or JSON-looking text does not classify an action', () => {
	for (const schema of [
		Type.Object({ writeOnly: Type.Boolean() }),
		{ type: 'string', writeOnly: false },
		{ type: 'string', description: '{"writeOnly":true}' },
	])
		expect(containsWriteOnly(schema)).toBe(false);
});

test('cyclic schemas fail when actions and collections are declared', () => {
	const schema: { type: string; properties: Record<string, TSchema> } = {
		type: 'object',
		properties: {},
	};
	schema.properties.self = schema;
	expect(() =>
		defineAction({
			description: 'Read',
			input: { value: schema },
			run: () => true,
		}),
	).toThrow();
	expect(() =>
		defineCollection({
			path: 'data/records/{id}.md',
			fields: { value: schema },
		}),
	).toThrow();
});

test('a finite recursive schema using a local reference stays valid', () => {
	const action = defineAction({
		description: 'Read',
		input: {
			value: {
				$defs: {
					node: {
						type: 'object',
						properties: { next: { $ref: '#/$defs/node' } },
					},
				},
				$ref: '#/$defs/node',
			},
		},
		run: () => true,
	});
	expect(containsWriteOnly(action.input)).toBe(false);
});
