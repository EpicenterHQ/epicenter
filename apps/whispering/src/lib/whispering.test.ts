/**
 * Whispering over its files, as the mounted app reads and writes them: the
 * web build's local variant, over this browser's files (a directory stands
 * in for OPFS). Nothing here uploads or syncs (ADR-0700).
 *
 * Key behaviors:
 * - A recording's audio is written into the files as it records, and its
 *   note, with its length, once its audio is at its path after Stop
 * - A take is on the record screen until its audio is placed, not in the
 *   library, and the next take can start meanwhile
 * - A recording the files cannot take leaves no note
 * - Audio no note names (a note not written, a placement that failed, a
 *   closed tab) gets its note from the next start's recovery
 * - A result is kept when its answer arrives, even if the pages have since
 *   closed
 * - Deleting a recording deletes its transcripts, their results, and its
 *   audio; it is refused while work for it runs
 * - An answer that cannot be kept stays in this window to save again
 * - A note that does not read is listed for repair and replaced as text
 *
 * Run with `--conditions=browser` (`bun run test`): the lists are Svelte
 * state, and Svelte's server runtime notifies nothing.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { type CaptureDevice, CaptureError, toneWav } from './capture.js';
import {
	deferred,
	eventually,
	openTestServices,
	type TestServicesOptions,
} from './services.test-support.js';
import { headerLine, openTestWhispering } from './whispering.test-support.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The app over a fresh directory of this browser's files. */
async function fixture(options: TestServicesOptions = {}) {
	const test = await openTestServices(options);
	cleanups.push(test.remove);
	const opened = await openTestWhispering({
		services: test.services,
		client: test.device,
	});
	cleanups.push(opened.close);
	return { test, ...opened };
}

/** Record with the fixture device and wait until the library lists it. */
async function record({
	whispering,
	library,
}: Awaited<ReturnType<typeof fixture>>) {
	const before = library.entries.length;
	await whispering.startRecording();
	await whispering.stopRecording();
	// The note is written once, with its length, at Stop.
	await eventually(() => library.entries.length === before + 1);
	return library.entries[0]!;
}

/** A file written straight into a directory, as another program would. */
async function put(root: string, path: string, data: string | Uint8Array) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), data);
}

/** The note files in one directory's `collection`. */
const notesIn = async (root: string, collection: string) =>
	(await readdir(join(root, collection)).catch(() => [] as string[])).filter(
		(name) => name.endsWith('.md'),
	);

test('a recording’s audio is written as it records, and its note, with its length, once at Stop', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const writes: string[] = [];
	const { audio, recordings } = test.device;
	const createAudio = audio.create;
	const createNote = recordings.create;
	audio.create = (value) => {
		writes.push('audio');
		return createAudio(value);
	};
	recordings.create = (value) => {
		writes.push('note');
		return createNote(value);
	};

	const recording = await record(opened);

	expect(writes).toEqual(['audio', 'note']);
	expect(recording).toMatchObject({ capture: 'fixture' });
	expect(recording.durationMs).toBe(1000);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	expect(library.audioOf(recording.id)).toMatchObject({
		kind: 'here',
		file: { ext: 'wav' },
	});
	expect(
		(await readdir(join(test.root, 'device', 'recordings'))).sort(),
	).toEqual([`${recording.id}.md`, `${recording.id}.wav`]);
	expect(headerLine(library).label).toBe('On this browser');
});

test('a take is on the record screen, not in the library, until its audio is placed; the next can start meanwhile', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	// The desktop's shape: Stop answers once the WAV is finalized, and the
	// shell places the audio later.
	const placements: ReturnType<
		typeof deferred<Result<{ unencoded?: string }, CaptureError>>
	>[] = [];
	const capture: CaptureDevice = {
		...test.services.capture,
		async start({ id }) {
			return Ok({
				startedAt: 0,
				onEnded: () => () => {},
				async stop() {
					const placement =
						deferred<Result<{ unencoded?: string }, CaptureError>>();
					placements.push(placement);
					return Ok({
						durationMs: 1500,
						placed: placement.promise.then(async (placed) => {
							await put(
								join(test.root, 'device'),
								`recordings/${id}.webm`,
								'placed by the shell',
							);
							return placed;
						}),
					});
				},
			});
		},
	};
	const { whispering, library } = await openTestWhispering({
		services: { ...test.services, capture },
		client: test.device,
	});
	cleanups.push(() => whispering.dispose());

	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	expect(library.entries).toHaveLength(0);
	const stopping = whispering.stopRecording();
	await eventually(() => whispering.finishing === 1);
	expect(whispering.recorder.phase).toBe('idle');
	expect(library.entries).toHaveLength(0);

	// The microphone is free while the first is still being placed.
	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	const second = whispering.stopRecording();
	await eventually(() => whispering.finishing === 2);

	placements[0]!.resolve(Ok({}));
	await stopping;
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({ durationMs: 1500 });
	expect(library.audioOf(library.entries[0]!.id).kind).toBe('here');
	expect(whispering.finishing).toBe(1);

	placements[1]!.resolve(Ok({ unencoded: 'the encoder refused it' }));
	await second;
	await eventually(() => library.entries.length === 2);
	expect(whispering.finishing).toBe(0);
	expect(whispering.recorderError).toBe(
		'The recording could not be encoded (the encoder refused it), so it was kept as a WAV.',
	);
});

