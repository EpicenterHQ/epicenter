/**
 * Whispering over its files, as the mounted app reads and writes them
 * (memory stands in for the data folder or the Origin Private File System).
 *
 * Key behaviors:
 * - A recording's audio lands at Stop, and its note, with its length, once
 *   Stop has answered with its audio at its path
 * - A take is on the record screen until Stop answers, not in the library
 * - Audio that cannot be written fails the recording, saying why; audio
 *   whose note cannot be written lists as an untitled recording, and says so
 * - On the desktop, audio a quit or a crash cut off is completed by the
 *   next launch's recovery, beside the pages, and lists as an untitled
 *   recording; what it cannot complete is said
 * - A transcription sends the recording's audio to the model chosen for it,
 *   and its transcript names that model and where it went
 * - A connection removed since is not sent to, and says why (a connection
 *   moved while a request is prepared: `inference.test.ts`)
 * - A transcript is kept when its answer arrives, even if the pages have
 *   since closed
 * - A failed transcription shows its error; Try again sends the same audio
 *   to the same model. An answer whose transcript cannot be written fails
 *   too, and nothing is kept for it
 * - The same recording is not transcribed twice at once, and is not
 *   deleted while it is transcribed
 * - Deleting a recording deletes its transcripts and its audio
 * - A recording is kept when a transcript for it was saved after the
 *   person confirmed deleting it
 * - A note that does not read is listed for repair and repaired as text
 *
 * Run with `--conditions=browser` (`bun run test`): the library is Svelte
 * state over the folder query, and Svelte's server runtime notifies nothing.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { RecorderError } from '@epicenter/recorder';
import { MutationObserver } from '@tanstack/query-core';
import { runMutation } from 'wellcrafted/query';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { CaptureDevice } from './capture.js';
import {
	deferred,
	eventually,
	openPage,
	openTestServices,
	TEST_BASE_URL,
	type TestServicesOptions,
	toneWav,
} from './services.test-support.js';
import { createTestWhispering } from './whispering.test-support.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The app over fresh files in memory. */
async function fixture(options: TestServicesOptions = {}) {
	const test = await openTestServices(options);
	cleanups.push(test.close);
	const opened = await createTestWhispering({
		services: test.services,
		files: test.files,
	});
	cleanups.push(opened.close);
	return { test, ...opened };
}

/** Record with the fixture device and wait until the library lists it. */
async function record({
	whispering,
	library,
}: Pick<Awaited<ReturnType<typeof fixture>>, 'whispering' | 'library'>) {
	const before = library.entries.length;
	await whispering.startRecording();
	await whispering.stopRecording();
	// The note is written once, with its length, at Stop.
	await eventually(() => library.entries.length === before + 1);
	return library.entries[0]!;
}

/**
 * `capture`, whose every Stop calls `after` once it has answered, before
 * the app writes the recording's note.
 */
function afterStop(capture: CaptureDevice, after: () => void): CaptureDevice {
	return {
		...capture,
		async start(options) {
			const started = await capture.start(options);
			if (started.error !== null) return started;
			return Ok({
				...started.data,
				async stop() {
					const stopped = await started.data.stop();
					after();
					return stopped;
				},
			});
		},
	};
}

test('a recording’s audio lands at Stop, and its note, with its length', async () => {
	const test = await openTestServices();
	let whenStopped: string[] = [];
	const opened = await createTestWhispering({
		services: {
			...test.services,
			capture: afterStop(test.services.capture, () => {
				whenStopped = test.outside.paths('recordings');
			}),
		},
		files: test.files,
	});
	cleanups.push(opened.close);
	const { library } = opened;

	const recording = await record(opened);

	// Stop answered with the audio at its path, and no note yet.
	expect(whenStopped).toEqual([`recordings/${recording.id}.wav`]);
	expect(recording.durationMs).toBe(1000);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	expect(library.audioOf(recording.id)).toMatchObject({
		kind: 'here',
		file: { ext: 'wav' },
	});
	expect(test.outside.paths('recordings')).toEqual([
		`recordings/${recording.id}.md`,
		`recordings/${recording.id}.wav`,
	]);
});

