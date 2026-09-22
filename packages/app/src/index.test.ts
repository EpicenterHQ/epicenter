/** Inert declarations validate identity and retain their schema without acquiring resources. */
import { expect, test } from 'bun:test';
import { defineApp } from './index.js';
const definition = defineApp({ id: 'so.epicenter.notes', tables: {}, kv: {} });
test('the declaration exposes one identity and the schema without implementation options', () => {
	const application = defineApp({ ...definition, title: 'Notes' });
	expect(application.id).toBe(definition.id);
	expect(application.title).toBe('Notes');
	expect(application.tables).toBe(definition.tables);
	expect(application.kv).toBe(definition.kv);
	expect(Object.keys(application).sort()).toEqual([
		'id',
		'kv',
		'tables',
		'title',
	]);
	expect(Object.isFrozen(application)).toBe(true);
});

test('an application id this platform cannot file refuses at construction', () => {
	expect(() => defineApp({ ...definition, id: 'not an app id' })).toThrow(
		'is not valid',
	);
});
