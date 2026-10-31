/**
 * The desktop's recordings over a real folder (`/node`'s device, the same
 * client the desktop window opens through the shell): the note made at
 * Start, its length at Stop, and a cut-off recording completed on the next
 * launch: audio placed beside a taken path given a note of its own, and a
 * recording that holds nothing settled once.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
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

test('the next launch completes a recording a crash cut off, from its audio, repairing only while a note has no length', async () => {
	const { path, device } = await folder();
	const staged = join(path, '.epicenter/recording/recordings');
	let repairs = 0;
	// What the desktop's recover does: the cut-off recording lands at its
	// path. The desktop encodes it to `.webm`; a WAV, as it places one its
	// encoder refused, stands in, since the length is read the same way.
	const repair = async () => {
		repairs++;
		await rename(
			join(staged, 'cut.wav'),
			join(path, 'recordings/cut.wav'),
		).catch(() => {});
		return Ok(['cut']);
	};
	expectOk(await beginRecording(device, started('cut')));
	await mkdir(staged, { recursive: true });
	await writeFile(join(staged, 'cut.wav'), toneWav({ seconds: 2 }));
	// One whose audio never started, and one finished normally.
	expectOk(await beginRecording(device, started('silent')));
	expectOk(await beginRecording(device, started('done')));
	await writeFile(join(path, 'recordings/done.wav'), toneWav({ seconds: 1 }));
	expectOk(await completeRecording(device, 'done', 1000));

	expect(
		expectOk(await finishCutOffRecordings(device, { recover: repair })),
	).toEqual(['cut']);
	expect(expectOk(await device.recordings.get({ id: 'cut' })).durationMs).toBe(
		2000,
	);
	expect(
		expectOk(await device.recordings.get({ id: 'silent' })).durationMs,
	).toBeUndefined();
	expect(repairs).toBe(1);
	// A note without audio still asks for a repair; with none, nothing runs.
	expect(
		expectOk(await finishCutOffRecordings(device, { recover: repair })),
	).toEqual([]);
	expect(repairs).toBe(2);
	await abandonRecording(device, 'silent');
	expect(
		expectOk(await finishCutOffRecordings(device, { recover: repair })),
	).toEqual([]);
	expect(repairs).toBe(2);
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

test('audio recovery placed beside a taken path is given a note and its length', async () => {
	const { path, device } = await folder();
	const id = '2026-10-31T09-30-00-000Z-cutoffaa';
	expectOk(await beginRecording(device, started(id)));
	// Something else is at the recording's path, so the desktop's recover
	// places the leftover beside it (`wav::recover`).
	await writeFile(join(path, `recordings/${id}.wav`), toneWav({ seconds: 1 }));
	const recover = async () => {
		await writeFile(
			join(path, `recordings/${id}-recovered.wav`),
			toneWav({ seconds: 2 }),
		);
		return Ok([`${id}-recovered`]);
	};

	expect(
		expectOk(await finishCutOffRecordings(device, { recover })).sort(),
	).toEqual([id, `${id}-recovered`]);
	expect(
		expectOk(await device.recordings.get({ id: `${id}-recovered` })),
	).toMatchObject({
		title: 'Recovered recording',
		recordedAt: '2026-10-31T09:30:00.000Z',
		capture: 'microphone',
		durationMs: 2000,
	});
});

test('a recording the device calls silent is settled at length 0 once, and starts no recovery again', async () => {
	const { device } = await folder();
	expectOk(await beginRecording(device, started('closed-early')));
	expectOk(await beginRecording(device, started('still-starting')));
	let recovers = 0;
	const capture = {
		recover: async () => {
			recovers++;
			return Ok([]);
		},
		// Another tab is still waiting on the first piece of `still-starting`.
		silent: async (ids: readonly string[]) =>
			Ok(ids.filter((id) => id !== 'still-starting')),
	};

	expect(expectOk(await finishCutOffRecordings(device, capture))).toEqual([
		'closed-early',
	]);
	expect(
		expectOk(await device.recordings.get({ id: 'closed-early' })).durationMs,
	).toBe(0);
	expect(
		expectOk(await device.recordings.get({ id: 'still-starting' })).durationMs,
	).toBeUndefined();

	// Once the other tab has completed its note, nothing is unfinished.
	expectOk(await completeRecording(device, 'still-starting', 1500));
	expect(expectOk(await finishCutOffRecordings(device, capture))).toEqual([]);
	expect(recovers).toBe(1);
});
