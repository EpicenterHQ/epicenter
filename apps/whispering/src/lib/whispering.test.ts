/**
 * Whispering over its files, as the mounted app reads and writes them: the
 * web build's local variant, over this browser's files (a directory stands
 * in for OPFS). Nothing here uploads or syncs (ADR-0700).
 *
 * Key behaviors:
 * - A recording is kept at Stop as two writes, its audio and then its note
 * - A result is kept when its answer arrives, even if the pages have since
 *   closed
 * - Deleting a recording deletes its transcripts, their results, and its
 *   audio; it is refused while work for it runs
 * - An answer, or a recording, that cannot be kept stays in this window to
 *   save again
 * - A note that does not read is listed for repair and replaced as text
 *
 * Run with `--conditions=browser` (`bun run test`): the lists are Svelte
 * state, and Svelte's server runtime notifies nothing.
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
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

test('a recording is kept at Stop as two writes on this browser: its audio, then its note', async () => {
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

test('a recording whose note could not be kept is finished over its kept audio when saved again', async () => {
	const { test, whispering, library } = await fixture();
	const create = test.device.recordings.create;
	test.device.recordings.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;

	await whispering.startRecording();
	await whispering.stopRecording();

	expect(whispering.unsavedRecordings).toHaveLength(1);
	expect(whispering.unsavedRecordings[0]!.reason).toBe('The disk is full');
	const { id } = whispering.unsavedRecordings[0]!;
	expect(await readdir(join(test.root, 'device', 'recordings'))).toEqual([
		`${id}.wav`,
	]);

	test.device.recordings.create = create;
	expect(await whispering.saveRecordingAgain(id)).toBeUndefined();
	expect(whispering.unsavedRecordings).toHaveLength(0);
	await eventually(() => library.entries.length === 1);
	expect(library.entries[0]!.id).toBe(id);
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

test('a recording this browser cannot keep stays in the page, and is kept when saved again', async () => {
	const { test, whispering, library } = await fixture();
	const create = test.device.audio.create;
	test.device.audio.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'No private storage',
			cause: null,
		}) as never;

	await whispering.startRecording();
	await whispering.stopRecording();

	expect(whispering.unsavedRecordings).toHaveLength(1);
	expect(whispering.unsavedRecordings[0]!.reason).toBe('No private storage');
	expect(library.entries).toHaveLength(0);

	test.device.audio.create = create;
	expect(
		await whispering.saveRecordingAgain(whispering.unsavedRecordings[0]!.id),
	).toBeUndefined();
	expect(whispering.unsavedRecordings).toHaveLength(0);
	await eventually(() => library.entries.length === 1);
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
