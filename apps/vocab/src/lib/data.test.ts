import { expect, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { focusWord, readEntry, readMessage } from './data.js';

const version = 'v' as Version;

test('a word reads its note from the body', () => {
	expect(
		readEntry({
			id: 'a',
			text: 'lucid',
			stage: 'new',
			createdAt: '2026-01-01T00:00:00.000Z',
			body: 'clear',
			version,
		}),
	).toEqual({
		id: 'a',
		text: 'lucid',
		note: 'clear',
		stage: 'new',
		createdAt: '2026-01-01T00:00:00.000Z',
	});
});

test('a message reads as the agent’s own copy', () => {
	const parts = [{ type: 'text' as const, text: 'Hi' }];
	const read = readMessage({
		chat: 'c',
		id: 'm',
		role: 'user',
		createdAt: 1,
		parts,
		body: '',
		version,
	});
	expect(read).toEqual({ id: 'm', role: 'user', createdAt: 1, parts });
	expect(read.parts).not.toBe(parts);
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
