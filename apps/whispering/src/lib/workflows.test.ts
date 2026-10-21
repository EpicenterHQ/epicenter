/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory, opened as the
 * native `Folder` with Whispering's tables, with a fixture capture device and
 * a stubbed transcription answer. No window, shell, or microphone is
 * involved, so these establish the workflow's logic and what it leaves on
 * disk, not that the desktop app runs. Editing drafts is covered in
 * `editing.test.ts`.
 *
 * Key behaviors:
 * - A first launch creates no files, and saving a connection writes nothing
 *   to the folder
 * - Record and stop leave same-stem Markdown and audio with its exact
 *   bytes; reopening reads both, and a recording being captured never reads
 *   as absent
 * - Files supplied in an ordinary directory read as they are: rows,
 *   transcripts, results, and audio, with every field kept
 * - Captured audio survives a row write that fails at start
 * - Only same-stem siblings resolve as audio; unrelated metadata never redirects
 *   playback or transcription, and malformed rows remain repairable
 * - Deleting a recording deletes its row and its results and keeps its audio.
 *   It is refused while work for it runs or a result cannot say whose it is
 * - A transcription result is its own row naming the recording, written with
 *   an empty body before the request goes out and filled when the answer
 *   arrives (ADR-0542)
 * - A row with no body and no request in this window is unfinished; running
 *   it again fills the same row, and deleting it discards it
 * - An answer whose write fails is written again while the page lives; after
 *   a reload its row is unfinished
 * - Renaming a file saves its typing first and moves its exact bytes;
 *   recording and transformation files keep their names
 * - Stop waits for its own initial row save across overlapping captures
 * - Closing refuses new work and selection without draining workflows; the
 *   Folder still waits for writes it already admitted
 */
import type { WhisperingContext } from './folder.js';
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathProblem } from '@epicenter/folder/file-browser';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createFixtureDevice, toneWav } from './capture.js';
import { recordingAudioStem } from './definition.js';
import { describeDeletion } from './deletion.js';
import { openText, settle } from './edits.test-support.js';
import { audioRead } from './file-reads.js';
import { readBytes } from './files.js';
import type { WhisperingServices } from './platform/types.js';
import { QueryObserver, quiet } from './query.test-support.js';
import {
	eventually,
	openGatedTestFolder,
	openTestFolder,
	type ResultFailures,
	replaceTables,
	TEST_BASE_URL,
	testConnections,
	whisperingDirectory,
	withObstructedCreates,
	withResultFailures,
} from './services.test-support.js';
import { filesLine } from './status.js';
import type { Whispering } from './whispering.svelte.js';

/** The recording rows and their sibling audio, sorted. */
const recordingFiles = async (root: string) =>
	(await readdir(join(root, 'recordings')).catch(() => [] as string[])).sort();

const { recordingId } = await import('./whispering.svelte.js');

/** Read through the player's query policy, fetching current bytes each time. */
const readAudio = (context: WhisperingContext, path: string) =>
	context.queryClient.fetchQuery({
		...context.queries.file(path, audioRead),
		staleTime: 0,
	});

const opened: { whispering: Whispering; context: WhisperingContext }[] = [];
const roots: string[] = [];

type Options = {
	/** Fail this many recording row writes, made when a recording starts. */
	failRowWrites?: number;
	/** Fail this many transcript rows written when a transcription starts. */
	failResultStarts?: number;
	/** Fail this many answers written into transcript rows. */
	failAnswerWrites?: number;
	/** Replace the stubbed transcription answer. */
	transcribe?: WhisperingServices['transcribe'];
	root?: string;
	/** Runs before each save of a file through `files`, with its path and whether it is new. */
	beforeFileWrite?: (path: string, created: boolean) => Promise<void>;
	/** Runs before each new recording row is saved. */
	beforeRowCreate?: () => Promise<void>;
	/** Runs below the Folder before each file's bytes reach the disk, as a slow disk would. */
	beforeDiskWrite?: (path: string) => Promise<void>;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Parameters<typeof testConnections>[0];
};

async function open({
	failRowWrites = 0,
	failResultStarts = 0,
	failAnswerWrites = 0,
	transcribe,
	beforeFileWrite,
	beforeRowCreate,
	root,
	connections,
	beforeDiskWrite,
}: Options = {}) {
	const directory =
		root ?? (await whisperingDirectory('whispering-whispering-'));
	if (root === undefined) roots.push(directory);
	const folder =
		beforeDiskWrite === undefined
			? await openTestFolder(directory)
			: openGatedTestFolder(directory, beforeDiskWrite);
	/** Result row writes still to fail. A test may arm more after opening. */
	const failures: ResultFailures = {
		starts: failResultStarts,
		answers: failAnswerWrites,
	};
	const stored = folder.files;
	const files: typeof folder.files = {
		...stored,
		async write(path, from, content) {
			await beforeFileWrite?.(path, from === null);
			return stored.write(path, from, content);
		},
	};
	const transcribed: Parameters<WhisperingServices['transcribe']>[0][] = [];
	const device = testConnections(connections);
	const recordings = withObstructedCreates(
		folder.tables.recordings,
		join(directory, 'recordings'),
		{ creates: failRowWrites },
	);
	const test = {
		services: {
			kind: 'native',

			location: directory,
			capture: createFixtureDevice({
				name: 'tone.wav',
				load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
			}),
			recoverRecordings: async () => undefined,
			async transcribe(request) {
				transcribed.push(request);
				if (transcribe !== undefined) return transcribe(request);
				return Ok({ text: 'a steady tone' });
			},
			transform: async ({ input }) => Ok({ text: input }),
			transformNote: 'test',
			localTranscription: undefined,
			connections: device.member,
			preferences: {
				microphone: async () => undefined,
				setMicrophone: async () => undefined,
			},
		} satisfies WhisperingServices,
		folder: replaceTables(
			folder,
			{
				transcriptions: withResultFailures(
					folder.tables.transcriptions,
					failures,
				),
				recordings: {
					...recordings,
					async set(id, from, change) {
						if (from === null) await beforeRowCreate?.();
						return recordings.set(id, from, change);
					},
				},
			},
			files,
		),
	};
	const { whispering, context } = await openTestWhispering(test);
	opened.push({ whispering, context });
	return {
		whispering,
		context,
		root: directory,
		transcribed,
		failures,
		device,
	};
}

