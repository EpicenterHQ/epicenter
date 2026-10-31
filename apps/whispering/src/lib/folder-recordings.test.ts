/**
 * The desktop's recordings over a real folder (`/node`'s device, the same
 * client the desktop window opens through the shell): the note made at
 * Start, its length at Stop, and a cut-off recording completed on the next
 * launch.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
import { whispering } from './contract.js';
import {
	abandonRecording,
	beginRecording,
	completeRecording,
	finishCutOffRecordings,
} from './folder-recordings.js';

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0))
		await rm(folder, { recursive: true, force: true });
});

async function folder() {
	const path = await mkdtemp(join(tmpdir(), 'whispering-desktop-'));
	folders.push(path);
	return { path, device: unwrap(await openDevice(whispering, { path })) };
}

const started = (id: string) => ({
	id,
	title: 'Standup',
	recordedAt: '2026-10-31T09:30:00.000Z',
	capture: 'microphone' as const,
});

test('the note is made at Start without a length and completed at Stop', async () => {
	const { path, device } = await folder();
	expectOk(await beginRecording(device, started('20261031T093000000')));
	// The shell is writing the audio meanwhile.
	await writeFile(
		join(path, 'recordings/20261031T093000000.wav'),
		toneWav({ seconds: 1 }),
	);
	const note = expectOk(
		await device.recordings.get({ id: '20261031T093000000' }),
	);
	expect(note.durationMs).toBeUndefined();
	// The title edited while it records is kept.
	expectOk(
		await device.recordings.update(
			{ id: note.id },
			{ title: 'Renamed' },
			{ over: note.version },
		),
	);
	expectOk(await completeRecording(device, note.id, 1000.4));
	const done = expectOk(await device.recordings.get({ id: note.id }));
	expect([done.title, done.durationMs]).toEqual(['Renamed', 1000]);
	// Plain Markdown beside the audio.
	expect(
		await readFile(join(path, 'recordings/20261031T093000000.md'), 'utf8'),
	).toContain('durationMs: 1000');
});

test('a note deleted while recording is not made again', async () => {
	const { device } = await folder();
	expectOk(await beginRecording(device, started('a')));
	const note = expectOk(await device.recordings.get({ id: 'a' }));
	expectOk(await device.recordings.delete({ id: 'a' }, { over: note.version }));
	expect(expectErr(await completeRecording(device, 'a', 5))).toContain(
		'deleted',
	);
	expect((await device.recordings.get({ id: 'a' })).error?.name).toBe(
		'NotFound',
	);
});

test('a second Start with the same id is refused, never overwritten', async () => {
	const { device } = await folder();
	expectOk(await beginRecording(device, started('a')));
	expectErr(await beginRecording(device, { ...started('a'), title: 'Other' }));
	expect(expectOk(await device.recordings.get({ id: 'a' })).title).toBe(
		'Standup',
	);
});

test('the next launch completes a recording a crash cut off, from its audio, repairing only then', async () => {
	const { path, device } = await folder();
	let repairs = 0;
	const repair = async () => {
		repairs++;
		return Ok([]);
	};
	expectOk(await beginRecording(device, started('cut')));
	await writeFile(join(path, 'recordings/cut.wav'), toneWav({ seconds: 2 }));
	// One whose audio never started, and one finished normally.
	expectOk(await beginRecording(device, started('silent')));
	expectOk(await beginRecording(device, started('done')));
	await writeFile(join(path, 'recordings/done.wav'), toneWav({ seconds: 1 }));
	expectOk(await completeRecording(device, 'done', 1000));

	expect(expectOk(await finishCutOffRecordings(device, repair))).toEqual([
		'cut',
	]);
	expect(expectOk(await device.recordings.get({ id: 'cut' })).durationMs).toBe(
		2000,
	);
	expect(
		expectOk(await device.recordings.get({ id: 'silent' })).durationMs,
	).toBeUndefined();
	expect(repairs).toBe(1);
	// A second launch has nothing left to do, and repairs nothing.
	expect(expectOk(await finishCutOffRecordings(device, repair))).toEqual([]);
	expect(repairs).toBe(1);
});

test('a recording that did not start leaves no note, unless audio was written', async () => {
	const { path, device } = await folder();
	expectOk(await beginRecording(device, started('refused')));
	await abandonRecording(device, 'refused');
	expect((await device.recordings.get({ id: 'refused' })).error?.name).toBe(
		'NotFound',
	);
	expectOk(await beginRecording(device, started('late')));
	await writeFile(join(path, 'recordings/late.wav'), toneWav());
	await abandonRecording(device, 'late');
	expectOk(await device.recordings.get({ id: 'late' }));
});
