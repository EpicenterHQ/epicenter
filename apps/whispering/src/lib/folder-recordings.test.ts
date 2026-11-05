/**
 * A recording's note over a real folder (a `/node` directory, the same
 * layout the desktop window opens through the shell): written once at Stop, when
 * its audio is at its path, and given on the next launch to audio a quit, a
 * crash, or a closed tab left without one, with the length recovery
 * answered, measured from its bytes when it answered none.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFolder } from '@epicenter/folder';
import type { Folder } from '@epicenter/folder/core';
import { directory } from '@epicenter/folder/node';
import type { Recorder } from '@epicenter/recorder';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { type Whispering, whispering } from './contract.js';
import { finishCutOffRecordings, keepRecording } from './folder-recordings.js';
import { createMicrophoneDevice } from './microphone.js';
import { NO_INPUTS, toneWav } from './services.test-support.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A temporary directory, and the folder the app writes a recording's note through over it. */
async function folder() {
	const path = await mkdtemp(join(tmpdir(), 'whispering-desktop-'));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	await mkdir(join(path, 'recordings'));
	const files = openFolder(whispering, directory(path));
	cleanups.push(() => files[Symbol.dispose]());
	return { path, files };
}

/** Every recording note in `files`, read now. */
const notesIn = async (files: Folder<Whispering>) =>
	expectOk(await files.recordings.list()).items;

/** The recording note `id` names, read now. */
async function noteOf(files: Folder<Whispering>, id: string) {
	const note = (await notesIn(files)).find((each) => each.id === id);
	if (note === undefined) throw new Error(`no note for ${id}`);
	return note;
}

const kept = (id: string, durationMs = 1000) => ({
	id,
	title: 'Standup',
	recordedAt: '2026-10-31T09:30:00.000Z',
	durationMs,
});

/** The id of the recording whose audio is at `path`. */
const idOf = (path: string) =>
	path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

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
					.map(idOf)
					.filter((id) => !placed.some((recovered) => recovered.id === id))
					.map((id) => ({ id, durationMs: null })),
			],
			unplaced: [],
		});

test('Stop writes the note, with its length, beside its audio', async () => {
	const { path, files } = await folder();
	const id = '20261031T093000000';
	await writeFile(join(path, `recordings/${id}.webm`), 'placed by the shell');
	await keepRecording(files, kept(id, 1000.4));
	const note = await noteOf(files, id);
	expect([note.title, note.durationMs]).toEqual(['Standup', 1000]);
	// Plain Markdown beside the audio.
	expect(await readFile(join(path, `recordings/${id}.md`), 'utf8')).toContain(
		'durationMs: 1000',
	);
});

test('the next launch gives a cut-off recording its note, with the length recovery answered or read from its audio', async () => {
	const { path, files } = await folder();
	// The shell placed `cut` from `.epicenter/recordings` just now; bytes that
	// read as no audio at all show its length is recover's, never read back.
	const recover = async (unnamed: readonly string[]) => {
		await writeFile(join(path, 'recordings/cut.webm'), 'not audio');
		return desktopRecover([{ id: 'cut', durationMs: 2000 }])(unnamed);
	};
	// One the shell placed after its page left, and one kept normally.
	await writeFile(join(path, 'recordings/left.wav'), toneWav({ seconds: 3 }));
	await writeFile(join(path, 'recordings/done.wav'), toneWav({ seconds: 1 }));
	await keepRecording(files, kept('done'));

	expect(
		expectOk(await finishCutOffRecordings(files, { recover })).noted.sort(),
	).toEqual(['cut', 'left']);
	expect(await noteOf(files, 'cut')).toMatchObject({
		title: 'Recovered recording',
		durationMs: 2000,
	});
	expect((await noteOf(files, 'left')).durationMs).toBe(3000);
	expect((await noteOf(files, 'done')).title).toBe('Standup');
	// Each has its note now, so the next launch makes none.
	expect(
		expectOk(await finishCutOffRecordings(files, { recover })).noted,
	).toEqual([]);
});

test('audio whose length does not read is still given a note, without a length', async () => {
	const { path, files } = await folder();
	await writeFile(join(path, 'recordings/odd.wav'), 'not a WAV');
	expect(
		expectOk(
			await finishCutOffRecordings(files, { recover: desktopRecover([]) }),
		).noted,
	).toEqual(['odd']);
	expect((await noteOf(files, 'odd')).durationMs).toBeUndefined();
});

test('recovery is asked about exactly the audio no note names, and names only what it answers', async () => {
	const { path, files } = await folder();
	const asked: (readonly string[])[] = [];
	// The browser recorder's recovery: every one of `unnamed` no tab is
	// writing, leaving out `writing`, whose Web Lock another tab holds.
	const recover: Recorder['recover'] = async ({ unnamed }) => {
		asked.push(unnamed);
		return Ok({
			recovered: unnamed
				.filter((file) => file !== 'recordings/writing.webm')
				.map((file) => ({ path: file, durationMs: 1500 })),
			unplaced: [],
		});
	};
	const capture = createMicrophoneDevice({
		files: files.audio,
		recorder: {
			...NO_INPUTS,
			start: async () => {
				throw new Error('nothing records here');
			},
			recover,
		},
	});
	await writeFile(join(path, 'recordings/done.webm'), 'kept');
	await keepRecording(files, kept('done'));
	expect(expectOk(await finishCutOffRecordings(files, capture))).toEqual({
		noted: [],
		unplaced: [],
	});
	expect(asked).toEqual([[]]);

	await writeFile(join(path, 'recordings/cut.webm'), 'a closed tab left it');
	await writeFile(join(path, 'recordings/writing.webm'), 'still recording');
	expect(expectOk(await finishCutOffRecordings(files, capture)).noted).toEqual([
		'cut',
	]);
	expect(asked.at(-1)?.toSorted()).toEqual([
		'recordings/cut.webm',
		'recordings/writing.webm',
	]);
	expect((await noteOf(files, 'cut')).durationMs).toBe(1500);
	expect((await notesIn(files)).map(({ id }) => id)).not.toContain('writing');
});
