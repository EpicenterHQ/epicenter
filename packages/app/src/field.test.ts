import { describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { field, whatFits } from './field.ts';

describe('whatFits', () => {
	test('says what a field takes, with an example where one helps', () => {
		expect(whatFits(field.date(), 'soon')).toBe('a day like 2026-11-12');
		expect(whatFits(field.integer({ min: 1, max: 5 }), 7)).toBe(
			'a whole number from 1 to 5',
		);
		expect(whatFits(field.select(['open', 'done']), 'later')).toBe(
			'one of open, done',
		);
	});

	test('says X of a field that also takes null, and nothing of null itself', () => {
		const rating = Type.Union([field.integer({ min: 1, max: 5 }), Type.Null()]);
		expect(whatFits(rating, 7)).toBe('a whole number from 1 to 5');
		expect(whatFits(rating, null)).toBeUndefined();
	});

	test('says nothing when its words would not say why', () => {
		expect(whatFits(Type.String({ maxLength: 3 }), 'long')).toBeUndefined();
		expect(whatFits(field.date(), '2026-11-12')).toBeUndefined();
	});
});