afterEach(async () => {
	for (const fixture of opened.splice(0)) await closeTestWhispering(fixture);
	for (const root of roots.splice(0))
		await rm(dirname(root), { recursive: true, force: true });
});

async function record(whispering: Whispering, context: WhisperingContext) {
	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	await whispering.stopRecording();
	await quiet(context);
}

/** The header's line, from the same function AppHeader calls. */
const status = (whispering: Whispering) =>
	filesLine({
		saving: whispering.saving,
		unsaved: whispering.unsaved,
		storageFailure: whispering.storageFailure,
		unwrittenAnswers: whispering.unwrittenAnswers,
	});

/** Close `whispering` in the test, so the next opening reads what it left. */
async function reopen(
	whispering: Whispering,
	context: WhisperingContext,
	root: string,
) {
	opened.splice(
		opened.findIndex((fixture) => fixture.whispering === whispering),
		1,
	);
	await closeTestWhispering({ whispering, context });
	return open({ root });
}

// ============================================================================
// Launch and settings
// ============================================================================

test('a new recording’s audio and row are paths every folder accepts, the desktop shell included', () => {
	for (const at of [
		new Date('2026-01-02T03:04:05.678Z'),
		new Date('1999-12-31T23:59:59.999Z'),
	])
		for (const extension of ['wav', 'webm', 'm4a', 'ogg', 'mp3', 'flac']) {
			const id = recordingId(at);
			expect(
				pathProblem(`${recordingAudioStem(id)}.${extension}`),
			).toBeUndefined();
			expect(pathProblem(`recordings/${id}.md`)).toBeUndefined();
		}
});

test('startup maintains only .gitignore, and saving a connection adds no folder files', async () => {
	const { whispering, root, device } = await open({
		connections: { connections: {} },
	});
	// App startup maintains exclusions, with no declaration or Git repository.
	expect(await readdir(root)).toEqual(['.gitignore']);
	expect(whispering.connections).toEqual({
		transcription: undefined,
		text: undefined,
	});

	expect(
		await whispering.saveConnection('transcription', {
			baseUrl: `${TEST_BASE_URL}/`,
			model: ' chosen ',
			key: { action: 'replace', key: 'typed-key' },
		}),
	).toBeUndefined();

	expect(whispering.connections?.transcription).toEqual({
		baseUrl: TEST_BASE_URL,
		model: 'chosen',
		keyPresent: true,
		readOnlyReason: undefined,
	});
	expect(device.stored.transcription?.apiKey).toBe('typed-key');
	expect(await readdir(root)).toEqual(['.gitignore']);
});

test('with no transcription connection, transcribing sends nothing and says to set one up', async () => {
	const { context, whispering, transcribed } = await open({
		connections: { connections: {} },
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;

	await whispering.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('No transcription connection is set up'),
	});
	expect(whispering.resultsFor(entry.stem)).toEqual([]);
});

// ============================================================================
// Recording
// ============================================================================

test('record and stop leave adjacent Markdown and exact audio without a stored path, and reopening reads both', async () => {
	const { context, whispering, root } = await open();

	await record(whispering, context);

	expect(whispering.entries).toHaveLength(1);
	const entry = whispering.entries[0]!;
	const { fields } = entry.row;
	const audioPath = entry.path.replace(/\.md$/, '.wav');
	expect(fields.capture).toBe('fixture');
	expect(fields.durationMs).toBe(1000);
	expect(whispering.selectedPath).toBe(entry.path);
	expect(whispering.selection?.entry?.path).toBe(entry.path);
	expect(whispering.showsText(entry.path)).toBe(false);
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, audioPath))),
	).toEqual(toneWav());
	const row = await readFile(join(root, entry.path), 'utf8');
	expect(row).not.toContain('audioPath:');
	expect(row).toContain('durationMs: 1000');

	const second = await reopen(whispering, context, root);

	expect(second.whispering.entries.map((item) => item.row.fields)).toEqual([
		fields,
	]);
	expect(expectOk(await readBytes(second.context.folder, audioPath))).toEqual(
		toneWav(),
	);
	// The player reads the same bytes, typed as the container they are.
	const audio = await readAudio(second.context, audioPath);
	expect(audio.blob.type).toBe('audio/wav');
	expect<Uint8Array>(new Uint8Array(await audio.blob.arrayBuffer())).toEqual(
		toneWav(),
	);
});

