/**
 * Whispering over its files, as the mounted app reads and writes them: the
 * web build's local variant, over this browser's files (a place in memory
 * stands in for OPFS). Nothing here uploads or syncs (ADR-0700).
 *
 * Key behaviors:
 * - A recording's audio lands at Stop, and its note, with its length, once
 *   Stop has answered with its audio at its path
 * - A take is on the record screen until Stop answers, not in the library
 * - While the files refuse writes, a recording waits in the folder and
 *   lands when they take it again, its audio before its note
 * - On the desktop, audio no note names (a note the page closed before it
 *   landed, a placement that failed) gets its note from the next launch's
 *   recovery, which runs beside the pages; what it cannot complete is said
 * - A transcription sends the recording's audio to the model chosen for it,
 *   and its transcript names that model and where it went
 * - A request goes only to the endpoint it was prepared for: one whose
 *   connection was edited or removed since is not sent, and says why
 * - A result is kept when its answer arrives, even if the pages have since
 *   closed
 * - Deleting a recording deletes its transcripts, their results, and its
 *   audio; it is refused while work for it runs
 * - An answer whose result cannot land yet waits in the folder, and the
 *   run ends when it lands
 * - A note that does not read is listed for repair and repaired as text
 *
 * Run with `--conditions=browser` (`bun run test`): the lists are Svelte
 * state, and Svelte's server runtime notifies nothing.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder';
import { RecorderError } from '@epicenter/recorder';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { CaptureDevice } from './capture.js';
import { whispering as whisperingContract } from './contract.js';
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

/** The app over a fresh place of this browser's files. */
async function fixture(options: TestServicesOptions = {}) {
	const test = await openTestServices(options);
	cleanups.push(test.close);
	const opened = await createTestWhispering({
		services: test.services,
		place: test.place,
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
	cleanups.push(test.close);
	let whenStopped: string[] = [];
	const opened = await createTestWhispering({
		services: {
			...test.services,
			capture: afterStop(test.services.capture, () => {
				whenStopped = test.outside.paths('recordings');
			}),
		},
		place: test.place,
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
	cleanups.push(test.close);
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
		place: test.place,
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

test('a recording made while the files refuse writes lands when they take them again, its audio before its note', async () => {
	const { test, folder, whispering, library } = await fixture();
	const undo = test.outside.refuse('The disk is full', { under: 'recordings' });

	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	const stopping = whispering.stopRecording();
	await eventually(() => test.files.unavailable() !== null);
	expect(library.entries).toHaveLength(0);
	expect(test.outside.paths('recordings')).toEqual([]);

	undo();
	await stopping;
	await eventually(() => library.entries.length === 1);
	const [recording] = library.entries;
	expect(test.outside.paths('recordings')).toEqual([
		`recordings/${recording!.id}.md`,
		`recordings/${recording!.id}.wav`,
	]);
	expect(folder.saving()).toBe(false);
	expect(whispering.recorderError).toBeUndefined();
});

/** A capture that answers every audio file no note names as whole, as the desktop's does. */
const namesUnnamed = async (unnamed: readonly string[]) =>
	Ok({
		whole: unnamed.map((path) => ({
			id: path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, ''),
			durationMs: null,
		})),
		unplaced: [],
	});

test('on the desktop, a recording whose note has not landed when the window closes gets one from the next launch, its length read from its audio', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
	// The audio lands at Stop; the files refuse every write after it, so the
	// note waits in the page's folder.
	let undo = () => {};
	let stopped = false;
	const first = await createTestWhispering({
		services: {
			...test.services,
			capture: afterStop(test.services.capture, () => {
				undo = test.outside.refuse('The disk is full', {
					under: 'recordings',
				});
				stopped = true;
			}),
		},
		place: test.place,
	});
	await first.whispering.startRecording();
	void first.whispering.stopRecording();
	await eventually(() => stopped && first.folder.saving());
	expect(first.library.entries).toHaveLength(0);
	expect(first.whispering.recorderError).toBeUndefined();
	// The page closes with the note still waiting: it is not made.
	first.close();

	undo();
	const services = {
		...test.services,
		capture: { ...test.services.capture, recover: namesUnnamed },
	};
	const next = await createTestWhispering({ services, place: test.place });
	cleanups.push(next.close);
	await eventually(() => next.library.entries.length === 1);
	expect(next.library.entries[0]).toMatchObject({
		title: 'Recovered recording',
		durationMs: 1000,
	});
});

test('a recording the shell could not place gets its note when the next launch places it', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
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
			if (staged === undefined) return Ok({ whole: [], unplaced: [] });
			await test.outside.write(`recordings/${staged.id}.wav`, staged.bytes);
			return Ok({
				whole: [{ id: staged.id, durationMs: 1000 }],
				unplaced: [],
			});
		},
	};
	const services = { ...test.services, capture };
	const first = await createTestWhispering({ services, place: test.place });
	await first.whispering.startRecording();
	await first.whispering.stopRecording();
	expect(first.whispering.recorderError).toContain(
		'could not be moved into place',
	);
	expect(first.library.entries).toHaveLength(0);
	first.close();

	const next = await createTestWhispering({ services, place: test.place });
	cleanups.push(next.close);
	await eventually(() => next.library.entries.length === 1);
	expect(next.library.entries[0]).toMatchObject({
		id: staged!.id,
		durationMs: 1000,
	});
	expect(next.whispering.recorderError).toBeUndefined();
});

