import { expect, test } from 'bun:test';
import { focusWord, readEntry } from './data.js';

test('a word reads its note from the body', () => {
	expect(
		readEntry({
			id: 'a',
			text: 'lucid',
			stage: 'new',
			createdAt: '2026-01-01T00:00:00.000Z',
			body: 'clear',
		}),
	).toEqual({
		id: 'a',
		text: 'lucid',
		note: 'clear',
		stage: 'new',
		createdAt: '2026-01-01T00:00:00.000Z',
	});
});

test('focus matches both the saved id and text', () => {
	const words = [
		{
			id: 'lucid-id',
			text: 'lurid',
			note: '',
			stage: 'usable' as const,
			createdAt: '2026-01-01T00:00:00.000Z',
		},
	];
	expect(
		focusWord(words, { entryId: 'lucid-id', text: 'lucid' }),
	).toBeUndefined();
	expect(focusWord(words, { entryId: 'lucid-id', text: 'lurid' })?.id).toBe(
		'lucid-id',
	);
});
