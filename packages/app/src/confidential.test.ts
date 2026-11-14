/**
 * Confidentiality is explicit action metadata, independent of schema content.
 * Schema annotations pass through unchanged, and declarations still require
 * finite JSON so malformed graphs cannot break discovery.
 */
import { expect, test } from 'bun:test';
import { type TSchema, Type } from 'typebox';
import { defineAction } from './action.js';
import { defineCollection } from './collection.js';
import { field } from './field.js';

test('confidentiality is a property of the action, not its fields', () => {
	const action = defineAction({
		description: 'Connect',
		confidential: true,
		input: { credentials: Type.Object({ token: field.text() }) },
		positional: ['credentials'],
		run: () => true,
	});
	expect(action.confidential).toBe(true);
	expect(action.input).toHaveProperty(
		'credentials.properties.token.type',
		'string',
	);
	expect(action.input).not.toHaveProperty(
		'credentials.properties.token.writeOnly',
	);
});

test('raw schema annotations and literal values do not classify actions or restrict collections', () => {
	for (const schema of [
		Type.String({ writeOnly: true }),
		Type.Object({}, { default: { writeOnly: true } }),
		Type.String({ examples: [{ writeOnly: true }] }),
		{ const: { writeOnly: true } },
		{ enum: [{ writeOnly: true }] },
		{ extension: { '': { writeOnly: true } } },
	]) {
		const action = defineAction({
			description: 'Read',
			input: { value: schema },
			run: () => true,
		});
		expect(action.confidential).toBeUndefined();
		const collection = defineCollection({
			path: 'data/records/{id}.md',
			fields: { value: schema },
		});
		expect(collection.fields.value).toEqual(schema);
	}
});

test('a false flag stays ordinary and a malformed flag is refused at declaration', () => {
	const action = defineAction({
		description: 'Read',
		confidential: false,
		input: {},
		run: () => true,
	});
	expect(action.confidential).toBe(false);
	expect(() =>
		defineAction({
			description: 'Read',
			confidential: 'true' as unknown as boolean,
			input: {},
			run: () => true,
		}),
	).toThrow('confidential flag that is not a boolean');
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
	expect(action.confidential).toBeUndefined();
});