test('a recording being captured, and once it stops, has its audio here, never absent', async () => {
	const { context, whispering } = await open();

	await whispering.startRecording();
	// The row's save is read back; the fixture's audio is written when it
	// stops, so until then the listing lacks it.
	await quiet(context);
	const [entry] = whispering.entries;
	expect(whispering.audioOf(entry!).kind).toBe('here');

	await whispering.stopRecording();
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
	await quiet(context);
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
});

test('a completed recording leaves settling after an unchanged listing reread', async () => {
	const { context, whispering } = await open();
	const write = context.folder.files.write;
	// A capture reports completion but leaves no audio file. The paths do not change.
	context.folder.files.write = (path, from, content) =>
		path.startsWith('recordings/') && !path.endsWith('.md')
			? Promise.resolve(Ok(undefined))
			: write(path, from, content);
	try {
		await whispering.startRecording();
		await settle(whispering, context);
		const key = context.queries.files().queryKey;
		const before = context.queryClient.getQueryData<string[]>(key);
		await whispering.stopRecording();
		await whispering.readAgain();
		expect(context.queryClient.getQueryData<string[]>(key)).toBe(before);
		expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('absent');
	} finally {
		context.folder.files.write = write;
	}
});

test('a recording’s row is written when it starts, naming its audio, and gets its length when it stops', async () => {
	const { context, whispering, root } = await open();

	await whispering.startRecording();

	expect(whispering.recorder.phase).toBe('recording');
	await quiet(context);
	const [entry] = whispering.entries;
	expect(entry?.row.fields).toMatchObject({
		capture: 'fixture',
	});
	expect(entry?.row.fields.durationMs).toBeUndefined();

	await whispering.stopRecording();
	await quiet(context);

	expect(
		whispering.entries.map((stored) => stored.row.fields.durationMs),
	).toEqual([1000]);
	expect(await recordingFiles(root)).toEqual([
		`${entry?.stem}.md`,
		`${entry?.stem}.wav`,
	]);
	expect(await readdir(join(root, 'recordings'))).toEqual(
		expect.arrayContaining([`${entry?.stem}.wav`, `${entry?.stem}.md`]),
	);
});

test('a title typed while recording is kept when the recording stops and gets its length', async () => {
	const { context, whispering, root } = await open();
	await whispering.startRecording();
	await quiet(context);
	const entry = whispering.entries[0]!;
	const edit = whispering.edit('recordings', entry.path);

	edit.change({ fields: { title: 'Standup notes' } });
	await whispering.stopRecording();
	await edit.save();
	await settle(whispering, context);

	expect(whispering.entries[0]!.row.fields).toMatchObject({
		title: 'Standup notes',
		durationMs: 1000,
	});
	const row = await readFile(join(root, entry.path), 'utf8');
	expect(row).toContain('title: Standup notes');
	expect(row).toContain('durationMs: 1000');
});

test('Stop pressed while the row’s first save runs writes the length once the row is there', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { context, whispering, root } = await open({
		beforeRowCreate: async () => {
			reached.resolve();
			await release.promise;
		},
	});

	const starting = whispering.startRecording();
	await reached.promise;
	expect(whispering.recorder.phase).toBe('recording');
	const stopping = whispering.stopRecording();
	await Bun.sleep(10);
	release.resolve();
	await Promise.all([starting, stopping]);
	await settle(whispering, context);

	expect(whispering.recorderError).toBeUndefined();
	const [entry] = whispering.entries;
	expect(entry?.row.fields.durationMs).toBe(1000);
	expect(await readFile(join(root, entry!.path), 'utf8')).toContain(
		'durationMs: 1000',
	);
});

test('a first capture’s Stop waits for its own row while a second capture starts', async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	const firstReached = Promise.withResolvers<void>();
	const secondReached = Promise.withResolvers<void>();
	let creates = 0;
	const { context, whispering, root } = await open({
		beforeRowCreate: async () => {
			if (++creates === 1) {
				firstReached.resolve();
				await first.promise;
			} else {
				secondReached.resolve();
				await second.promise;
			}
		},
	});
	const firstStart = whispering.startRecording();
	await firstReached.promise;
	const finishing = whispering.stopRecording();
	let finished = false;
	void finishing.then(() => {
		finished = true;
	});
	let secondStart: Promise<void> | undefined;
	try {
		await eventually(() => whispering.recorder.phase === 'idle');
		secondStart = whispering.startRecording();
		await secondReached.promise;
		first.resolve();
		await eventually(() => finished);
		expect(whispering.recorder.phase).toBe('recording');
		const saved = await readdir(join(root, 'recordings'));
		expect(saved.filter((path) => path.endsWith('.md'))).toHaveLength(1);
		expect(
			await readFile(
				join(root, 'recordings', saved.find((path) => path.endsWith('.md'))!),
				'utf8',
			),
		).toContain('durationMs: 1000');
	} finally {
		first.resolve();
		second.resolve();
		await Promise.all([firstStart, secondStart, finishing]);
	}
	await whispering.stopRecording();
	await settle(whispering, context);
	expect(whispering.entries).toHaveLength(2);
	for (const entry of whispering.entries)
		expect(entry.row.fields.durationMs).toBe(1000);
});

