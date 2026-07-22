import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';

import {
	compileTableDefinition,
	defineLens,
	defineTable,
	defineValues,
	parseLens,
} from './lens.js';

function exampleLens() {
	return defineLens({
		namespace: 'so.epicenter.notes',
		title: 'Notes',
		description: 'Personal notes and settings.',
		collections: {
			notes: defineTable({
				title: 'Notes',
				fields: {
					title: field.string(),
					body: field.string(),
				},
				optional: ['body'],
			}),
			settings: defineValues({
				title: 'Settings',
				values: { theme: field.select(['light', 'dark']) },
			}),
		},
	});
}

describe('Lens definitions', () => {
	test('are complete pure JSON and parse back with the same semantics', () => {
		const lens = exampleLens();
		const json = JSON.parse(JSON.stringify(lens));
		const parsed = parseLens(json);
		expect(parsed.error).toBeNull();
		expect(parsed.data).toEqual(lens);
		expect(Object.isFrozen(parsed.data?.collections)).toBe(true);
	});

	test('rejects open shapes, invalid optionality, identity metadata, and references', () => {
		const lens = exampleLens();
		for (const invalid of [
			{ ...lens, icon: 'notes' },
			{
				...lens,
				collections: {
					...lens.collections,
					notes: { ...lens.collections.notes, optional: ['missing'] },
				},
			},
			{
				...lens,
				collections: {
					...lens.collections,
					notes: {
						...lens.collections.notes,
						fields: { title: { type: 'string', key: 'title' } },
					},
				},
			},
			{
				...lens,
				collections: {
					...lens.collections,
					notes: {
						...lens.collections.notes,
						fields: { parent: field.reference('notes') },
					},
				},
			},
			Object.create(lens),
		]) {
			expect(parseLens(invalid).error?.name).toBe('InvalidLens');
		}
	});

	test('compiles required and optional field interpretation without mutating raw rows', () => {
		const table = exampleLens().collections.notes;
		if (table.kind !== 'table') throw new Error('expected table');
		const compiled = compileTableDefinition(table, {
			namespace: 'so.epicenter.notes',
			collection: 'notes',
		});
		expect(compiled.validateCreate({ title: 'Hello' })).toEqual({
			title: 'Hello',
		});
		expect(compiled.normalizeUpdate({ body: undefined })).toEqual({
			set: {},
			unset: ['body'],
		});
		const raw = { title: 'Hello', unknown: true };
		expect(compiled.project('aaaaaaaaaaaaaaaaaaaaaaaa', raw).data).toEqual({
			id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			title: 'Hello',
		});
		expect(raw).toEqual({ title: 'Hello', unknown: true });
	});
});
