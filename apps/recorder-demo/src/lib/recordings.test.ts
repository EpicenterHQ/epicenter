import { expect, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { recordingsOf } from './recordings.ts';

const v = (s: string) => s as Version;
const note = (id: string, title: string) => ({
	id,
	title,
	recordedAt: '2026-10-31T00:00:00.000Z',
	durationMs: 1500,
	body: '',
	version: v(`${id}-note`),
});

test("a client's notes and audio make one row per recording, newest first", () => {
	const rows = recordingsOf({
		notes: [note('a', 'Older'), note('b', 'Newer')],
		audio: [
			{ id: 'a', ext: 'webm', version: v('a-audio') },
			{ id: 'b', ext: 'm4a', version: v('b-audio') },
		],
	});
	expect(rows).toEqual([
		{
			id: 'b',
			note: {
				title: 'Newer',
				recordedAt: '2026-10-31T00:00:00.000Z',
				durationMs: 1500,
				version: v('b-note'),
			},
			ext: 'm4a',
		},
		{
			id: 'a',
			note: {
				title: 'Older',
				recordedAt: '2026-10-31T00:00:00.000Z',
				durationMs: 1500,
				version: v('a-note'),
			},
			ext: 'webm',
		},
	]);
});

test('audio without a note, and a note without audio, each still show', () => {
	const rows = recordingsOf({
		notes: [note('b', 'No audio')],
		audio: [{ id: 'a', ext: 'm4a', version: v('x') }],
	});
	expect(
		rows.map(({ id, note, ext }) => ({ id, title: note?.title, ext })),
	).toEqual([
		{ id: 'b', title: 'No audio', ext: null },
		{ id: 'a', title: undefined, ext: 'm4a' },
	]);
});