test('a take is on the record screen, not in the library, until Stop answers with its audio at its path', async () => {
	const test = await openTestServices();
	// The desktop's shape: Stop finishes the audio and places it, then answers.
	const stopping = deferred<void>();
	const capture: CaptureDevice = {
		...test.services.capture,
		async start({ id }) {
			return Ok({
				startedAt: 0,
				onEnded: () => () => {},
				async stop() {
					await stopping.promise;
					await test.outside.write(
						`recordings/${id}.webm`,
						'placed by the shell',
					);
					return Ok({ durationMs: 1500 });
				},
			});
		},
	};
	const { whispering, library } = await createTestWhispering({
		services: { ...test.services, capture },
		files: test.files,
	});
	cleanups.push(() => whispering.dispose());

	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	expect(library.entries).toHaveLength(0);
	const stopped = whispering.stopRecording();
	expect(whispering.recorder.phase).toBe('stopping');
	expect(library.entries).toHaveLength(0);

	stopping.resolve();
	await stopped;
	expect(whispering.recorder.phase).toBe('idle');
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({ durationMs: 1500 });
	// The audio is its own listing, which can answer after the recordings'
	// (`listing` until then), so wait for it rather than race it.
	const { id } = library.entries[0]!;
	await eventually(() => library.audioOf(id).kind === 'here');
	expect(whispering.recorderError).toBeUndefined();
});

test('a recording whose audio cannot be written fails, saying why, and nothing is listed', async () => {
	const { test, whispering, library } = await fixture();
	test.outside.refuse('The disk is full', { under: 'recordings' });

	await whispering.startRecording();
	await whispering.stopRecording();

	expect(whispering.recorder.phase).toBe('idle');
	expect(whispering.recorderError).toContain('The disk is full');
	expect(library.entries).toHaveLength(0);
	expect(test.outside.paths('recordings')).toEqual([]);
});

test('a recording whose note cannot be written lists as an untitled recording, and says so', async () => {
	const test = await openTestServices();
	const opened = await createTestWhispering({
		services: {
			...test.services,
			capture: afterStop(test.services.capture, () => {
				// The audio is at its path; every write after it is refused.
				test.outside.refuse('The disk is full', { under: 'recordings' });
			}),
		},
		files: test.files,
	});
	cleanups.push(opened.close);
	const { whispering, library } = opened;

	await whispering.startRecording();
	await whispering.stopRecording();

	await eventually(() => library.entries.length === 1);
	const [recording] = library.entries;
	expect(recording).toMatchObject({ title: '' });
	expect(test.outside.paths('recordings')).toEqual([
		`recordings/${recording!.id}.wav`,
	]);
	expect(whispering.recorderError).toContain(
		'audio is saved, but its note was not',
	);
	expect(whispering.recorderError).toContain('The disk is full');
});

test('a recording the shell could not place lists once the next launch places it', async () => {
	const test = await openTestServices();
	let staged: { id: string; bytes: Uint8Array } | undefined;
	// The desktop's shape: the audio waits outside its path, Stop cannot
	// place it, and the next start's recover does.
	const capture: CaptureDevice = {
		...test.services.capture,
		async start({ id }) {
			return Ok({
				startedAt: 0,
				onEnded: () => () => {},
				async stop() {
					staged = { id, bytes: toneWav({ seconds: 1 }) };
					return RecorderError.Failed({
						cause: new Error(
							`recordings/${id}.webm could not be moved into place`,
						),
					});
				},
			});
		},
		async recover() {
			if (staged === undefined) return Ok({ recovered: [], unplaced: [] });
			await test.outside.write(`recordings/${staged.id}.wav`, staged.bytes);
			return Ok({
				recovered: [{ id: staged.id, durationMs: 1000 }],
				unplaced: [],
			});
		},
	};
	const services = { ...test.services, capture };
	const first = await createTestWhispering({ services, files: test.files });
	await first.whispering.startRecording();
	await first.whispering.stopRecording();
	expect(first.whispering.recorderError).toContain(
		'could not be moved into place',
	);
	expect(first.library.entries).toHaveLength(0);
	first.close();

	const next = await createTestWhispering({ services, files: test.files });
	cleanups.push(next.close);
	await eventually(() => next.library.entries.length === 1);
	expect(next.library.entries[0]).toMatchObject({ id: staged!.id, title: '' });
	expect(next.whispering.recorderError).toBeUndefined();
});

