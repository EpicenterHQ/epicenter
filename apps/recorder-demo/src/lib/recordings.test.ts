import { expect, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { mergeRecordings } from './recordings.ts';

const v = (s: string) => s as Version;
const note = (id: string, title: string) => ({
	id,
	title,
	recordedAt: '2026-10-31T00:00:00.000Z',
	durationMs: 1500,
	body: '',
	version: v(`${id}-note`),
});

test('device and repository recordings make one list, newest first', () => {
	const rows = mergeRecordings(
		{
			notes: [note('b', 'On the device')],
			audio: [{ id: 'b', ext: 'm4a', version: v('x') }],
		},
		{
			notes: [note('a', 'Uploaded'), note('c', 'Newest')],
			audio: [{ id: 'a', ext: 'webm', version: v('y') }],
		},
	);
	expect(rows.map(({ id, where, ext }) => ({ id, where, ext }))).toEqual([
		{ id: 'c', where: 'repository', ext: null },
		{ id: 'b', where: 'device', ext: 'm4a' },
		{ id: 'a', where: 'repository', ext: 'webm' },
	]);
	expect(rows[1]?.note?.title).toBe('On the device');
});

test('a recording on both sides shows as the device copy until the device lets it go', () => {
	const rows = mergeRecordings(
		{ notes: [note('a', 'Device')], audio: [] },
		{ notes: [note('a', 'Repository')], audio: [] },
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ where: 'device', note: { title: 'Device' } });
});

test('signed out, only the device is listed; audio without a note still shows', () => {
	const rows = mergeRecordings(
		{ notes: [], audio: [{ id: 'a', ext: 'm4a', version: v('x') }] },
		null,
	);
	expect(rows).toEqual([{ id: 'a', where: 'device', note: null, ext: 'm4a' }]);
});