test('a recording whose audio the files do not take leaves no note behind', async () => {
	const { test, whispering, library } = await fixture();
	test.device.audio.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;

	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	await whispering.stopRecording();

	expect(whispering.recorderError).toBe(
		'The recording could not be saved: The disk is full',
	);
	expect(library.entries).toHaveLength(0);
	expect(
		await readdir(join(test.root, 'device', 'recordings')).catch(() => []),
	).toEqual([]);
});

/** A capture that answers every audio file no note names as whole, as the desktop's does. */
const namesUnnamed = async (unnamed: readonly string[]) =>
	Ok(unnamed.map((id) => ({ id, durationMs: null })));

test('a recording whose note is not written at Stop gets one from the next start, its length read from its audio', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	const createNote = test.device.recordings.create;
	test.device.recordings.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;
	const first = await openTestWhispering({
		services: test.services,
		client: test.device,
	});
	await first.whispering.startRecording();
	await first.whispering.stopRecording();
	expect(first.whispering.recorderError).toBe(
		'The recording was kept, but its note could not be written: The disk is full',
	);
	expect(first.library.entries).toHaveLength(0);
	first.close();

	test.device.recordings.create = createNote;
	const services = {
		...test.services,
		capture: { ...test.services.capture, recover: namesUnnamed },
	};
	const next = await openTestWhispering({ services, client: test.device });
	cleanups.push(next.close);
	await eventually(() => next.library.entries.length === 1);
	expect(next.library.entries[0]).toMatchObject({
		title: 'Recovered recording',
		durationMs: 1000,
	});
	expect(next.whispering.recorderError).toBeUndefined();
});

test('a recording the shell could not place gets its note when the next start places it', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	let staged: { id: string; bytes: Uint8Array } | undefined;
	// The desktop's shape: the audio waits outside its path, its placement
	// fails, and the next start's recover places it.
	const capture: CaptureDevice = {
		...test.services.capture,
		async start({ id }) {
			return Ok({
				startedAt: 0,
				onEnded: () => () => {},
				async stop() {
					staged = { id, bytes: toneWav({ seconds: 1 }) };
					return Ok({
						durationMs: 1000,
						placed: Promise.resolve(
							CaptureError.Failed({
								cause: new Error(
									`recordings/${id}.webm could not be moved into place`,
								),
							}),
						),
					});
				},
			});
		},
		async recover() {
			if (staged === undefined) return Ok([]);
			await put(
				join(test.root, 'device'),
				`recordings/${staged.id}.wav`,
				staged.bytes,
			);
			return Ok([{ id: staged.id, durationMs: 1000 }]);
		},
	};
	const services = { ...test.services, capture };
	const first = await openTestWhispering({ services, client: test.device });
	await first.whispering.startRecording();
	await first.whispering.stopRecording();
	expect(first.whispering.recorderError).toContain(
		'could not be moved into place',
	);
	expect(first.library.entries).toHaveLength(0);
	first.close();

	const next = await openTestWhispering({ services, client: test.device });
	cleanups.push(next.close);
	await eventually(() => next.library.entries.length === 1);
	expect(next.library.entries[0]).toMatchObject({
		id: staged!.id,
		durationMs: 1000,
	});
	expect(next.whispering.recorderError).toBeUndefined();
});