test('on the desktop the pages do not wait for the cut-off recordings, which are listed once complete', async () => {
	const test = await openTestServices();
	const recovering = deferred<void>();
	let asked = false;
	const capture: CaptureDevice = {
		...test.services.capture,
		async recover() {
			asked = true;
			await recovering.promise;
			await test.outside.write(
				'recordings/2026-10-31T09-30-00-000Z-cutoffaa.wav',
				toneWav({ seconds: 2 }),
			);
			return Ok({
				recovered: [
					{ id: '2026-10-31T09-30-00-000Z-cutoffaa', durationMs: 2000 },
				],
				unplaced: [],
			});
		},
	};
	const opened = await createTestWhispering({
		services: { ...test.services, capture },
		files: test.files,
	});
	cleanups.push(opened.close);
	await eventually(() => asked);
	// The pages read the library while the shell finishes the cut-off audio.
	expect(opened.library.entries).toEqual([]);

	recovering.resolve();
	await eventually(() => opened.library.entries.length === 1);
	expect(opened.library.entries[0]).toMatchObject({
		id: '2026-10-31T09-30-00-000Z-cutoffaa',
		recordedAt: '2026-10-31T09:30:00.000Z',
	});
});

test('files that cannot be listed at all say why the folder did not open', async () => {
	const test = await openTestServices();
	// A private window: every call is refused, the listing included.
	const reason =
		'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).';
	test.outside.refuseReads(reason);
	// A new page over the same files: its first read is what the layout shows.
	const page = await openPage(test.files);
	cleanups.push(page.close);

	expect(page.first.error?.message).toContain(reason);
	expect(page.firstSettings.error?.message).toContain(reason);
});

test('on the desktop, a cut-off recording that cannot be completed is said, and its audio lists', async () => {
	const test = await openTestServices();
	await test.outside.write(
		'recordings/2026-10-31T09-30-00-000Z-cutoffaa.m4a',
		'a closed tab left it',
	);
	test.services.capture.recover = async () =>
		Err({
			name: 'Failed',
			message: 'The recording could not be captured: the disk is full',
			cause: null,
		}) as never;
	const opened = await createTestWhispering({
		services: test.services,
		files: test.files,
	});
	cleanups.push(opened.close);

	await eventually(() => opened.whispering.recorderError !== undefined);
	expect(opened.whispering.recorderError).toBe(
		'Recordings a quit or a crash cut off could not be completed: The recording could not be captured: the disk is full',
	);
	// Its audio is in the folder, so it lists, untitled.
	expect(opened.library.entries).toHaveLength(1);
});

test('on the desktop, a take kept outside the folder, because audio with its id is there, is said with where it is, and gets no note', async () => {
	const test = await openTestServices();
	test.services.capture.recover = async () =>
		Ok({
			recovered: [],
			unplaced: [
				{
					id: '2026-10-31T09-30-00-000Z-cutoffaa',
					take: '/data/local/recording/2026-10-31T09-30-00-000Z-cutoffaa.webm',
				},
			],
		});
	const opened = await createTestWhispering({
		services: test.services,
		files: test.files,
	});
	cleanups.push(opened.close);

	await eventually(() => opened.whispering.recorderError !== undefined);
	expect(opened.whispering.recorderError).toBe(
		'A recording is kept outside the library, because audio with its id is already there: recordings/2026-10-31T09-30-00-000Z-cutoffaa.webm is another file, and the recording is at /data/local/recording/2026-10-31T09-30-00-000Z-cutoffaa.webm. Move the other file, and the next start adds it.',
	);
	expect(opened.library.entries).toHaveLength(0);
});

