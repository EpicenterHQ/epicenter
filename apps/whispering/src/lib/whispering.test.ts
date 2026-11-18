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
 * - A request goes only to the endpoint it was prepared for: one whose
 *   connection was edited or removed since is not sent, and says why
 * - A result is kept when its answer arrives, even if the pages have since
 *   closed
 * - Deleting a recording deletes its transcripts, their results, and its
 *   audio; it is refused while work for it runs or waits to be saved
 * - An answer whose result cannot be written stays in the window, and
 *   Save again writes it without sending another request
 * - A note that does not read is listed for repair and repaired as text
 *
 * Run with `--conditions=browser` (`bun run test`): the lists are Svelte
 * state, and Svelte's server runtime notifies nothing.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { RecorderError } from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { CaptureDevice } from './capture.js';
import {
	deferred,
	eventually,
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
	const { openFolder } = await import('./folder.svelte.js');
	const folder = openFolder(test.files);

	const loaded = await folder.load();
	expect(loaded.error?.message).toContain(reason);
	expect(folder.loadProblem()?.message).toContain(reason);
	expect(folder.loaded()).toBe(true);
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

	expect(await library.transcribe(recording.id)).toBeUndefined();

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
	expect(library.transcriptionRun(recording.id)).toBeUndefined();
});

/** A transcription that failed once, so Run again would send the same request. */
async function failedOnce(opened: Awaited<ReturnType<typeof fixture>>) {
	const { library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	await library.transcribe(recording.id);
	const run = library.transcriptionRun(recording.id);
	expect(run?.state.kind).toBe('failed');
	return { key: run!.key, id: recording.id };
}

test('a request whose connection was edited since it was prepared is not sent there, and says where it moved', async () => {
	const opened = await fixture({
		transcribe: async () => Err({ message: 'busy, try later' }),
	});
	const { test, library } = opened;
	const failed = await failedOnce(opened);
	expect(test.transcribed).toHaveLength(1);

	await test.connections.update(test.connectionId, {
		baseUrl: 'http://127.0.0.1:18081/v1',
	});
	expect(await library.runAgain(failed.key)).toBeUndefined();

	const state = library.transcriptionRun(failed.id)?.state;
	expect(state?.kind).toBe('failed');
	expect(state?.kind === 'failed' && state.message).toContain(
		`prepared for Test endpoint at ${TEST_BASE_URL}, which now sends to http://127.0.0.1:18081/v1, so nothing was sent`,
	);
	expect(test.transcribed).toHaveLength(1);
});

test('a request whose connection was removed since it was prepared is not sent anywhere else, and names it', async () => {
	const opened = await fixture({
		transcribe: async () => Err({ message: 'busy, try later' }),
	});
	const { test, library } = opened;
	const failed = await failedOnce(opened);

	await test.connections.remove(test.connectionId);
	expect(await library.runAgain(failed.key)).toBeUndefined();

	const state = library.transcriptionRun(failed.id)?.state;
	expect(state?.kind === 'failed' && state.message).toContain(
		'Test endpoint is no longer set up, so nothing was sent',
	);
	expect(test.transcribed).toHaveLength(1);
	// Nothing is chosen at an endpoint that is gone, so a new request is refused before it starts.
	expect(await library.transcribe(failed.id)).toContain(
		'not set up on this computer',
	);
});

test('a transformation of a transcript, and of pasted text, keeps its result once answered', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	await library.transcribe(recording.id);
	await eventually(() => library.resultsFor(recording.id).length === 1);
	const transcript = library.resultsFor(recording.id)[0]!;
	expect(
		await library.createTransformation({
			title: 'Clean up',
			prompt: 'Fix it.',
		}),
	).toBeUndefined();
	await eventually(() => library.transformations.length === 1);
	const recipe = library.transformations[0]!;

	expect(await library.transform(transcript.id, recipe.id)).toBeUndefined();
	expect(
		await library.transformText(recipe.id, 'pasted words'),
	).toBeUndefined();

	await eventually(() => library.outputsFor(transcript.id).length === 1);
	expect(library.outputsFor(transcript.id)[0]).toMatchObject({
		recordingId: recording.id,
		transformationTitle: 'Clean up',
		prompt: 'Fix it.',
		input: 'um so a steady tone\n',
		body: 'Transformed: um so a steady tone\n',
	});
	await eventually(() => library.textOutputsOf(recipe.id).length === 1);
	expect(library.textOutputsOf(recipe.id)[0]!.body).toBe(
		'Transformed: pasted words\n',
	);
	expect(test.transformed.map((request) => request.model)).toEqual([
		'connection-model',
		'connection-model',
	]);
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
	await eventually(
		() => library.transcriptionRun(recording.id)?.state.kind === 'running',
	);

	// The person leaves: the pages close.
	library.dispose();
	held.resolve();
	await transcribing;

	const [kept, ...more] = test.outside.paths('transcriptions');
	expect(more).toEqual([]);
	expect(await test.outside.read(kept!)).toContain('late but kept\n');
});

