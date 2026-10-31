/**
 * Whispering over its files: this browser's device and, signed in, the
 * repository (a second directory stands in for it), as the mounted app
 * reads and writes them.
 *
 * Key behaviors:
 * - A recording is kept at Stop as one capture (audio and note) on the
 *   device, queued to upload, and listed as not uploaded yet
 * - Transcription reads the nearest audio: the device, then the device's
 *   cache of what it uploaded, then the repository
 * - A result is kept when its answer arrives: on the device signed out, in
 *   the repository signed in
 * - Deleting a recording deletes its transcripts, their results, and its
 *   audio, on whichever side each is; it is refused while work for it runs
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

/** The app over a fresh device, signed out or (with `signedIn`) beside the stand-in repository. */
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
	const { whispering, close } = await openTestWhispering({
		services: test.services,
		device: test.device,
		repository,
	});
	cleanups.push(close);
	return { test, whispering };
}

/** Record with the fixture device and wait until the recording is listed. */
async function record(
	whispering: Awaited<ReturnType<typeof fixture>>['whispering'],
) {
	const before = whispering.entries.length;
	await whispering.startRecording();
	await whispering.stopRecording();
	await eventually(() => whispering.entries.length === before + 1);
	return whispering.entries[0]!;
}

/** A file written straight into a directory, as another program would. */
async function put(root: string, path: string, data: string | Uint8Array) {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), data);
}

const sha256 = (bytes: Uint8Array) =>
	createHash('sha256').update(bytes).digest('hex');

test('a recording is kept at Stop as one capture on this device, queued to upload', async () => {
	const { test, whispering } = await fixture();
	const recording = await record(whispering);

	expect(recording).toMatchObject({ capture: 'fixture' });
	expect(whispering.whereOf('recordings', recording.id)).toBe('device');
	expect(recording.durationMs).toBe(1000);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');
	expect(whispering.audioOf(recording.id)).toMatchObject({
		kind: 'here',
		file: { ext: 'wav', where: 'device', cached: false },
	});
	const { items } = expectOk(await outboxOf(test.device).list());
	expect(items.map((capture) => Object.keys(capture.paths).sort())).toEqual([
		[`recordings/${recording.id}.md`, `recordings/${recording.id}.wav`],
	]);
	expect(headerLine(whispering).label).toBe('In this browser');
});

test('signed out, a transcription sends the device’s audio and keeps its transcript there', async () => {
	const { test, whispering } = await fixture();
	const recording = await record(whispering);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');

	expect(await whispering.transcribe(recording.id)).toBeUndefined();

	expect(test.transcribed).toHaveLength(1);
	expect(test.transcribed[0]!.bytes).toEqual(toneWav());
	await eventually(() => whispering.resultsFor(recording.id).length === 1);
	expect(whispering.resultsFor(recording.id)[0]).toMatchObject({
		recordingId: recording.id,
		model: 'verification-model',
		body: 'um so a steady tone\n',
	});
	expect(
		whispering.whereOf(
			'transcriptions',
			whispering.resultsFor(recording.id)[0]!.id,
		),
	).toBe('device');
	expect(whispering.transcriptionRun(recording.id)).toBeUndefined();
});

