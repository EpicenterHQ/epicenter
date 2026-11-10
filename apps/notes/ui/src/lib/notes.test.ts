/** Notes list helpers keep undated files last and preserve file addresses in links. */
import { expect, test } from 'bun:test';
import {
	captureHref,
	captureTime,
	labelOf,
	matches,
	noteHref,
	order,
} from './notes.js';

test('labels and search use the title', () => {
	expect(labelOf({})).toBe('Untitled');
	expect(labelOf({ title: 'An idea' })).toBe('An idea');
	expect(matches({ title: 'An Idea' }, 'IDEA')).toBe(true);
	expect(matches({}, 'idea')).toBe(false);
});

test('newest first, undated last, ties by descending path without mutating input', () => {
	const rows = [
		{ path: 'notes/a.md', name: 'a' },
		{ path: 'notes/b.md', name: 'b', createdAt: 'invalid' },
		{ path: 'notes/c.md', name: 'c', createdAt: '2026-11-10T12:00:00+08:00' },
		{ path: 'notes/d.md', name: 'd', createdAt: '2026-11-10T04:00:00Z' },
		{ path: 'notes/e.md', name: 'e', createdAt: '2026-11-11T00:00:00Z' },
	];
	expect(order(rows).map((row) => row.path)).toEqual([
		'notes/e.md',
		'notes/d.md',
		'notes/c.md',
		'notes/b.md',
		'notes/a.md',
	]);
	expect(rows[0]?.path).toBe('notes/a.md');
});

test('capture time is parsed only from valid timestamp names', () => {
	expect(
		captureTime('captures/2026-11-10T09-30-00-000Z-k3x9a2f8.md')?.toISOString(),
	).toBe('2026-11-10T09:30:00.000Z');
	for (const path of [
		'captures/x.md',
		'notes/2026-11-10T09-30-00-000Z-k3x9a2f8.md',
		'captures/2026-02-30T09-30-00-000Z-k3x9a2f8.md',
	])
		expect(captureTime(path)).toBeUndefined();
});

test('each path part is encoded, including hashes, spaces, and unicode', () => {
	expect(noteHref('notes/a #文.md')).toBe('#/notes/a%20%23%E6%96%87.md');
	expect(captureHref('captures/a #文.md')).toBe(
		'/capture/#/captures/a%20%23%E6%96%87.md',
	);
});