test('a recording still recording is not transcribed', async () => {
	const { context, whispering, transcribed } = await open();

	await whispering.startRecording();
	await quiet(context);
	const [entry] = whispering.entries;
	await whispering.transcribe(entry!);

	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry!.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('still recording'),
	});
	await whispering.stopRecording();
});

test('a row write that fails at start leaves the recording running, says so, and its audio is still saved', async () => {
	const { whispering, root } = await open({ failRowWrites: 1 });

	await whispering.startRecording();

	expect(whispering.recorder.phase).toBe('recording');
	expect(whispering.recorderError).toContain('its file could not be written');
	expect(whispering.entries).toEqual([]);

	await whispering.stopRecording();

	const files = await recordingFiles(root);
	expect(files).toHaveLength(1);
	expect(files[0]).toEndWith('.wav');
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, 'recordings', files[0]!))),
	).toEqual(toneWav());
});

test('files in an ordinary directory read as they are, extra fields included', async () => {
	const root = await whisperingDirectory('whispering-files-');
	roots.push(root);
	await mkdir(join(root, 'recordings'), { recursive: true });
	await mkdir(join(root, 'transcriptions'), { recursive: true });
	const recording =
		'---\ntitle: Kept take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: microphone\nmood: calm\n---\nMy notes\n';
	await writeFile(join(root, 'recordings', 'kept.md'), recording);
	await writeFile(join(root, 'recordings', 'kept.wav'), toneWav());
	await writeFile(
		join(root, 'transcriptions', 'kept-t.md'),
		'---\nrecordingId: kept\ncreatedAt: 2026-01-02T03:05:00.000Z\nmodel: whisper-1\nendpoint: https://api.openai.com/v1\n---\nhello there\n',
	);
	// An unrelated file beside the documents stays as it is.
	await writeFile(join(root, 'epicenter.json'), '{"title":"Whispering"}\n');

	const { context, whispering } = await open({ root });

	const entry = whispering.entries[0]!;
	expect(entry.stem).toBe('kept');
	expect(entry.row.fields).toMatchObject({
		title: 'Kept take',
	});
	expect(entry.row.body).toBe('My notes\n');
	expect(whispering.audioOf(entry).kind).toBe('here');
	expect(whispering.resultsFor('kept').map((item) => item.row.body)).toEqual([
		'hello there\n',
	]);
	expect(
		expectOk(await readBytes(context.folder, 'recordings/kept.wav')),
	).toEqual(toneWav());

	// Editing the notes keeps the field this version does not know.
	const view = whispering.edit('recordings', entry.path);
	expect(view.markdown?.body).toBeDefined();
	view.change({ body: 'My notes, edited\n' });
	await view.save();
	await settle(whispering, context);
	const saved = await readFile(join(root, 'recordings', 'kept.md'), 'utf8');
	expect(saved).toContain('mood: calm');
	expect(saved).toContain('My notes, edited');
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
		'{"title":"Whispering"}\n',
	);
});

test('frontmatter paths never redirect audio and opening never relocates files', async () => {
	const { context, whispering, root, transcribed } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	await mkdir(join(root, 'audio'), { recursive: true });
	const source =
		'---\ntitle: Take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: audio/take.wav\n---\nNotes\n';
	await writeFile(join(root, 'recordings', 'take.md'), source);
	await writeFile(join(root, 'audio', 'take.wav'), toneWav());
	await settle(whispering, context);
	const entry = whispering.entries[0]!;
	expect(whispering.audioOf(entry).kind).toBe('absent');
	expect(whispering.recordingNaming('audio/take.wav')).toBeUndefined();
	await whispering.transcribe(entry);
	expect(transcribed).toEqual([]);
	expect(await readFile(join(root, entry.path), 'utf8')).toBe(source);
	expect(await readdir(join(root, 'recordings'))).toEqual(['take.md']);
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, 'audio', 'take.wav'))),
	).toEqual(toneWav());

	await writeFile(join(root, 'recordings', 'take.wav'), toneWav());
	await settle(whispering, context);
	await whispering.transcribe(entry);
	expect(whispering.audioOf(entry)).toEqual({
		kind: 'here',
		path: 'recordings/take.wav',
	});
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		'recordings/take.wav',
	]);
});

test('audio replaced by bytes of the same length is noticed by its content', async () => {
	const { context, whispering, root } = await open();
	await record(whispering, context);
	const path = whispering.entries[0]!.path.replace(/\.md$/, '.wav');
	const observer = new QueryObserver(
		context.queryClient,
		context.queries.file(path, audioRead),
	);
	const stop = observer.subscribe(() => {});
	try {
		const first = await readAudio(context, path);

		await settle(whispering, context);
		expect(await readAudio(context, path)).toBe(first);

		const replaced = new Uint8Array(toneWav({ frequency: 880 }));
		expect(replaced.length).toBe(toneWav().length);
		await writeFile(join(root, path), replaced);
		await settle(whispering, context);

		const next = await readAudio(context, path);
		expect(next).not.toBe(first);
		expect<Uint8Array>(new Uint8Array(await next.blob.arrayBuffer())).toEqual(
			replaced,
		);
	} finally {
		stop();
	}
});

// ============================================================================
// Transcription
// ============================================================================

