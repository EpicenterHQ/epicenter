/**
 * App data composition retains the given handles and their inferred fields.
 * Data and collections are alternatives at both typed and untyped boundaries.
 */
import { expect, test } from 'bun:test';
import { defineApp, defineData, field } from './index.ts';

test('an app accepts data and returns the same object and typed handles', () => {
	const data = defineData({ notes: { fields: { title: field.text() } } });
	const given = { description: 'Notes', data, actions: {} };
	const app = defineApp(given);
	expect(app).toBe(given);
	expect(app.data.notes).toBe(data.notes);
	expect(app.data.notes.pathOf('one')).toBe('data/notes/one.md');
	expect(app).not.toHaveProperty('collections');
});

test('an app refuses both data and collections, including empty declarations', () => {
	const given = {
		description: 'Both',
		data: defineData({}),
		collections: {},
		actions: {},
	};
	// @ts-expect-error an app declares one data model
	expect(() => defineApp(given)).toThrow(
		'An app declares data or collections, not both',
	);
});

test('an app still requires collections when no data is declared', () => {
	// @ts-expect-error an app needs data or collections
	expect(() => defineApp({ description: 'Neither', actions: {} })).toThrow(
		'An app needs collections: an object of defineCollection(...), {} for none',
	);
	expect(() =>
		defineApp({ description: 'Bad', data: null, actions: {} } as never),
	).toThrow('An app needs data: the value returned by defineData(...)');
});

test('an app refuses plain definitions and malformed data keys as handles', () => {
	expect(() =>
		defineApp({
			description: 'Bad',
			data: { notes: { fields: {} } },
			actions: {},
		} as never),
	).toThrow('data.notes is not a handle from defineData(...)');
	const data = defineData({ notes: { fields: {} } });
	expect(() =>
		defineApp({ description: 'Bad', data: { Notes: data.notes }, actions: {} }),
	).toThrow(
		'data has the key "Notes", which must be a name, optionally followed by .md',
	);
});