test('signed in, audio is read from this device’s cache before the repository is asked', async () => {
	const bytes = new Uint8Array([9, 8, 7, 6]);
	let downloads = 0;
	const { test, whispering } = await fixture({
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
		`---\ntitle: Uploaded\nrecordedAt: 2026-10-31T09:30:00.000Z\ndurationMs: 1000\ncapture: microphone\n---\n`,
	);
	// What the upload kept when it let go of the device's copy.
	await put(
		join(test.root, 'device'),
		`.epicenter/cache/recordings/${id}.m4a`,
		bytes,
	);

	// The cache is read again after each listing of the audio, so its mark follows.
	await eventually(() => {
		const audio = whispering.audioOf(id);
		return audio.kind === 'here' && audio.file.cached;
	});
	expect(whispering.audioOf(id)).toMatchObject({
		kind: 'here',
		file: { where: 'repository', cached: true },
	});
	expect(await whispering.transcribe(id)).toBeUndefined();

	expect(test.transcribed[0]!.bytes).toEqual(bytes);
	expect(downloads).toBe(0);
	// The transcript goes to the repository, where the recording is.
	await eventually(() => whispering.resultsFor(id).length === 1);
	expect(
		whispering.whereOf('transcriptions', whispering.resultsFor(id)[0]!.id),
	).toBe('repository');
	expect(
		await readdir(join(test.root, 'repository', 'transcriptions')),
	).toHaveLength(1);
});

test('signed in, audio only the repository holds is downloaded', async () => {
	const bytes = new Uint8Array([1, 1, 2, 3]);
	const { test, whispering } = await fixture({ signedIn: true });
	const id = '2026-10-31T09-30-00-000Z-elsewher';
	await put(join(test.root, 'repository'), `recordings/${id}.webm`, bytes);
	await put(
		join(test.root, 'repository'),
		`recordings/${id}.md`,
		`---\ntitle: From the desktop\nrecordedAt: 2026-10-31T09:30:00.000Z\ncapture: microphone\n---\n`,
	);
	await eventually(() => whispering.audioOf(id).kind === 'here');

	const read = expectOk(await whispering.readAudio(id));

	expect(read).toMatchObject({
		ext: 'webm',
		mimeType: 'audio/webm',
		name: `${id}.webm`,
	});
	expect(read.bytes).toEqual(bytes);
});

test('a transformation of a transcript, and of pasted text, keeps its result once answered', async () => {
	const { test, whispering } = await fixture({ signedIn: true });
	const recording = await record(whispering);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');
	await whispering.transcribe(recording.id);
	await eventually(() => whispering.resultsFor(recording.id).length === 1);
	const transcript = whispering.resultsFor(recording.id)[0]!;
	expect(
		await whispering.createTransformation({
			title: 'Clean up',
			prompt: 'Fix it.',
		}),
	).toBeUndefined();
	await eventually(() => whispering.transformations.length === 1);
	const recipe = whispering.transformations[0]!;

	expect(await whispering.transform(transcript.id, recipe.id)).toBeUndefined();
	expect(
		await whispering.transformText(recipe.id, 'pasted words'),
	).toBeUndefined();

	await eventually(() => whispering.outputsFor(transcript.id).length === 1);
	expect(whispering.outputsFor(transcript.id)[0]).toMatchObject({
		recordingId: recording.id,
		transformationTitle: 'Clean up',
		prompt: 'Fix it.',
		input: 'um so a steady tone\n',
		body: 'Transformed: um so a steady tone\n',
	});
	expect(
		whispering.whereOf(
			'transformation_runs',
			whispering.outputsFor(transcript.id)[0]!.id,
		),
	).toBe('repository');
	await eventually(() => whispering.textOutputsOf(recipe.id).length === 1);
	expect(whispering.textOutputsOf(recipe.id)[0]!.body).toBe(
		'Transformed: pasted words\n',
	);
	expect(test.transformed.map((request) => request.model)).toEqual([
		'connection-model',
		'connection-model',
	]);
});

test('deleting a recording deletes its transcripts, their results, and its audio, wherever each is', async () => {
	const { test, whispering } = await fixture();
	const recording = await record(whispering);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');
	await whispering.transcribe(recording.id);
	await eventually(() => whispering.resultsFor(recording.id).length === 1);
	await whispering.createTransformation({
		title: 'Clean up',
		prompt: 'Fix it.',
	});
	await eventually(() => whispering.transformations.length === 1);
	const transcript = whispering.resultsFor(recording.id)[0]!;
	await whispering.transform(transcript.id, whispering.transformations[0]!.id);
	await eventually(() => whispering.outputsFor(transcript.id).length === 1);

	const deletion = expectOk(
		whispering.deletionFor({ collection: 'recordings', id: recording.id }),
	);
	expect(deletion).toMatchObject({
		kind: 'recording',
		audio: `recordings/${recording.id}.wav`,
	});
	expect(deletion.kind === 'recording' && deletion.results).toHaveLength(2);
	expect(await whispering.delete(deletion)).toBeUndefined();

	await eventually(() => whispering.entries.length === 0);
	const left = await readdir(join(test.root, 'device'), { recursive: true });
	expect(
		left.filter((path) => /\.(md|wav)$/.test(path) && !path.startsWith('.')),
	).toEqual([
		// The recipe stays; a recording owns none.
		`transformations/${whispering.transformations[0]!.id}.md`,
	]);
});

test('a recording cannot be deleted while its transcription runs', async () => {
	const held = deferred<void>();
	const { whispering } = await fixture({
		transcribe: async () => {
			await held.promise;
			return Ok({ text: 'late' });
		},
	});
	const recording = await record(whispering);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');
	const transcribing = whispering.transcribe(recording.id);
	await eventually(
		() => whispering.transcriptionRun(recording.id)?.state.kind === 'running',
	);

	expect(
		expectErr(
			whispering.deletionFor({ collection: 'recordings', id: recording.id }),
		),
	).toContain('still running');

	held.resolve();
	await transcribing;
	expectOk(
		whispering.deletionFor({ collection: 'recordings', id: recording.id }),
	);
});

test('an answer whose result cannot be kept stays in this window until saved again', async () => {
	const { test, whispering } = await fixture();
	const recording = await record(whispering);
	await eventually(() => whispering.audioOf(recording.id).kind === 'here');
	const create = test.device.transcriptions.create;
	test.device.transcriptions.create = async () =>
		Err({
			name: 'Unavailable',
			message: 'The disk is full',
			cause: null,
		}) as never;

	await whispering.transcribe(recording.id);

	const run = whispering.transcriptionRun(recording.id);
	expect(run?.state).toEqual({
		kind: 'unsaved',
		text: 'um so a steady tone',
		message: 'The disk is full',
	});
	expect(headerLine(whispering)).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});

	test.device.transcriptions.create = create;
	await whispering.saveAgain(run!.key);
	expect(whispering.transcriptionRun(recording.id)).toBeUndefined();
	await eventually(() => whispering.resultsFor(recording.id).length === 1);
	// Saved again without another request.
	expect(test.transcribed).toHaveLength(1);
});

