/**
 * Lens Authoring Helper Tests
 *
 * Verifies canonical pure-JSON output and authoring-time semantic guards.
 *
 * Key behaviors:
 * - Definitions are deeply frozen JSON with durable identity in map keys
 * - Optional names are unique known field keys
 * - Namespace, local-key, reserved-name, and vocabulary rules fail early
 */
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { Type } from 'typebox';

import { defineLens, defineTable, defineValues } from './definitions.js';

test('authoring helpers return deeply frozen pure JSON without repeated keys', () => {
	const lens = defineLens({
		namespace: 'so.epicenter.notes',
		title: 'Notes',
		description: 'A note Lens.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: { title: field.string(), note: field.string() },
				optional: ['note'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: { theme: field.select(['light', 'dark']) },
			}),
		},
	});

	expect(JSON.parse(JSON.stringify(lens))).toEqual(lens);
	expect(Object.isFrozen(lens)).toBe(true);
	expect(Object.isFrozen(lens.collections.notes.fields.title)).toBe(true);
	expect(lens.collections.notes).not.toHaveProperty('key');
	expect(lens.collections.notes.fields.title).not.toHaveProperty('key');
});

test('defineTable rejects unknown and duplicate optional entries', () => {
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: ['missing'] as never,
		}),
	).toThrow("Unknown optional field 'missing'");
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: ['title', 'title'],
		}),
	).toThrow("Duplicate optional field 'title'");
});

test('authoring helpers reject invalid grammar, reserved fields, and foreign schemas', () => {
	expect(() =>
		defineLens({
			namespace: 'Notes',
			title: 'Notes',
			description: 'Bad namespace.',
			collections: {},
		}),
	).toThrow("Invalid Lens namespace 'Notes'");
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { 'bad-field': field.string() },
		}),
	).toThrow("Invalid field key 'bad-field'");
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { ID: field.string() },
		}),
	).toThrow("reserved name 'ID'");
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { title: Type.Object({ nested: Type.String() }) },
		}),
	).toThrow('field.* vocabulary');
});

test('defineValues canonicalizes schemas and enforces record-key grammar', () => {
	const values = defineValues({
		title: 'Settings',
		description: 'User settings.',
		values: { theme: field.string() },
	});
	expect(values as unknown).toEqual({
		kind: 'values',
		title: 'Settings',
		description: 'User settings.',
		values: { theme: { type: 'string' } },
	});
	expect(() =>
		defineValues({
			title: 'Settings',
			values: { 'bad-key': field.string() },
		}),
	).toThrow("Invalid value key 'bad-key'");
	expect(
		defineValues({ title: 'Identity', values: { id: field.string() } }),
	).toMatchObject({
		values: { id: { type: 'string' } },
	});
});

test('values record keys admit dotted segments; collection and field keys do not', () => {
	expect(
		defineValues({
			title: 'Settings',
			values: { 'transcription.language': field.string() },
		}),
	).toMatchObject({
		values: { 'transcription.language': { type: 'string' } },
	});
	expect(() =>
		defineValues({
			title: 'Settings',
			values: { 'transcription.': field.string() },
		}),
	).toThrow("Invalid value key 'transcription.'");
	expect(() =>
		defineValues({
			title: 'Settings',
			values: { '.language': field.string() },
		}),
	).toThrow("Invalid value key '.language'");
	expect(() =>
		defineTable({
			title: 'Notes',
			fields: { 'note.body': field.string() },
		}),
	).toThrow("Invalid field key 'note.body'");
	expect(() =>
		defineLens({
			namespace: 'so.epicenter.notes',
			title: 'Notes',
			description: 'Dotted collection keys are refused.',
			collections: {
				'notes.archive': defineTable({
					title: 'Notes',
					fields: { title: field.string() },
				}),
			},
		}),
	).toThrow("Invalid collection key 'notes.archive'");
});