test('a transcription sends the recording’s audio and keeps its transcript beside it', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');

	expectOk(await library.transcribe(recording.id));

	expect(test.transcribed).toHaveLength(1);
	expect(test.transcribed[0]).toMatchObject({
		model: 'verification-model',
		bytes: toneWav(),
	});
	await eventually(() => library.resultsFor(recording.id).length === 1);
	expect(library.resultsFor(recording.id)[0]).toMatchObject({
		recordingId: recording.id,
		model: 'verification-model',
		endpoint: TEST_BASE_URL,
		body: 'um so a steady tone\n',
	});
	expect(
		test.outside.paths('transcriptions').filter((path) => path.endsWith('.md')),
	).toHaveLength(1);
	expect(library.transcribing(recording.id)).toBe(false);
});

/**
 * A transcription that failed once, observed as a component observes it:
 * its error and the variables Try again sends.
 */
async function failedOnce(opened: Awaited<ReturnType<typeof fixture>>) {
	const { query, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const observer = new MutationObserver(
		query.queryClient,
		library.transcription,
	);
	cleanups.push(() => observer.reset());
	await observer.mutate({ recordingId: recording.id }).catch(() => undefined);
	const failed = observer.getCurrentResult();
	expect(failed.status).toBe('error');
	return { observer, failed, id: recording.id };
}

test('a failed transcription shows its error, and Try again sends the same audio to the same model', async () => {
	let answers = 0;
	const opened = await fixture({
		transcribe: async () =>
			++answers === 1
				? Err({ message: 'busy, try later' })
				: Ok({ text: 'a steady tone' }),
	});
	const { test, library } = opened;
	const { observer, failed, id } = await failedOnce(opened);
	expect(failed.error?.message).toContain('busy, try later');
	expect(library.resultsFor(id)).toEqual([]);

	await observer.mutate(failed.variables!);

	expect(observer.getCurrentResult().status).toBe('success');
	expect(test.transcribed).toHaveLength(2);
	expect(test.transcribed[1]).toEqual(test.transcribed[0]!);
	await eventually(() => library.resultsFor(id).length === 1);
	expect(library.resultsFor(id)[0]?.body).toBe('a steady tone\n');
});

test('Try again after the connection was removed is not sent anywhere, and says why', async () => {
	const opened = await fixture({
		transcribe: async () => Err({ message: 'busy, try later' }),
	});
	const { test } = opened;
	const { observer, failed } = await failedOnce(opened);

	await test.connections.remove(test.connectionId);
	await observer.mutate(failed.variables!).catch(() => undefined);

	expect(observer.getCurrentResult().error?.message).toContain(
		'not set up on this computer',
	);
	expect(test.transcribed).toHaveLength(1);
});

test('an answer that arrives after the pages closed is still kept', async () => {
	const held = deferred<void>();
	const opened = await fixture({
		transcribe: async () => {
			await held.promise;
			return Ok({ text: 'late but kept' });
		},
	});
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const transcribing = library.transcribe(recording.id);
	await eventually(() => library.transcribing(recording.id));

	// The person leaves: the pages close.
	library.dispose();
	held.resolve();
	await transcribing;

	const [kept, ...more] = test.outside.paths('transcriptions');
	expect(more).toEqual([]);
	expect(await test.outside.read(kept!)).toContain('late but kept\n');
});

test('deleting a recording deletes its transcripts and its audio', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	await library.transcribe(recording.id);
	await library.transcribe(recording.id);
	await eventually(() => library.resultsFor(recording.id).length === 2);

	const deletion = expectOk(
		library.deletionFor({ collection: 'recordings', id: recording.id }),
	);
	expect(deletion).toMatchObject({
		kind: 'recording',
		audio: `recordings/${recording.id}.wav`,
	});
	expect(deletion.kind === 'recording' && deletion.results).toHaveLength(2);
	expect(await library.delete(deletion)).toBeUndefined();

	await eventually(() => library.entries.length === 0);
	expect(test.outside.paths()).toEqual(['settings.md']);
});