test('a recording this device cannot keep stays in the page, and is kept when saved again', async () => {
	const { test, whispering } = await fixture();
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
	expect(whispering.entries).toHaveLength(0);

	test.device.audio.create = create;
	expect(
		await whispering.saveRecordingAgain(whispering.unsavedRecordings[0]!.id),
	).toBeUndefined();
	expect(whispering.unsavedRecordings).toHaveLength(0);
	await eventually(() => whispering.entries.length === 1);
});

test('a note that does not read is listed for repair, and replaced as text', async () => {
	const { test, whispering } = await fixture();
	const id = '2026-10-31T09-30-00-000Z-brokenaa';
	await put(
		join(test.root, 'device'),
		`recordings/${id}.md`,
		'---\ntitle: [unclosed\n---\n',
	);
	await eventually(() => whispering.repairs.length === 1);
	expect(whispering.repairs[0]).toMatchObject({
		collection: 'recordings',
		id,
	});
	expect(whispering.whereOf('recordings', id)).toBe('device');

	expect(
		await whispering.replace(
			{ collection: 'recordings', id },
			'not a recording',
		),
	).toBeDefined();
	expect(
		await whispering.replace(
			{ collection: 'recordings', id },
			'---\ntitle: Fixed\nrecordedAt: 2026-10-31T09:30:00.000Z\ncapture: microphone\n---\nnotes\n',
		),
	).toBeUndefined();

	await eventually(() => whispering.entries.length === 1);
	expect(whispering.entries[0]).toMatchObject({
		title: 'Fixed',
		body: 'notes\n',
	});
	expect(whispering.repairs).toEqual([]);
});

test('signed in, a title edit lands on the copy shown', async () => {
	const { test, whispering } = await fixture({ signedIn: true });
	const id = '2026-10-31T09-30-00-000Z-uploaded';
	await put(
		join(test.root, 'repository'),
		`recordings/${id}.md`,
		`---\ntitle: Old\nrecordedAt: 2026-10-31T09:30:00.000Z\ncapture: microphone\n---\n`,
	);
	await eventually(() => whispering.entries.length === 1);

	expectOk(await whispering.files.recordings.update({ id }, { title: 'New' }));

	expect(expectOk(await test.repository.recordings.get({ id })).title).toBe(
		'New',
	);
	expect(
		await readdir(join(test.root, 'device')).catch(() => []),
	).not.toContain('recordings');
});
