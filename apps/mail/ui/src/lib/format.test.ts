/** Presentation rules keep list chips quiet and freshness times readable. */
import { expect, test } from 'bun:test';
import { relativeTime, showChip } from './format.js';

test('list chips skip inbox, unread and categories while keeping custom labels', () => {
	expect(['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'].map(showChip)).toEqual([
		false,
		false,
		false,
	]);
	expect(['STARRED', 'Label_1', 'TRASH'].map(showChip)).toEqual([
		true,
		true,
		true,
	]);
});

test('freshness uses singular and plural units and clamps future timestamps', () => {
	const now = Date.parse('2026-11-11T12:00:00Z');
	expect(relativeTime('2026-11-11T12:01:00Z', now)).toBe('just now');
	expect(relativeTime('2026-11-11T11:59:00Z', now)).toBe('1 minute ago');
	expect(relativeTime('2026-11-11T11:58:00Z', now)).toBe('2 minutes ago');
	expect(relativeTime('2026-11-11T11:00:00Z', now)).toBe('1 hour ago');
	expect(relativeTime('2026-11-10T12:00:00Z', now)).toBe('1 day ago');
});
