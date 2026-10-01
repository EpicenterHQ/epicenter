import { expect, test } from 'bun:test';
import { reviewImport } from './import.js';

test('review preserves exact expressions and counts repeated and saved lines', () => {
	expect(
		reviewImport(
			'  lucid  \n1. nuance\nlucid\nnuance - subtle\nold\nold\n',
			new Set(['old']),
		),
	).toEqual({
		eligible: ['lucid', '1. nuance', 'nuance - subtle'],
		repeated: 2,
		alreadySaved: 1,
	});
});