test('a transcription is saved as its own row naming the recording, and reopening keeps the recording, result, and exact audio', async () => {
	const { context, whispering, root, transcribed } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');

	await whispering.transcribe(entry);
	await quiet(context);

	expect(transcribed).toEqual([
		{
			audioPath,
			expectedBaseUrl: TEST_BASE_URL,
			model: 'verification-model',
		},
	]);
	const results = whispering.resultsFor(entry.stem);
	expect(results.map((result) => result.row.body)).toEqual(['a steady tone\n']);
	const row = await readFile(join(root, results[0]!.path), 'utf8');
	expect(row).toContain(entry.stem);
	expect(row).toContain('model: verification-model');

	const second = await reopen(whispering, context, root);

	expect(second.whispering.entries.map((item) => item.path)).toEqual([
		entry.path,
	]);
	expect(second.whispering.resultsFor(entry.stem)[0]!.row.body).toBe(
		'a steady tone\n',
	);
	expect(expectOk(await readBytes(second.context.folder, audioPath))).toEqual(
		toneWav(),
	);
});

const transcripts = (root: string) =>
	readdir(join(root, 'transcriptions')).catch(() => [] as string[]);

/** The state of the newest transcript of `recording`. */
function newest(whispering: Whispering, recording: string) {
	const transcript = whispering.resultsFor(recording)[0]!;
	return {
		transcript,
		state: whispering.resultState(transcript.path, transcript.row.body),
	};
}

test('a transcript row is written with an empty body before the request goes out, and filled when the answer arrives', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { context, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;

	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(whispering, context);

	const { transcript, state } = newest(whispering, entry.stem);
	expect(state.kind).toBe('running');
	expect(transcript.row.fields).toEqual({
		recordingId: entry.stem,
		createdAt: expect.any(String),
		model: 'verification-model',
		endpoint: TEST_BASE_URL,
	});
	expect(transcript.row.body).toBe('');
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
	// What is happening is never written: the row holds facts only.
	expect(await readFile(join(root, transcript.path), 'utf8')).not.toContain(
		'status',
	);

	answer.resolve(Ok({ text: 'arrived' }));
	await transcribing;
	await settle(whispering, context);

	expect(newest(whispering, entry.stem).state.kind).toBe('answered');
	expect(
		whispering.resultsFor(entry.stem).map((item) => item.row.body),
	).toEqual(['arrived\n']);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
});

test('an answer is filled as a change from the empty row: a field changed meanwhile is kept', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { context, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(whispering, context);
	const { transcript } = newest(whispering, entry.stem);

	// Another program adds a field while the request is out.
	const file = join(root, transcript.path);
	await writeFile(
		file,
		(await readFile(file, 'utf8')).replace(/^---\n/, '---\nlanguage: en\n'),
	);
	const edited = await readFile(file, 'utf8');
	expect(edited).toContain('language: en');

	answer.resolve(Ok({ text: 'arrived' }));
	await transcribing;
	await settle(whispering, context);

	const saved = await readFile(file, 'utf8');
	expect(saved).toContain('language: en');
	expect(saved).toEndWith('arrived\n');
});

test('a transport that throws leaves the row unfinished; running it again sends the same request into the same row', async () => {
	let attempts = 0;
	const { context, whispering, root, transcribed } = await open({
		transcribe: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'second try' });
		},
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;

	await whispering.transcribe(entry);
	await settle(whispering, context);

	const { transcript, state } = newest(whispering, entry.stem);
	expect(state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});
	expect(whispering.transcriptionRun(entry.stem)).toBeUndefined();
	expect(transcript.row.body).toBe('');

	expect(await whispering.runAgain(transcript.path)).toBeUndefined();
	await settle(whispering, context);

	expect(attempts).toBe(2);
	expect(transcribed[1]).toEqual(transcribed[0]);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
	expect(whispering.resultsFor(entry.stem)[0]!.row.body).toBe('second try\n');
	expect(await whispering.runAgain(transcript.path)).toContain(
		'already has its answer',
	);
	expect(attempts).toBe(2);
});

test('a row that cannot be written when the run starts sends nothing, and says why', async () => {
	const { context, whispering, root, transcribed } = await open({
		failResultStarts: 1,
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;

	await whispering.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('Nothing was sent'),
	});
	expect(await transcripts(root)).toEqual([]);
});

test('an answer whose write fails is written again while the page lives, and does not hold the page open', async () => {
	const { context, whispering, root } = await open({ failAnswerWrites: 2 });
	await record(whispering, context);
	await settle(whispering, context);
	const entry = whispering.entries[0]!;

	await whispering.transcribe(entry);
	await settle(whispering, context);

	expect(newest(whispering, entry.stem).state).toMatchObject({
		kind: 'writing',
		text: 'a steady tone',
		message: expect.stringContaining('the disk refused the result'),
	});
	expect(whispering.unwrittenAnswers).toBe(1);
	expect(status(whispering).label).toBe('1 answer not written yet');

	await eventually(() => whispering.unwrittenAnswers === 0);
	await settle(whispering, context);

	expect(whispering.resultsFor(entry.stem)[0]!.row.body).toBe(
		'a steady tone\n',
	);
	expect(await transcripts(root)).toHaveLength(1);
	expect(status(whispering).tone).toBe('good');
});

