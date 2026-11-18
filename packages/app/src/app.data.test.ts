/**
 * App data composition retains the given handles and their inferred fields.
 */
import { expect, test } from 'bun:test';
import { defineApp, defineData, type Folder, field } from './index.ts';

/** The apps here only declare, so the folder they are handed is never used. */
const folder = {} as Folder;

test('an app accepts data and returns the same object and typed handles', () => {
	const data = defineData(folder, {
		notes: { fields: { title: field.text() } },
	});
	const given = { description: 'Notes', data, actions: {} };
	const app = defineApp(() => given)({ folder });
	expect(app).toBe(given);
	expect(app.data.notes).toBe(data.notes);
	expect(app.data.notes.path('one')).toBe('data/notes/one.md');
});

test('an app may keep no data, and refuses data that is not an object', () => {
	const given = { description: 'Chat', actions: {} };
	expect(defineApp(() => given)({ folder })).toBe(given);
	expect(() =>
		defineApp(() => ({ description: 'Bad', data: null, actions: {} }) as never)(
			{ folder },
		),
	).toThrow('An app needs data: the value returned by defineData(...)');
});

test('an app refuses plain definitions and malformed data keys as handles', () => {
	expect(() =>
		defineApp(
			() =>
				({
					description: 'Bad',
					data: { notes: { fields: {} } },
					actions: {},
				}) as never,
		)({ folder }),
	).toThrow('data.notes is not a handle from defineData(...)');
	const data = defineData(folder, { notes: { fields: {} } });
	expect(() =>
		defineApp(() => ({
			description: 'Bad',
			data: { Notes: data.notes },
			actions: {},
		}))({ folder }),
	).toThrow(
		'data has the key "Notes", which must be a name, optionally followed by .md',
	);
});
