/**
 * Whispering over its two views (decision 76), as the mounted app reads and
 * writes them: "On this device" over this browser's files, and "Synced"
 * over the repository (a second directory stands in for it). They are
 * never merged; the uploader that moves files between them is
 * `@epicenter/folder`'s, tested there and end to end.
 *
 * Key behaviors:
 * - A recording is kept at Stop as one capture (audio and note) on the
 *   device, queued to upload, and listed under "On this device"
 * - Each view reads, writes and deletes its own client's files only
 * - In "Synced", audio is read from this device's cache of what it
 *   uploaded, then the repository
 * - A result is kept when its answer arrives, in the files of the view it
 *   was asked from, even if that view has since closed
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
import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Version } from '@epicenter/definition/contract';
import { gitBlobHash, writePointer } from '@epicenter/definition/merge';
import { outboxOf } from '@epicenter/folder/node';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { toneWav } from './capture.js';
import type { Library } from './library.svelte.js';
import {
	deferred,
	eventually,
	openTestServices,
	replacing,
	type TestServicesOptions,
} from './services.test-support.js';
import { headerLine, openTestWhispering } from './whispering.test-support.js';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The app over a fresh device and, with `signedIn`, "Synced" over the stand-in repository. */
async function fixture({
	signedIn = false,
	repository: change,
	...options
}: TestServicesOptions & {
	signedIn?: boolean;
	/** Change how the repository answers. */
	repository?: (
		repository: Awaited<ReturnType<typeof openTestServices>>['repository'],
	) => Awaited<ReturnType<typeof openTestServices>>['repository'];
} = {}) {
	const test = await openTestServices(options);
	cleanups.push(test.remove);
	const repository = signedIn
		? (change?.(test.repository) ?? test.repository)
		: null;
	const opened = await openTestWhispering({
		services: test.services,
		device: test.device,
		repository,
	});
	cleanups.push(opened.close);
	return { test, ...opened };
}

/** Record with the fixture device and wait until "On this device" lists it. */
async function record({
	whispering,
	onDevice,
}: Awaited<ReturnType<typeof fixture>>) {
	const before = onDevice.entries.length;
	await whispering.startRecording();
	await whispering.stopRecording();
	await eventually(() => onDevice.entries.length === before + 1);
	return onDevice.entries[0]!;
}

/** A file written straight into a directory, as another program would. */
async function put(root: string, path: string, data: string | Uint8Array) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), data);
}

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