test('after a reload, a row whose answer was never written is unfinished, and running it again fills it', async () => {
	const first = await open({ failAnswerWrites: 100 });
	await record(first.whispering, first.context);
	const entry = first.whispering.entries[0]!;
	await first.whispering.transcribe(entry);
	await settle(first.whispering, first.context);
	expect(newest(first.whispering, entry.stem).state.kind).toBe('writing');

	const second = await reopen(first.whispering, first.context, first.root);

	const { transcript, state } = newest(second.whispering, entry.stem);
	expect(state.kind).toBe('unfinished');
	expect(transcript.row.body).toBe('');
	expect(second.whispering.unwrittenAnswers).toBe(0);

	expect(await second.whispering.runAgain(transcript.path)).toBeUndefined();
	await settle(second.whispering, second.context);

	expect(second.transcribed).toHaveLength(1);
	expect(
		second.whispering.resultsFor(entry.stem).map((item) => item.stem),
	).toEqual([transcript.stem]);
	expect(newest(second.whispering, entry.stem).state.kind).toBe('answered');
});

test('a running transcription cannot be asked for again; deleting its row discards it, and its answer writes nothing', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { context, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(whispering, context);
	const { transcript } = newest(whispering, entry.stem);

	await whispering.transcribe(entry);
	expect(transcribed).toHaveLength(1);
	expect(await whispering.runAgain(transcript.path)).toContain(
		'already running',
	);

	const deletion = expectOk(await whispering.deletionFor(transcript.path));
	expect(await whispering.delete(deletion)).toBeUndefined();
	answer.resolve(Ok({ text: 'too late' }));
	await transcribing;
	await settle(whispering, context);

	expect(await transcripts(root)).toEqual([]);
	expect(whispering.resultsFor(entry.stem)).toEqual([]);
	expect(whispering.unwrittenAnswers).toBe(0);
});

// ============================================================================
// Deleting a recording
// ============================================================================

test('deleting a recording removes its row and results, keeps its audio, and says so first', async () => {
	const { context, whispering, root } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');
	await whispering.transcribe(entry);
	await settle(whispering, context);

	const deletion = expectOk(await whispering.deletionFor(entry.path));
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion).description;
	expect(asked).toContain(
		`This deletes ${entry.path}, 1 result from the folder.`,
	);
	expect(asked).toContain(`Its audio ${audioPath} is not deleted`);
	expect(asked).not.toMatch(/version|history/i);
	expect(await whispering.delete(deletion)).toBeUndefined();
	await settle(whispering, context);

	expect(whispering.entries).toHaveLength(0);
	expect(await transcripts(root)).toEqual([]);
	// The table removed its row file. The audio is an ordinary file and stays.
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, audioPath))),
	).toEqual(toneWav());

	// The audio is deleted as the file it is, from Files, with its own question.
	expect(whispering.recordingNaming(audioPath)).toBeUndefined();
	const file = expectOk(await whispering.deletionFor(audioPath));
	expect(file).toMatchObject({ kind: 'file', path: audioPath });
	expect(await whispering.delete(file)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([]);
});

test('deleting the audio a recording names keeps the recording, and the missing file is reported', async () => {
	const { context, whispering, root } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');
	expect(await whispering.rename(audioPath, 'other.wav')).toContain(
		'belongs to a recording',
	);

	const deletion = expectOk(await whispering.deletionFor(audioPath));
	expect(describeDeletion(deletion).description).toContain(
		'names it as its audio and is kept',
	);
	expect(await whispering.delete(deletion)).toBeUndefined();
	await settle(whispering, context);

	expect(await recordingFiles(root)).toEqual([`${entry.stem}.md`]);
	expect(whispering.entries[0]!.path.replace(/\.md$/, '.wav')).toBe(audioPath);
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('absent');
	await expect(readAudio(context, audioPath)).rejects.toThrow('No file exists');
});

test('a file is deleted as it holds when the deletion runs, whatever changed since the person was asked', async () => {
	const { context, whispering, root } = await open();
	await writeFile(join(root, 'notes.txt'), 'first\n');
	await settle(whispering, context);
	const deletion = expectOk(await whispering.deletionFor('notes.txt'));

	await writeFile(join(root, 'notes.txt'), 'changed elsewhere\n');
	const kept = await whispering.delete(deletion);

	// The person asked to delete the file; it goes as it is now.
	expect(kept).toBeUndefined();
	expect(await Bun.file(join(root, 'notes.txt')).exists()).toBe(false);
});

test('a recording is not deleted while a result cannot say which recording it belongs to', async () => {
	const { context, whispering, root } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	await whispering.transcribe(entry);
	await settle(whispering, context);

	await writeFile(
		join(root, 'transcriptions/unparsed.md'),
		`---\nrecordingId: ${entry.stem}\nmodel: [open\n---\ntext\n`,
	);
	const { error: refusal } = await whispering.deletionFor(entry.path);
	expect(refusal).toContain('cannot be told apart');
	expect(refusal).toContain('transcriptions/unparsed.md');

	// A deletion confirmed before such a file appeared is refused when it runs.
	await rm(join(root, 'transcriptions/unparsed.md'));
	const confirmed = expectOk(await whispering.deletionFor(entry.path));
	await mkdir(join(root, 'transformation_runs'), { recursive: true });
	await writeFile(join(root, 'transformation_runs/odd.md'), 'no fence\n');
	expect(await whispering.delete(confirmed)).toContain('cannot be told apart');
	expect(await recordingFiles(root)).toHaveLength(2);

	await rm(join(root, 'transformation_runs/odd.md'));
	expect(await whispering.delete(confirmed)).toBeUndefined();
	await settle(whispering, context);
	expect(whispering.entries).toEqual([]);
});