test('a recording is kept when a result for it was saved after the person was asked', async () => {
	const opened = await fixture();
	const { test, query, library } = opened;
	const recording = await record(opened);
	const deletion = expectOk(
		library.deletionFor({ collection: 'recordings', id: recording.id }),
	);

	// Another program saves a transcript of it while the dialog is open.
	await test.outside.write(
		'transcriptions/2026-10-31T09-31-00-000Z-latecomer.md',
		`---\nrecordingId: "${recording.id}"\ncreatedAt: "2026-10-31T09:31:00.000Z"\nmodel: "whisper-1"\nendpoint: "https://api.openai.com/v1"\n---\nlate\n`,
	);
	await query.reread();
	await eventually(() => library.resultsFor(recording.id).length === 1);

	expect(await library.delete(deletion)).toContain(
		'A new result was saved for this recording after you were asked.',
	);
	expect(library.entries.map(({ id }) => id)).toEqual([recording.id]);
	expect(test.outside.paths('recordings')).toHaveLength(2);
});

test('a recording cannot be deleted, or transcribed again, while its transcription runs', async () => {
	const held = deferred<void>();
	const opened = await fixture({
		transcribe: async () => {
			await held.promise;
			return Ok({ text: 'late' });
		},
	});
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	// Two presses in one moment: the second is refused, whichever page made it.
	const first = library.transcribe(recording.id);
	const second = library.transcribe(recording.id);
	expect(expectErr(await second).message).toBe(
		'This recording is already being transcribed.',
	);
	await eventually(() => library.transcribing(recording.id));

	expect(
		expectErr(
			library.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('still being transcribed');

	held.resolve();
	expectOk(await first);
	expect(test.transcribed).toHaveLength(1);
	await eventually(() => !library.transcribing(recording.id));
	expectOk(library.deletionFor({ collection: 'recordings', id: recording.id }));
});

test('an answer whose transcript cannot be written fails, keeps nothing, and Try again sends again', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const undo = test.outside.refuse('The disk is full', {
		under: 'transcriptions',
	});

	const failed = expectErr(await library.transcribe(recording.id));
	expect(failed.name).toBe('NotSaved');
	expect(failed.message).toContain('The disk is full');
	// Nothing waits to be saved, so the recording can be deleted.
	expectOk(library.deletionFor({ collection: 'recordings', id: recording.id }));

	undo();
	expectOk(await library.transcribe(recording.id));
	expect(test.transcribed).toHaveLength(2);
	await eventually(() => library.resultsFor(recording.id).length === 1);
});

test('a note that does not read is listed for repair, and repaired as text', async () => {
	const { test, query, library } = await fixture();
	const { queryClient, noteMutations } = query;
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await test.outside.write(
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await query.reread();
	await eventually(() => library.repairs.length === 1);
	expect(library.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});

	// Text that still does not read is written as typed, and stays listed for repair.
	expectOk(
		await runMutation(queryClient, noteMutations.replace, {
			collection: 'recordings',
			id,
			seen: library.repairs[0]!.text,
			text: 'not a recording',
		}),
	);
	await eventually(
		() => library.repairs[0]?.text?.includes('not a recording') === true,
	);
	expect(library.entries).toHaveLength(0);

	expectOk(
		await runMutation(queryClient, noteMutations.replace, {
			collection: 'recordings',
			id,
			seen: 'not a recording',
			text: '---\ntitle: "Fixed"\nrecordedAt: "2026-10-31T09:30:00.000Z"\n---\nnotes\n',
		}),
	);
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(library.repairs).toEqual([]);
});