test('deleting a recording deletes its transcripts, their results, and its audio', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	await library.transcribe(recording.id);
	await eventually(() => library.resultsFor(recording.id).length === 1);
	await library.createTransformation({
		title: 'Clean up',
		prompt: 'Fix it.',
	});
	await eventually(() => library.transformations.length === 1);
	const transcript = library.resultsFor(recording.id)[0]!;
	await library.transform(transcript.id, library.transformations[0]!.id);
	await eventually(() => library.outputsFor(transcript.id).length === 1);

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
	expect(test.outside.paths()).toEqual([
		'settings.md',
		// The recipe stays; a recording owns none.
		`transformations/${library.transformations[0]!.id}.md`,
	]);
});

test('a recording cannot be deleted while its transcription runs', async () => {
	const held = deferred<void>();
	const opened = await fixture({
		transcribe: async () => {
			await held.promise;
			return Ok({ text: 'late' });
		},
	});
	const { library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const transcribing = library.transcribe(recording.id);
	await eventually(
		() => library.transcriptionRun(recording.id)?.state.kind === 'running',
	);

	expect(
		expectErr(
			library.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('still running');

	held.resolve();
	await transcribing;
	expectOk(library.deletionFor({ collection: 'recordings', id: recording.id }));
});

test('an answer whose result cannot be written stays in the window, and Save again writes it without another request', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const undo = test.outside.refuse('The disk is full', {
		under: 'transcriptions',
	});

	expect(await library.transcribe(recording.id)).toBeUndefined();
	const run = library.transcriptionRun(recording.id);
	expect(run?.state).toMatchObject({
		kind: 'unsaved',
		text: 'um so a steady tone',
	});
	expect(run?.state.kind === 'unsaved' && run.state.message).toContain(
		'The disk is full',
	);
	// The answer is not saved, so the recording is not deleted from under it.
	expect(
		expectErr(
			library.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('was not saved');

	undo();
	expect(await library.runAgain(run!.key)).toBeUndefined();
	expect(library.transcriptionRun(recording.id)).toBeUndefined();
	await eventually(() => library.resultsFor(recording.id).length === 1);
	// Saved without another request.
	expect(test.transcribed).toHaveLength(1);
});

test('a note that does not read is listed for repair, and repaired as text', async () => {
	const { test, folder, library } = await fixture();
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await test.outside.write(
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await folder.load();
	await eventually(() => library.repairs.length === 1);
	expect(library.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});

	// Text that still does not read is written as typed, and stays listed for repair.
	expectOk(await folder.recordings.replace({ id }, 'not a recording'));
	await eventually(
		() => library.repairs[0]?.text?.includes('not a recording') === true,
	);
	expect(library.entries).toHaveLength(0);

	expectOk(
		await folder.recordings.replace(
			{ id },
			'---\ntitle: "Fixed"\nrecordedAt: "2026-10-31T09:30:00.000Z"\n---\nnotes\n',
		),
	);
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(library.repairs).toEqual([]);
});