test('on the desktop the pages do not wait for the cut-off recordings, which are listed once complete', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
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
				whole: [{ id: '2026-10-31T09-30-00-000Z-cutoffaa', durationMs: 2000 }],
				unplaced: [],
			});
		},
	};
	const opened = await createTestWhispering({
		services: { ...test.services, capture },
		place: test.place,
	});
	cleanups.push(opened.close);
	await eventually(() => asked);
	// The pages read the library while the shell finishes the cut-off audio.
	expect(opened.library.entries).toEqual([]);

	recovering.resolve();
	await eventually(() => opened.library.entries.length === 1);
	expect(opened.library.entries[0]).toMatchObject({ durationMs: 2000 });
});

test('files that cannot be listed at all keep the folder opening, saying why', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
	// A private window: every call is refused, the listing included.
	const reason =
		'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).';
	test.outside.refuseReads(reason);
	test.outside.refuse(reason);
	const folder = openFolder(whisperingContract, test.place);
	cleanups.push(() => folder[Symbol.dispose]());

	await eventually(() => folder.unavailable() !== null);
	expect(folder.state().status).toBe('opening');
});

test('on the desktop, a cut-off recording that cannot be completed is said, and left for the next launch', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
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
		place: test.place,
	});
	cleanups.push(opened.close);

	await eventually(() => opened.whispering.recorderError !== undefined);
	expect(opened.whispering.recorderError).toBe(
		'Recordings a quit or a crash cut off could not be completed: The recording could not be captured: the disk is full',
	);
	expect(opened.library.entries).toHaveLength(0);
});

test('on the desktop, a recording kept outside its path, because another file is there, is said with where its audio is, and gets no note', async () => {
	const test = await openTestServices();
	cleanups.push(test.close);
	test.services.capture.recover = async () =>
		Ok({
			whole: [],
			unplaced: [
				{
					path: 'recordings/2026-10-31T09-30-00-000Z-cutoffaa.webm',
					pending:
						'.epicenter/recordings/recordings/2026-10-31T09-30-00-000Z-cutoffaa.webm',
				},
			],
		});
	const opened = await createTestWhispering({
		services: test.services,
		place: test.place,
	});
	cleanups.push(opened.close);

	await eventually(() => opened.whispering.recorderError !== undefined);
	expect(opened.whispering.recorderError).toBe(
		'A recording is kept outside the library, because another file is at its path: its audio is at .epicenter/recordings/recordings/2026-10-31T09-30-00-000Z-cutoffaa.webm in this folder, and recordings/2026-10-31T09-30-00-000Z-cutoffaa.webm is another file. Move the other file, and the next start adds it.',
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

	const kept = expectOk(await test.files.transcriptions.list()).items;
	expect(kept.map(({ body }) => body)).toEqual(['late but kept\n']);
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
	const left = test.outside.paths();
	expect(
		left.filter((path) => /\.(md|wav)$/.test(path) && !path.startsWith('.')),
	).toEqual([
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

test('an answer whose result cannot land yet waits in the folder, and the run ends when it lands', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const undo = test.outside.refuse('The disk is full', {
		under: 'transcriptions',
	});

	const transcribing = library.transcribe(recording.id);
	await eventually(
		() => library.transcriptionRun(recording.id)?.state.kind === 'saving',
	);
	// Its result is on its way, so the recording is not deleted under it.
	expect(
		expectErr(
			library.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('still running');

	undo();
	await transcribing;
	expect(library.transcriptionRun(recording.id)).toBeUndefined();
	await eventually(() => library.resultsFor(recording.id).length === 1);
	// Landed without another request.
	expect(test.transcribed).toHaveLength(1);
});

test('a note that does not read is listed for repair, and repaired as text', async () => {
	const { test, folder, library } = await fixture();
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await test.outside.write(
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await eventually(() => library.repairs.length === 1);
	expect(library.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});

	// Text that still does not read is written as typed, and stays listed for repair.
	const edit = folder.recordings.edit({ id });
	edit.text = 'not a recording';
	await edit.landed();
	await eventually(
		() => library.repairs[0]?.text?.includes('not a recording') === true,
	);
	expect(library.entries).toHaveLength(0);

	edit.text =
		'---\ntitle: Fixed\nrecordedAt: 2026-10-31T09:30:00.000Z\n---\nnotes\n';
	await edit.landed();
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(library.repairs).toEqual([]);
});