/** A recording note as another program would write it. */
const recordingNote = (title: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-10-31T09:30:00.000Z\ndurationMs: 1000\ncapture: microphone\n---\n`;

/** The note files in one directory's `collection`. */
const notesIn = async (root: string, collection: string) =>
	(await readdir(join(root, collection)).catch(() => [] as string[])).filter(
		(name) => name.endsWith('.md'),
	);

test('a recording is kept at Stop as one capture on this device, queued to upload', async () => {
	const opened = await fixture();
	const { test, onDevice } = opened;
	const recording = await record(opened);

	expect(recording).toMatchObject({ capture: 'fixture' });
	expect(recording.durationMs).toBe(1000);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	expect(onDevice.audioOf(recording.id)).toMatchObject({
		kind: 'here',
		file: { ext: 'wav', cached: false },
	});
	const { items } = expectOk(await outboxOf(test.device).list());
	expect(items.map((capture) => Object.keys(capture.paths).sort())).toEqual([
		[`recordings/${recording.id}.md`, `recordings/${recording.id}.wav`],
	]);
	expect(headerLine(onDevice).label).toBe('On this device');
});

test('signed in, a recording is still kept on this device, and is not in Synced until it uploads', async () => {
	const opened = await fixture({ signedIn: true });
	const { test, synced } = opened;
	const recording = await record(opened);

	expect(await notesIn(join(test.root, 'device'), 'recordings')).toEqual([
		`${recording.id}.md`,
	]);
	await eventually(() => !synced!.listing);
	expect(synced!.entries).toEqual([]);
	expect(await notesIn(join(test.root, 'repository'), 'recordings')).toEqual(
		[],
	);
});

test('on this device, a transcription sends the device’s audio and keeps its transcript there', async () => {
	const opened = await fixture();
	const { test, onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');

	expect(await onDevice.transcribe(recording.id)).toBeUndefined();

	expect(test.transcribed).toHaveLength(1);
	expect(test.transcribed[0]!.bytes).toEqual(toneWav());
	await eventually(() => onDevice.resultsFor(recording.id).length === 1);
	expect(onDevice.resultsFor(recording.id)[0]).toMatchObject({
		recordingId: recording.id,
		model: 'verification-model',
		body: 'um so a steady tone\n',
	});
	expect(
		await notesIn(join(test.root, 'device'), 'transcriptions'),
	).toHaveLength(1);
	expect(onDevice.transcriptionRun(recording.id)).toBeUndefined();
});

test('in Synced, audio is read from this device’s cache before the repository is asked, and the transcript goes to the repository', async () => {
	const bytes = new Uint8Array([9, 8, 7, 6]);
	let downloads = 0;
	const { test, synced } = await fixture({
		signedIn: true,
		// As the server lists an LFS file: by its pointer's blob id.
		repository: (repository) =>
			replacing(
				replacing(repository, 'audio', {
					async list() {
						const listed = await repository.audio.list();
						if (listed.error !== null) return listed;
						return Ok({
							items: listed.data.items.map((item) => ({
								...item,
								version: gitBlobHash(
									writePointer({ oid: sha256(bytes), size: bytes.length }),
								) as Version,
							})),
						});
					},
				}),
				'audio',
				{
					async get(args) {
						downloads += 1;
						return repository.audio.get(args);
					},
				},
			),
	});
	const id = '2026-10-31T09-30-00-000Z-cachedaa';
	await put(join(test.root, 'repository'), `recordings/${id}.m4a`, bytes);
	await put(
		join(test.root, 'repository'),
		`recordings/${id}.md`,
		recordingNote('Uploaded'),
	);
	// What the upload kept when it let go of the device's copy.
	await put(
		join(test.root, 'device'),
		`.epicenter/cache/recordings/${id}.m4a`,
		bytes,
	);

	// The cache is read again after each listing of the audio, so its mark
	// follows. The note lists on its own, in its own time.
	await eventually(() => {
		const audio = synced!.audioOf(id);
		return (
			audio.kind === 'here' &&
			audio.file.cached &&
			synced!.entries.some((entry) => entry.id === id)
		);
	});
	expect(await synced!.transcribe(id)).toBeUndefined();

	expect(test.transcribed[0]!.bytes).toEqual(bytes);
	expect(downloads).toBe(0);
	await eventually(() => synced!.resultsFor(id).length === 1);
	expect(
		await notesIn(join(test.root, 'repository'), 'transcriptions'),
	).toHaveLength(1);
	expect(await notesIn(join(test.root, 'device'), 'transcriptions')).toEqual(
		[],
	);
});

test('in Synced, audio only the repository holds is downloaded', async () => {
	const bytes = new Uint8Array([1, 1, 2, 3]);
	const { test, synced } = await fixture({ signedIn: true });
	const id = '2026-10-31T09-30-00-000Z-elsewher';
	await put(join(test.root, 'repository'), `recordings/${id}.webm`, bytes);
	await put(
		join(test.root, 'repository'),
		`recordings/${id}.md`,
		recordingNote('From the desktop'),
	);
	await eventually(() => synced!.audioOf(id).kind === 'here');

	const read = expectOk(await synced!.readAudio(id));

	expect(read).toMatchObject({
		ext: 'webm',
		mimeType: 'audio/webm',
		name: `${id}.webm`,
	});
	expect(read.bytes).toEqual(bytes);
});

test('each view lists, edits and deletes only its own client’s files', async () => {
	const { test, onDevice, synced } = await fixture({ signedIn: true });
	const here = '2026-10-31T09-30-00-000Z-heredevi';
	const there = '2026-10-31T09-31-00-000Z-thererep';
	await put(
		join(test.root, 'device'),
		`recordings/${here}.md`,
		recordingNote('Here'),
	);
	await put(
		join(test.root, 'repository'),
		`recordings/${there}.md`,
		recordingNote('There'),
	);
	await eventually(
		() => onDevice.entries.length === 1 && synced!.entries.length === 1,
	);
	expect(onDevice.entries.map((note) => note.id)).toEqual([here]);
	expect(synced!.entries.map((note) => note.id)).toEqual([there]);

	expectOk(
		await synced!.files.recordings.update({ id: there }, { title: 'Renamed' }),
	);
	expect(
		expectOk(await test.repository.recordings.get({ id: there })).title,
	).toBe('Renamed');

	const deletion = expectOk(
		synced!.deletionFor({ collection: 'recordings', id: there }),
	);
	expect(await synced!.delete(deletion)).toBeUndefined();
	await eventually(() => synced!.entries.length === 0);
	expect(onDevice.entries.map((note) => note.id)).toEqual([here]);
	expect(await notesIn(join(test.root, 'device'), 'recordings')).toEqual([
		`${here}.md`,
	]);
	expect(headerLine(synced!, true).label).toBe('Synced');
});

test('a transformation of a transcript, and of pasted text, keeps its result once answered', async () => {
	const opened = await fixture();
	const { test, onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	await onDevice.transcribe(recording.id);
	await eventually(() => onDevice.resultsFor(recording.id).length === 1);
	const transcript = onDevice.resultsFor(recording.id)[0]!;
	expect(
		await onDevice.createTransformation({
			title: 'Clean up',
			prompt: 'Fix it.',
		}),
	).toBeUndefined();
	await eventually(() => onDevice.transformations.length === 1);
	const recipe = onDevice.transformations[0]!;

	expect(await onDevice.transform(transcript.id, recipe.id)).toBeUndefined();
	expect(
		await onDevice.transformText(recipe.id, 'pasted words'),
	).toBeUndefined();

	await eventually(() => onDevice.outputsFor(transcript.id).length === 1);
	expect(onDevice.outputsFor(transcript.id)[0]).toMatchObject({
		recordingId: recording.id,
		transformationTitle: 'Clean up',
		prompt: 'Fix it.',
		input: 'um so a steady tone\n',
		body: 'Transformed: um so a steady tone\n',
	});
	await eventually(() => onDevice.textOutputsOf(recipe.id).length === 1);
	expect(onDevice.textOutputsOf(recipe.id)[0]!.body).toBe(
		'Transformed: pasted words\n',
	);
	expect(test.transformed.map((request) => request.model)).toEqual([
		'connection-model',
		'connection-model',
	]);
});

test('an answer that arrives after its view closed is still kept in that view’s files', async () => {
	const held = deferred<void>();
	const opened = await fixture({
		transcribe: async () => {
			await held.promise;
			return Ok({ text: 'late but kept' });
		},
	});
	const { test, onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	const transcribing = onDevice.transcribe(recording.id);
	await eventually(
		() => onDevice.transcriptionRun(recording.id)?.state.kind === 'running',
	);

	// The person moves to the other view: this one's pages close.
	onDevice.dispose();
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
	const { test, onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	await onDevice.transcribe(recording.id);
	await eventually(() => onDevice.resultsFor(recording.id).length === 1);
	await onDevice.createTransformation({
		title: 'Clean up',
		prompt: 'Fix it.',
	});
	await eventually(() => onDevice.transformations.length === 1);
	const transcript = onDevice.resultsFor(recording.id)[0]!;
	await onDevice.transform(transcript.id, onDevice.transformations[0]!.id);
	await eventually(() => onDevice.outputsFor(transcript.id).length === 1);

	const deletion = expectOk(
		onDevice.deletionFor({ collection: 'recordings', id: recording.id }),
	);
	expect(deletion).toMatchObject({
		kind: 'recording',
		audio: `recordings/${recording.id}.wav`,
	});
	expect(deletion.kind === 'recording' && deletion.results).toHaveLength(2);
	expect(await onDevice.delete(deletion)).toBeUndefined();

	await eventually(() => onDevice.entries.length === 0);
	const left = await readdir(join(test.root, 'device'), { recursive: true });
	expect(
		left.filter((path) => /\.(md|wav)$/.test(path) && !path.startsWith('.')),
	).toEqual([
		// The recipe stays; a recording owns none.
		`transformations/${onDevice.transformations[0]!.id}.md`,
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
	const { onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	const transcribing = onDevice.transcribe(recording.id);
	await eventually(
		() => onDevice.transcriptionRun(recording.id)?.state.kind === 'running',
	);

	expect(
		expectErr(
			onDevice.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('still running');

	held.resolve();
	await transcribing;
	expectOk(
		onDevice.deletionFor({ collection: 'recordings', id: recording.id }),
	);
});

test('an answer whose result cannot be kept stays in this window until saved again', async () => {
	const opened = await fixture();
	const { test, onDevice } = opened;
	const recording = await record(opened);
	await eventually(() => onDevice.audioOf(recording.id).kind === 'here');
	const create = test.device.transcriptions.create;
	test.device.transcriptions.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;

	await onDevice.transcribe(recording.id);

	const run = onDevice.transcriptionRun(recording.id);
	expect(run?.state).toEqual({
		kind: 'unsaved',
		text: 'um so a steady tone',
		message: 'The disk is full',
	});
	expect(headerLine(onDevice)).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});

	test.device.transcriptions.create = create;
	await onDevice.saveAgain(run!.key);
	expect(onDevice.transcriptionRun(recording.id)).toBeUndefined();
	await eventually(() => onDevice.resultsFor(recording.id).length === 1);
	// Saved again without another request.
	expect(test.transcribed).toHaveLength(1);
});

test('a recording this device cannot keep stays in the page, and is kept when saved again', async () => {
	const { test, whispering, onDevice } = await fixture();
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
	expect(onDevice.entries).toHaveLength(0);

	test.device.audio.create = create;
	expect(
		await whispering.saveRecordingAgain(whispering.unsavedRecordings[0]!.id),
	).toBeUndefined();
	expect(whispering.unsavedRecordings).toHaveLength(0);
	await eventually(() => onDevice.entries.length === 1);
});

test('a note that does not read is listed for repair, and replaced as text', async () => {
	const { test, onDevice } = await fixture();
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await put(
		join(test.root, 'device'),
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await eventually(() => onDevice.repairs.length === 1);
	expect(onDevice.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});

	expect(
		(
			await onDevice.replace(
				{ collection: 'recordings', id },
				'not a recording',
			)
		).error?.name,
	).toBe('Invalid');
	expect(
		(
			await onDevice.replace(
				{ collection: 'recordings', id },
				'---\ntitle: Fixed\nrecordedAt: 2026-10-31T09:30:00.000Z\ncapture: microphone\n---\nnotes\n',
			)
		).error,
	).toBeNull();

	await eventually(() => onDevice.entries.length === 1);
	expect(onDevice.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(onDevice.repairs).toEqual([]);
});