test('a start gives a recording a closed tab cut off its note, its length read from its audio', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	const id = '2026-10-31T09-30-00-000Z-cutoffaa';
	const audio = new Uint8Array(
		await Bun.file(
			new URL(
				'../../../../packages/recorder/src/fixtures/chromium.m4a',
				import.meta.url,
			),
		).arrayBuffer(),
	);
	await put(join(test.root, 'device'), `recordings/${id}.m4a`, audio);
	const services = {
		...test.services,
		capture: { ...test.services.capture, recover: namesUnnamed },
	};
	const opened = await openTestWhispering({ services, client: test.device });
	cleanups.push(opened.close);

	await eventually(() => opened.library.entries.length === 1);
	expect(opened.library.entries[0]).toMatchObject({
		id,
		title: 'Recovered recording',
		recordedAt: '2026-10-31T09:30:00.000Z',
		durationMs: 960,
	});
	expect(opened.whispering.recorderError).toBeUndefined();
});

test('files that cannot be listed at all are said by the banner alone, not again as a recovery failure', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	// A private window: every call is refused, the listing included.
	test.device.recordings.list = async () =>
		Err({
			name: 'Unavailable',
			message:
				'UnknownError: The operation failed for an unknown transient reason (e.g. out of memory).',
			cause: null,
		}) as never;
	const opened = await openTestWhispering({
		services: test.services,
		client: test.device,
	});
	cleanups.push(opened.close);

	await eventually(() => opened.library.error !== null);
	expect(opened.whispering.recorderError).toBeUndefined();
});

test('a cut-off recording whose repair fails is said, and left for the next start', async () => {
	const test = await openTestServices();
	cleanups.push(test.remove);
	await put(
		join(test.root, 'device'),
		'recordings/2026-10-31T09-30-00-000Z-cutoffaa.m4a',
		'a closed tab left it',
	);
	test.services.capture.recover = async () =>
		Err({
			name: 'Failed',
			message: 'The recording could not be captured: the disk is full',
			cause: null,
		}) as never;
	const opened = await openTestWhispering({
		services: test.services,
		client: test.device,
	});
	cleanups.push(opened.close);

	expect(opened.whispering.recorderError).toBe(
		'Recordings a quit or a crash cut off could not be completed: The recording could not be captured: the disk is full',
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
	expect(test.transcribed[0]!.bytes).toEqual(toneWav());
	await eventually(() => library.resultsFor(recording.id).length === 1);
	expect(library.resultsFor(recording.id)[0]).toMatchObject({
		recordingId: recording.id,
		model: 'verification-model',
		body: 'um so a steady tone\n',
	});
	expect(
		await notesIn(join(test.root, 'device'), 'transcriptions'),
	).toHaveLength(1);
	expect(library.transcriptionRun(recording.id)).toBeUndefined();
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

	const [name] = await notesIn(join(test.root, 'device'), 'transcriptions');
	expect(
		expectOk(
			await test.device.transcriptions.get({
				id: name!.slice(0, -'.md'.length),
			}),
		).body,
	).toBe('late but kept\n');
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
	const left = await readdir(join(test.root, 'device'), { recursive: true });
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

test('an answer whose result cannot be kept stays in this window until saved again', async () => {
	const opened = await fixture();
	const { test, library } = opened;
	const recording = await record(opened);
	await eventually(() => library.audioOf(recording.id).kind === 'here');
	const create = test.device.transcriptions.create;
	test.device.transcriptions.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;

	await library.transcribe(recording.id);

	const run = library.transcriptionRun(recording.id);
	expect(run?.state).toEqual({
		kind: 'unsaved',
		text: 'um so a steady tone',
		message: 'The disk is full',
	});
	expect(headerLine(library)).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});

	test.device.transcriptions.create = create;
	await library.saveAgain(run!.key);
	expect(library.transcriptionRun(recording.id)).toBeUndefined();
	await eventually(() => library.resultsFor(recording.id).length === 1);
	// Saved again without another request.
	expect(test.transcribed).toHaveLength(1);
});

test('a note that does not read is listed for repair, and replaced as text', async () => {
	const { test, library } = await fixture();
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await put(
		join(test.root, 'device'),
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await eventually(() => library.repairs.length === 1);
	expect(library.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});

	expect(
		(await library.replace({ collection: 'recordings', id }, 'not a recording'))
			.error?.name,
	).toBe('Invalid');
	expect(
		(
			await library.replace(
				{ collection: 'recordings', id },
				'---\ntitle: Fixed\nrecordedAt: 2026-10-31T09:30:00.000Z\ncapture: microphone\n---\nnotes\n',
			)
		).error,
	).toBeNull();

	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(library.repairs).toEqual([]);
});