test('a recording cannot be deleted while its transcription runs, including one started after confirming', async () => {
	let answer!: (
		value: Awaited<ReturnType<WhisperingServices['transcribe']>>,
	) => void;
	const { context, whispering, root } = await open({
		transcribe: () => new Promise((resolve) => (answer = resolve)),
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const confirmed = expectOk(await whispering.deletionFor(entry.path));

	const transcribing = whispering.transcribe(entry);
	expect((await whispering.deletionFor(entry.path)).error).toContain(
		'still running',
	);
	expect(await whispering.delete(confirmed)).toContain('still running');

	await eventually(() => answer !== undefined);
	answer(Ok({ text: 'arrived late' }));
	await transcribing;

	// The transcript saved since was never named to the person, so they are asked again.
	expect(await whispering.delete(confirmed)).toContain('after you were asked');
	expect(await transcripts(root)).toHaveLength(1);
	const again = expectOk(await whispering.deletionFor(entry.path));
	expect(await whispering.delete(again)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect(await transcripts(root)).toEqual([]);
});

test('a recording file that does not read is deleted alone, as the bytes it holds, and its results are kept', async () => {
	const { context, whispering, root } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	await whispering.transcribe(entry);
	await writeFile(join(root, entry.path), new Uint8Array([0xff, 0xfe, 0x00]));
	await settle(whispering, context);
	expect(whispering.repairs.map((item) => item.path)).toEqual([entry.path]);

	const deletion = expectOk(await whispering.deletionFor(entry.path));
	expect(deletion).toMatchObject({ kind: 'file', recordingId: entry.stem });
	expect(describeDeletion(deletion).description).toContain(
		'deletes only that file',
	);
	expect(await whispering.delete(deletion)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect(await transcripts(root)).toHaveLength(1);
});

// ============================================================================
// Files
// ============================================================================

test('renaming an open text file saves its typing first and moves what it saved; the selection follows', async () => {
	const { context, whispering, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await settle(whispering, context);
	expect(whispering.open('notes.md')).toBe(true);
	(await openText(whispering, context, 'notes.md')).input('typed\n');

	expect(await whispering.rename('notes.md', 'renamed.md')).toBeUndefined();
	await settle(whispering, context);

	expect(whispering.selectedPath).toBe('renamed.md');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('typed\n');
	(await openText(whispering, context, 'renamed.md')).input('typed again\n');
	await settle(whispering, context);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'typed again\n',
	);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});

test('a rename never replaces a file already at the new name', async () => {
	const { context, whispering, root } = await open();
	await writeFile(join(root, 'a.txt'), 'a\n');
	await writeFile(join(root, 'b.txt'), 'b\n');
	await settle(whispering, context);

	expect(await whispering.rename('a.txt', 'b.txt')).toContain(
		'Another file already has this name',
	);
	expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n');
	expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n');
});

test('renaming audio no recording names moves its exact bytes', async () => {
	const { context, whispering, root } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	await writeFile(join(root, 'recordings', 'loose.wav'), toneWav());
	await settle(whispering, context);

	expect(
		await whispering.rename('recordings/loose.wav', 'kept.wav'),
	).toBeUndefined();

	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, 'recordings', 'kept.wav'))),
	).toEqual(toneWav());
	expect(await Bun.file(join(root, 'recordings', 'loose.wav')).exists()).toBe(
		false,
	);
});

test('recording and transformation files keep their names, and a transcript keeps its extension', async () => {
	const { context, whispering } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	expect(await whispering.rename(entry.path, 'other.md')).toContain(
		'Change the title instead',
	);
	await whispering.transcribe(entry);
	await settle(whispering, context);
	const result = whispering.resultsFor(entry.stem)[0]!;
	expect(await whispering.rename(result.path, 'plain.txt')).toContain(
		'keeps its .md extension',
	);
	expect(await whispering.rename(result.path, 'renamed.md')).toBeUndefined();
	await settle(whispering, context);
	expect(
		whispering.edit('transcriptions', 'transcriptions/renamed.md').markdown,
	).toBeDefined();
	expect(whispering.resultsFor(entry.stem).map((item) => item.path)).toEqual([
		'transcriptions/renamed.md',
	]);
});

// ============================================================================
// Closing
// ============================================================================

test('closing refuses new work and waits for no workflow still on its way to the Folder', async () => {
	const { context, whispering, root } = await open();
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const set = whispering.services.connections.set;
	whispering.services.connections.set = async (...args) => {
		reached.resolve();
		await release.promise;
		return set(...args);
	};
	const saving = whispering.saveConnection('transcription', {
		baseUrl: TEST_BASE_URL,
		model: 'held',
		key: { action: 'keep' },
	});
	await reached.promise;

	// Held before it reaches the Folder: the folder closes without it.
	opened.splice(
		opened.findIndex((fixture) => fixture.whispering === whispering),
		1,
	);
	await closeTestWhispering({ whispering, context });
	const selected = whispering.selectedPath;
	expect(whispering.open('late.txt')).toBe(false);
	expect(whispering.selectedPath).toBe(selected);
	expect(await whispering.createFile('', 'late.txt')).toContain('closing');

	release.resolve();
	await saving;
	expect(await Bun.file(join(root, 'late.txt')).exists()).toBe(false);
});

