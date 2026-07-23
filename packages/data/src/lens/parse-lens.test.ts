/**
 * Lens Parser Tests
 *
 * Verifies that arbitrary JSON enters through one closed legitimacy law.
 *
 * Key behaviors:
 * - Authored and serialized Lenses round-trip to one canonical shape
 * - Outer and collection objects reject unknown or missing properties
 * - Grammar, field vocabulary, reserved properties, and optional relationships are enforced
 */
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { defineLens, defineTable, defineValues } from './definitions.js';
import { parseLens } from './parse-lens.js';

function validLens() {
	return defineLens({
		namespace: 'so.epicenter.tests',
		title: 'Tests',
		description: 'Parser fixture.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: { title: field.string(), note: field.string() },
				optional: ['note'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: { theme: field.string() },
			}),
		},
	});
}

test('stringify, parse, and parseLens reproduce the authored Lens exactly', () => {
	const lens = validLens();
	const parsed = expectOk(parseLens(JSON.parse(JSON.stringify(lens))));
	expect(parsed).toEqual(lens);
	const notes = parsed.collections.notes;
	if (notes?.kind !== 'table') throw new Error('Expected notes table');
	expect(Object.isFrozen(notes.fields.title)).toBe(true);
});

test('closed outer, table, and values shapes report their exact boundary', () => {
	const outer = { ...structuredClone(validLens()), extra: true };
	expect(expectErr(parseLens(outer))).toMatchObject({
		name: 'InvalidShape',
		path: 'lens',
	});

	const table = structuredClone(validLens()) as Record<string, unknown>;
	const collections = table.collections as Record<
		string,
		Record<string, unknown>
	>;
	collections.notes!.extra = true;
	expect(expectErr(parseLens(table))).toMatchObject({
		name: 'InvalidShape',
		path: 'lens.collections.notes',
	});

	const values = structuredClone(validLens()) as Record<string, unknown>;
	const valueCollections = values.collections as Record<
		string,
		Record<string, unknown>
	>;
	valueCollections.settings!.extra = true;
	expect(expectErr(parseLens(values))).toMatchObject({
		name: 'InvalidShape',
		path: 'lens.collections.settings',
	});
});

test('grammar failures identify namespace, collection, value, and field keys', () => {
	const namespace = structuredClone(validLens()) as Record<string, unknown>;
	namespace.namespace = 'Epicenter.Tests';
	expect(expectErr(parseLens(namespace)).name).toBe('InvalidNamespace');

	const collection = structuredClone(validLens()) as Record<string, unknown>;
	const collectionMap = collection.collections as Record<string, unknown>;
	collectionMap['bad-key'] = collectionMap.notes;
	delete collectionMap.notes;
	expect(expectErr(parseLens(collection))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'bad-key',
	});

	const value = structuredClone(validLens()) as Record<string, unknown>;
	const valueMap = (
		value.collections as Record<string, Record<string, unknown>>
	).settings!.values as Record<string, unknown>;
	valueMap['bad-key'] = valueMap.theme;
	delete valueMap.theme;
	expect(expectErr(parseLens(value))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'bad-key',
	});

	const fieldName = structuredClone(validLens()) as Record<string, unknown>;
	const fields = (
		fieldName.collections as Record<string, Record<string, unknown>>
	).notes!.fields as Record<string, unknown>;
	fields['bad-field'] = fields.title;
	delete fields.title;
	expect(expectErr(parseLens(fieldName))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'bad-field',
	});
});

test('values record keys admit dotted segments; collection and field keys do not', () => {
	const dotted = defineLens({
		namespace: 'so.epicenter.tests',
		title: 'Tests',
		description: 'Dotted values keys.',
		collections: {
			settings: defineValues({
				title: 'Settings',
				values: { 'transcription.language': field.string() },
			}),
		},
	});
	const parsed = expectOk(parseLens(JSON.parse(JSON.stringify(dotted))));
	expect(parsed).toEqual(dotted);

	const value = structuredClone(validLens()) as Record<string, unknown>;
	const valueMap = (
		value.collections as Record<string, Record<string, unknown>>
	).settings!.values as Record<string, unknown>;
	valueMap['double..dot'] = valueMap.theme;
	delete valueMap.theme;
	expect(expectErr(parseLens(value))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'double..dot',
	});

	const fieldName = structuredClone(validLens()) as Record<string, unknown>;
	const fields = (
		fieldName.collections as Record<string, Record<string, unknown>>
	).notes!.fields as Record<string, unknown>;
	fields['note.body'] = fields.title;
	delete fields.title;
	expect(expectErr(parseLens(fieldName))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'note.body',
	});

	const collection = structuredClone(validLens()) as Record<string, unknown>;
	const collectionMap = collection.collections as Record<string, unknown>;
	collectionMap['settings.audio'] = collectionMap.settings;
	delete collectionMap.settings;
	expect(expectErr(parseLens(collection))).toMatchObject({
		name: 'InvalidLocalKey',
		key: 'settings.audio',
	});
});

test('reserved field names and nested reserved schema properties are rejected', () => {
	const named = structuredClone(validLens()) as Record<string, unknown>;
	const fields = (named.collections as Record<string, Record<string, unknown>>)
		.notes!.fields as Record<string, unknown>;
	fields.KEY = fields.title;
	delete fields.title;
	expect(expectErr(parseLens(named))).toMatchObject({
		name: 'ReservedName',
		key: 'KEY',
	});

	const nested = structuredClone(validLens()) as Record<string, unknown>;
	const nestedFields = (
		nested.collections as Record<string, Record<string, unknown>>
	).notes!.fields as Record<string, Record<string, unknown>>;
	nestedFields.title!.ID = 'hidden';
	expect(expectErr(parseLens(nested))).toMatchObject({
		name: 'NestedReservedProperty',
		property: 'ID',
	});
});

test('unrecognized schemas and invalid optional lists report concrete errors', () => {
	const schema = structuredClone(validLens()) as Record<string, unknown>;
	const fields = (schema.collections as Record<string, Record<string, unknown>>)
		.notes!.fields as Record<string, unknown>;
	fields.title = { type: 'object' };
	expect(expectErr(parseLens(schema)).name).toBe('UnrecognizedField');

	const unknown = structuredClone(validLens()) as Record<string, unknown>;
	const unknownNotes = (
		unknown.collections as Record<string, Record<string, unknown>>
	).notes!;
	unknownNotes.optional = ['missing'];
	expect(expectErr(parseLens(unknown))).toMatchObject({
		name: 'UnknownOptionalField',
		field: 'missing',
	});

	const duplicate = structuredClone(validLens()) as Record<string, unknown>;
	const duplicateNotes = (
		duplicate.collections as Record<string, Record<string, unknown>>
	).notes!;
	duplicateNotes.optional = ['note', 'note'];
	expect(expectErr(parseLens(duplicate))).toMatchObject({
		name: 'DuplicateOptionalField',
		field: 'note',
	});
});

test('objects with hidden non-JSON state are rejected before shape validation', () => {
	const lens = structuredClone(validLens());
	Object.defineProperty(lens, 'hidden', { value: true, enumerable: false });
	expect(expectErr(parseLens(lens))).toMatchObject({
		name: 'InvalidShape',
		path: 'lens',
		expected: 'pure JSON',
	});
});
