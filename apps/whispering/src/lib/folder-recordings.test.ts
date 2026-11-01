/**
 * A recording's note over a real folder (`/node`'s device, the same client
 * the desktop window opens through the shell): written once at Stop, when
 * its audio is at its path, and given on the next launch to audio a quit, a
 * crash, or a closed tab left without one, with the length recovery
 * answered, measured from its bytes when it answered none.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDevice } from '@epicenter/folder/node';
import type { Recorder } from '@epicenter/recorder';
import { Ok, unwrap } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { whispering } from './contract.js';
import { finishCutOffRecordings, keepRecording } from './folder-recordings.js';
import { createMicrophoneDevice } from './microphone.js';
import { NO_INPUTS, toneWav } from './services.test-support.js';

const folders: string[] = [];
afterEach(async () => {
	for (const folder of folders.splice(0))
		await rm(folder, { recursive: true, force: true });
});

async function folder() {
	const path = await mkdtemp(join(tmpdir(), 'whispering-desktop-'));
	folders.push(path);
	await mkdir(join(path, 'recordings'));
	return { path, device: unwrap(await openDevice(whispering, { path })) };
}

const kept = (id: string, durationMs = 1000) => ({
	id,
	title: 'Standup',
	recordedAt: '2026-10-31T09:30:00.000Z',
	durationMs,
});

/**
 * The desktop's `recover`: what the shell placed, then the audio at its
 * path that no note names, which is finished there.
 */
const desktopRecover =
	(placed: { id: string; durationMs: number | null }[]) =>
	async (unnamed: readonly string[]) =>
		Ok({
			whole: [
				...placed,
				...unnamed
					.filter((id) => !placed.some((recovered) => recovered.id === id))
					.map((id) => ({ id, durationMs: null })),
			],
			unplaced: [],
		});

test('Stop writes the note once, with its length, beside its audio', async () => {
	const { path, device } = await folder();
	const id = '20261031T093000000';
	await writeFile(join(path, `recordings/${id}.webm`), 'placed by the shell');
	expectOk(await keepRecording(device, kept(id, 1000.4)));
	const note = expectOk(await device.recordings.get({ id }));
	expect([note.title, note.durationMs]).toEqual(['Standup', 1000]);
	// Plain Markdown beside the audio.
	expect(await readFile(join(path, `recordings/${id}.md`), 'utf8')).toContain(
		'durationMs: 1000',
	);
	// A second note for the same id is refused, never written over the first.
	expectErr(await keepRecording(device, { ...kept(id), title: 'Other' }));
	expect(expectOk(await device.recordings.get({ id })).title).toBe('Standup');
});

test('the next launch gives a cut-off recording its note, with the length recovery answered or read from its audio', async () => {
	const { path, device } = await folder();
	// The shell placed `cut` from `.epicenter/recordings` just now; bytes that
	// read as no audio at all show its length is recover's, never read back.
	const recover = async (unnamed: readonly string[]) => {
		await writeFile(join(path, 'recordings/cut.webm'), 'not audio');
		return desktopRecover([{ id: 'cut', durationMs: 2000 }])(unnamed);
	};
	// One the shell placed after its page left, and one kept normally.
	await writeFile(join(path, 'recordings/left.wav'), toneWav({ seconds: 3 }));
	await writeFile(join(path, 'recordings/done.wav'), toneWav({ seconds: 1 }));
	expectOk(await keepRecording(device, kept('done')));

	expect(
		expectOk(await finishCutOffRecordings(device, { recover })).noted.sort(),
	).toEqual(['cut', 'left']);
	expect(expectOk(await device.recordings.get({ id: 'cut' }))).toMatchObject({
		title: 'Recovered recording',
		durationMs: 2000,
	});
	expect(expectOk(await device.recordings.get({ id: 'left' })).durationMs).toBe(
		3000,
	);
	expect(expectOk(await device.recordings.get({ id: 'done' })).title).toBe(
		'Standup',
	);
	// Each has its note now, so the next launch makes none.
	expect(
		expectOk(await finishCutOffRecordings(device, { recover })).noted,
	).toEqual([]);
});

test('audio whose length does not read is still given a note, without a length', async () => {
	const { path, device } = await folder();
	await writeFile(join(path, 'recordings/odd.wav'), 'not a WAV');
	expect(
		expectOk(
			await finishCutOffRecordings(device, { recover: desktopRecover([]) }),
		).noted,
	).toEqual(['odd']);
	expect(
		expectOk(await device.recordings.get({ id: 'odd' })).durationMs,
	).toBeUndefined();
});

test('in a browser, recovery reads the audio only when some has no note, and names only what it answers', async () => {
	const { path, device } = await folder();
	let repairs = 0;
	// The browser recorder's recovery: every recording no tab is writing,
	// leaving out `writing`, whose Web Lock another tab holds while it records.
	const recover: Recorder['recover'] = async () => {
		repairs++;
		return Ok({
			recovered: [
				{ path: 'recordings/cut.webm', durationMs: 1500 },
				{ path: 'recordings/done.webm', durationMs: 1000 },
			],
			unplaced: [],
		});
	};
	const capture = createMicrophoneDevice({
		device,
		recorder: {
			...NO_INPUTS,
			start: async () => {
				throw new Error('nothing records here');
			},
			recover,
			placesWhole: false,
		},
	});
	await writeFile(join(path, 'recordings/done.webm'), 'kept');
	expectOk(await keepRecording(device, kept('done')));
	expect(expectOk(await finishCutOffRecordings(device, capture))).toEqual({
		noted: [],
		unplaced: [],
	});
	expect(repairs).toBe(0);

	await writeFile(join(path, 'recordings/cut.webm'), 'a closed tab left it');
	await writeFile(join(path, 'recordings/writing.webm'), 'still recording');
	expect(expectOk(await finishCutOffRecordings(device, capture)).noted).toEqual(
		['cut'],
	);
	expect(repairs).toBe(1);
	expect(expectOk(await device.recordings.get({ id: 'cut' })).durationMs).toBe(
		1500,
	);
	expect((await device.recordings.get({ id: 'writing' })).error?.name).toBe(
		'NotFound',
	);
});
