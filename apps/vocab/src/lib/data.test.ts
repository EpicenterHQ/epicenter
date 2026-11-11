/**
 * Vocab focus lookup tests.
 *
 * A chat's saved focus must match both the entry ID and text before the
 * current word can supply stage controls.
 */
import { expect, test } from 'bun:test';
import { focusWord } from './data.js';

test('focus finds a word only when its saved ID and text both match', () => {
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
	expect(
		focusWord(words, { entryId: 'other-id', text: 'lurid' }),
	).toBeUndefined();
	expect(focusWord(words, { entryId: 'lucid-id', text: 'lurid' })?.id).toBe(
		'lucid-id',
	);
});