test('closing waits for a save the Folder already admitted', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { context, whispering, root } = await open({
		beforeDiskWrite: async (path) => {
			if (!path.endsWith('kept.txt')) return;
			reached.resolve();
			await release.promise;
		},
	});
	const creating = whispering.createFile('', 'kept.txt');
	await reached.promise;
	let closed = false;
	opened.splice(
		opened.findIndex((fixture) => fixture.whispering === whispering),
		1,
	);
	const closing = closeTestWhispering({ whispering, context }).then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	expect(closed).toBe(false);

	release.resolve();
	expect(await creating).toBeUndefined();
	await closing;
	expect(await readFile(join(root, 'kept.txt'), 'utf8')).toBe('');
});

test('stopping Whispering fences direct row and source input while keeping accepted input', async () => {
	const { whispering, context } = await open();
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	const rowEdit = whispering.edit('recordings', entry.path);
	const textEdit = context.folder.files.edit(entry.path);
	await textEdit.read();
	rowEdit.change({ body: 'Accepted before stop' });
	const accepted = rowEdit.text;
	whispering.dispose();
	expect(rowEdit.locked).toBe(true);
	expect(textEdit.isLocked()).toBe(true);
	expect(
		rowEdit.change({ fields: { title: 'Too late' } }).error,
	).not.toBeNull();
	expect(textEdit.replaceText('Too late').error).not.toBeNull();
	expect(rowEdit.text).toBe(accepted);
	await rowEdit.save();
	expect(rowEdit.pending).toBeUndefined();
});

test('rename reserves both addresses against direct edits before waiting for held input', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let hold = false;
	const { whispering, context, root } = await open({
		beforeDiskWrite: async (path) => {
			if (!hold || path !== 'from.txt') return;
			reached.resolve();
			await release.promise;
		},
	});
	await whispering.createFile('', 'from.txt');
	const source = (await openText(whispering, context, 'from.txt')).view;
	const destination = context.folder.files.edit('to.txt');
	await destination.read();
	source.replaceText('Accepted source');
	hold = true;
	const renaming = whispering.rename('from.txt', 'to.txt');
	expect(source.locked).toBe(true);
	expect(destination.isLocked()).toBe(true);
	expect(source.replaceText('Too late').error).not.toBeNull();
	expect(destination.replaceText('Steal destination').error).not.toBeNull();
	await reached.promise;
	release.resolve();
	expect(await renaming).toBeUndefined();
	expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('Accepted source');
	expect(await Bun.file(join(root, 'from.txt')).exists()).toBe(false);
});

test('cascade deletion reserves every confirmed path and aborts all deletes if a result cannot save', async () => {
	let refusedPath: string | undefined;
	const { whispering, context, root, transcribed } = await open({
		beforeDiskWrite: async (path) => {
			if (path === refusedPath) throw new Error('Result cannot save');
		},
	});
	await record(whispering, context);
	const entry = whispering.entries[0]!;
	await whispering.transcribe(entry);
	await settle(whispering, context);
	const deletion = expectOk(await whispering.deletionFor(entry.path));
	if (deletion.kind !== 'recording')
		throw new Error('Expected recording deletion');
	const result = deletion.results[0]!;
	const resultEdit = whispering.edit(result);
	resultEdit.change({ body: 'Held result' });
	refusedPath = result;
	const deleting = whispering.delete(deletion);
	for (const path of [deletion.path, ...deletion.results]) {
		const edit = context.folder.files.edit(path);
		expect(edit.isLocked()).toBe(true);
		expect(edit.replaceText('Too late').error).not.toBeNull();
	}
	const requests = transcribed.length;
	await whispering.transcribe(entry);
	expect(transcribed).toHaveLength(requests);
	expect(await deleting).toContain('unsaved changes');
	expect(await Bun.file(join(root, entry.path)).exists()).toBe(true);
	expect(await Bun.file(join(root, result)).exists()).toBe(true);
	expect(resultEdit.pending).toBeDefined();
	refusedPath = undefined;
});

test('an admitted rename finishes its scoped copy and deletion while Whispering closes', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { whispering, context, root } = await open({
		beforeDiskWrite: async (path) => {
			if (path !== 'renamed.txt') return;
			reached.resolve();
			await release.promise;
		},
	});
	await whispering.createFile('', 'original.txt');
	const renaming = whispering.rename('original.txt', 'renamed.txt');
	await reached.promise;
	opened.splice(
		opened.findIndex((fixture) => fixture.whispering === whispering),
		1,
	);
	const closing = closeTestWhispering({ whispering, context });
	expect(context.folder.files.edit('original.txt').isLocked()).toBe(true);
	release.resolve();
	expect(await renaming).toBeUndefined();
	await closing;
	expect(await Bun.file(join(root, 'original.txt')).exists()).toBe(false);
	expect(await readFile(join(root, 'renamed.txt'), 'utf8')).toBe('');
});
