import { expect, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { finishCutOffRecordings, recordingsOf } from './recordings.ts';

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

test('a recording a closed tab left as audio alone gets its note, its length read from the audio', async () => {
	const { mkdtemp, mkdir, rm, writeFile } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { openDevice } = await import('@epicenter/folder/node');
	const { recorder } = await import('../contract.ts');
	const root = await mkdtemp(join(tmpdir(), 'recorder-demo-'));
	try {
		const device = unwrap(await openDevice(recorder, { path: root }));
		const audio = new Uint8Array(
			await Bun.file(
				new URL(
					'../../../../packages/recorder/src/fixtures/webkit.m4a',
					import.meta.url,
				),
			).arrayBuffer(),
		);
		await mkdir(join(root, 'recordings'));
		const cut = '2026-10-31T09-30-00-000Z-cutoffaa';
		await writeFile(join(root, `recordings/${cut}.m4a`), audio);
		// One with its note already, and one whose name is no recording's.
		await writeFile(join(root, 'recordings/elsewhere.m4a'), audio);
		const whole = '2026-10-31T08-00-00-000Z-wholeaaa';
		await writeFile(join(root, `recordings/${whole}.m4a`), audio);
		unwrap(
			await device.recordings.create({
				id: whole,
				title: 'Whole',
				recordedAt: '2026-10-31T08:00:00.000Z',
				durationMs: 1047,
			}),
		);

		expect(unwrap(await finishCutOffRecordings(device))).toEqual([cut]);
		expect(unwrap(await device.recordings.get({ id: cut }))).toMatchObject({
			recordedAt: '2026-10-31T09:30:00.000Z',
			durationMs: 1047,
		});
		expect(unwrap(await finishCutOffRecordings(device))).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
