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
 * - Record and stop leave a row that names its audio, and the audio's exact
 *   bytes; reopening reads both, and a recording being captured never reads
 *   as absent
 * - Files an earlier version left in a directory read as they are: rows,
 *   transcripts, results, and audio, with every field kept
 * - Captured audio survives a row write that fails at start
 * - A row that does not read, such as one with no audioPath, is named for
 *   repair, repaired as text, and then used; nothing is guessed from a file's
 *   name
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
 * - Stop and Cancel wait for their own initial row save across overlapping captures
 * - Closing waits for accepted work
 */
import { closeTestLibrary, openTestLibrary } from './library.test-support.js';

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
import type { Library } from './library.svelte.js';
import type { WhisperingServices } from './platform/types.js';
import { QueryObserver, quiet } from './query.test-support.js';
import {
	eventually,
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

/** The file names under `recordings/` (rows) and `audio/` (their audio), sorted. */
const recordingFiles = async (root: string) =>
	[
		...(await readdir(join(root, 'recordings')).catch(() => [] as string[])),
		...(await readdir(join(root, 'audio')).catch(() => [] as string[])),
	].sort();

const { recordingId } = await import('./library.svelte.ts');

/** Read through the player's query policy, fetching current bytes each time. */
const readAudio = (library: Library, path: string) =>
	library.local.queryClient.fetchQuery({
		...library.local.queries.file(path, audioRead),
		staleTime: 0,
	});

const opened: Library[] = [];
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
}: Options = {}) {
	const directory = root ?? (await whisperingDirectory('whispering-library-'));
	if (root === undefined) roots.push(directory);
	const folder = await openTestFolder(directory);
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
	const library = await openTestLibrary(test);
	opened.push(library);
	return { library, root: directory, transcribed, failures, device };
}

afterEach(async () => {
	for (const library of opened.splice(0)) await closeTestLibrary(library);
	for (const root of roots.splice(0))
		await rm(dirname(root), { recursive: true, force: true });
});

async function record(library: Library) {
	await library.startRecording();
	expect(library.recorder.phase).toBe('recording');
	await library.stopRecording();
	await quiet(library);
}

/** The header's line, from the same function AppHeader calls. */
const status = (library: Library) =>
	filesLine({
		saving: library.saving,
		unsaved: library.unsaved,
		storageFailure: library.storageFailure,
		unwrittenAnswers: library.unwrittenAnswers,
	});

/** Close `library` in the test, so the next opening reads what it left. */
async function reopen(library: Library, root: string) {
	opened.splice(opened.indexOf(library), 1);
	await closeTestLibrary(library);
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

test('the first launch creates no files, and saving a connection writes nothing to the folder', async () => {
	const { library, root, device } = await open({
		connections: { connections: {} },
	});
	// Opening writes nothing: no declaration, no ignore file, no repository.
	expect(await readdir(root)).toEqual([]);
	expect(library.connections).toEqual({
		transcription: undefined,
		text: undefined,
	});

	expect(
		await library.saveConnection('transcription', {
			baseUrl: `${TEST_BASE_URL}/`,
			model: ' chosen ',
			key: { action: 'replace', key: 'typed-key' },
		}),
	).toBeUndefined();

	expect(library.connections?.transcription).toEqual({
		baseUrl: TEST_BASE_URL,
		model: 'chosen',
		keyPresent: true,
		readOnlyReason: undefined,
	});
	expect(device.stored.transcription?.apiKey).toBe('typed-key');
	expect(await readdir(root)).toEqual([]);
});

test('with no transcription connection, transcribing sends nothing and says to set one up', async () => {
	const { library, transcribed } = await open({
		connections: { connections: {} },
	});
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('No transcription connection is set up'),
	});
	expect(library.resultsFor(entry.stem)).toEqual([]);
});

// ============================================================================
// Recording
// ============================================================================

test('record and stop leave a row naming the audio’s exact bytes, and reopening reads both', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	const { fields } = entry.row;
	expect(fields.capture).toBe('fixture');
	expect(fields.durationMs).toBe(1000);
	expect(fields.audioPath).toBe(`audio/${entry.stem}.wav`);
	expect(library.selectedPath).toBe(entry.path);
	expect(library.selection?.entry?.path).toBe(entry.path);
	expect(library.showsText(entry.path)).toBe(false);
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, fields.audioPath))),
	).toEqual(toneWav());
	const row = await readFile(join(root, entry.path), 'utf8');
	expect(row).toContain(`audioPath: audio/${entry.stem}.wav`);
	expect(row).toContain('durationMs: 1000');

	const second = await reopen(library, root);

	expect(second.library.entries.map((item) => item.row.fields)).toEqual([
		fields,
	]);
	expect(
		expectOk(await readBytes(second.library.local.folder, fields.audioPath)),
	).toEqual(toneWav());
	// The player reads the same bytes, typed as the container they are.
	const audio = await readAudio(second.library, fields.audioPath);
	expect(audio.blob.type).toBe('audio/wav');
	expect<Uint8Array>(new Uint8Array(await audio.blob.arrayBuffer())).toEqual(
		toneWav(),
	);
});

test('a recording being captured, and once it stops, has its audio here, never absent', async () => {
	const { library } = await open();

	await library.startRecording();
	// The row's save is read back; the fixture's audio is written when it
	// stops, so until then the listing lacks it.
	await quiet(library);
	const [entry] = library.entries;
	expect(library.audioOf(entry!).kind).toBe('here');

	await library.stopRecording();
	expect(library.audioOf(library.entries[0]!).kind).toBe('here');
	await quiet(library);
	expect(library.audioOf(library.entries[0]!).kind).toBe('here');
});

test('a completed recording leaves settling after an unchanged listing reread', async () => {
	const { library } = await open();
	const write = library.local.folder.files.write;
	// A capture reports completion but leaves no audio file. The paths do not change.
	library.local.folder.files.write = (path, from, content) =>
		path.startsWith('audio/')
			? Promise.resolve(Ok(undefined))
			: write(path, from, content);
	try {
		await library.startRecording();
		await settle(library);
		const key = library.local.queries.files().queryKey;
		const before = library.local.queryClient.getQueryData<string[]>(key);
		await library.stopRecording();
		await library.readAgain();
		expect(library.local.queryClient.getQueryData<string[]>(key)).toBe(before);
		expect(library.audioOf(library.entries[0]!).kind).toBe('absent');
	} finally {
		library.local.folder.files.write = write;
	}
});

test('a recording’s row is written when it starts, naming its audio, and gets its length when it stops', async () => {
	const { library, root } = await open();

	await library.startRecording();

	expect(library.recorder.phase).toBe('recording');
	await quiet(library);
	const [entry] = library.entries;
	expect(entry?.row.fields).toMatchObject({
		capture: 'fixture',
		audioPath: `audio/${entry?.stem}.wav`,
	});
	expect(entry?.row.fields.durationMs).toBeUndefined();

	await library.stopRecording();
	await quiet(library);

	expect(library.entries.map((stored) => stored.row.fields.durationMs)).toEqual(
		[1000],
	);
	expect(await recordingFiles(root)).toEqual([
		`${entry?.stem}.md`,
		`${entry?.stem}.wav`,
	]);
	expect(await readdir(join(root, 'audio'))).toEqual([`${entry?.stem}.wav`]);
});

test('a title typed while recording is kept when the recording stops and gets its length', async () => {
	const { library, root } = await open();
	await library.startRecording();
	await quiet(library);
	const entry = library.entries[0]!;
	const edit = library.rowEdit('recordings', entry.path);

	edit.change({ fields: { title: 'Standup notes' } });
	await library.stopRecording();
	await edit.save();
	await settle(library);

	expect(library.entries[0]!.row.fields).toMatchObject({
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
	const { library, root } = await open({
		beforeRowCreate: async () => {
			reached.resolve();
			await release.promise;
		},
	});

	const starting = library.startRecording();
	await reached.promise;
	expect(library.recorder.phase).toBe('recording');
	const stopping = library.stopRecording();
	await Bun.sleep(10);
	release.resolve();
	await Promise.all([starting, stopping]);
	await settle(library);

	expect(library.recorderError).toBeUndefined();
	const [entry] = library.entries;
	expect(entry?.row.fields.durationMs).toBe(1000);
	expect(await readFile(join(root, entry!.path), 'utf8')).toContain(
		'durationMs: 1000',
	);
});

test('Cancel pressed while the row’s first save runs deletes the row once it is there', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeRowCreate: async () => {
			reached.resolve();
			await release.promise;
		},
	});

	const starting = library.startRecording();
	await reached.promise;
	const cancelling = library.cancelRecording();
	await Bun.sleep(10);
	release.resolve();
	await Promise.all([starting, cancelling]);
	await settle(library);

	expect(library.entries).toEqual([]);
	expect(await recordingFiles(root)).toEqual([]);
});

for (const action of ['stop', 'cancel'] as const) {
	test(`a first capture's ${action} waits for its own row while a second capture starts`, async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const firstReached = Promise.withResolvers<void>();
		const secondReached = Promise.withResolvers<void>();
		let creates = 0;
		const { library, root } = await open({
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
		const firstStart = library.startRecording();
		await firstReached.promise;
		const finishing =
			action === 'stop'
				? library.stopRecording()
				: library.cancelRecording();
		let finished = false;
		void finishing.then(() => {
			finished = true;
		});
		let secondStart: Promise<void> | undefined;
		try {
			await eventually(() => library.recorder.phase === 'idle');
			secondStart = library.startRecording();
			await secondReached.promise;
			first.resolve();
			await eventually(() => finished);
			expect(library.recorder.phase).toBe('recording');
			const saved = await readdir(join(root, 'recordings'));
			expect(saved).toHaveLength(action === 'stop' ? 1 : 0);
			if (action === 'stop')
				expect(
					await readFile(join(root, 'recordings', saved[0]!), 'utf8'),
				).toContain('durationMs: 1000');
		} finally {
			first.resolve();
			second.resolve();
			await Promise.all([firstStart, secondStart, finishing]);
		}
		await library.stopRecording();
		await settle(library);
		expect(library.entries).toHaveLength(action === 'stop' ? 2 : 1);
		for (const entry of library.entries)
			expect(entry.row.fields.durationMs).toBe(1000);
	});
}

test('cancel deletes the recording’s row', async () => {
	const { library, root } = await open();

	await library.startRecording();
	await quiet(library);
	expect(library.entries).toHaveLength(1);
	await library.cancelRecording();

	expect(library.recorder).toEqual({ phase: 'idle' });
	expect(library.entries).toEqual([]);
	expect(await recordingFiles(root)).toEqual([]);
});

test('a recording still recording is not transcribed', async () => {
	const { library, transcribed } = await open();

	await library.startRecording();
	await quiet(library);
	const [entry] = library.entries;
	await library.transcribe(entry!);

	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry!.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('still recording'),
	});
	await library.stopRecording();
});

test('a row write that fails at start leaves the recording running, says so, and its audio is still saved', async () => {
	const { library, root } = await open({ failRowWrites: 1 });

	await library.startRecording();

	expect(library.recorder.phase).toBe('recording');
	expect(library.recorderError).toContain('its file could not be written');
	expect(library.entries).toEqual([]);

	await library.stopRecording();

	const files = await recordingFiles(root);
	expect(files).toHaveLength(1);
	expect(files[0]).toEndWith('.wav');
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, 'audio', files[0]!))),
	).toEqual(toneWav());
});

test('files an earlier version left in an ordinary directory read as they are, extra fields included', async () => {
	const root = await whisperingDirectory('whispering-earlier-');
	roots.push(root);
	await mkdir(join(root, 'recordings'), { recursive: true });
	await mkdir(join(root, 'audio'), { recursive: true });
	await mkdir(join(root, 'transcriptions'), { recursive: true });
	const recording =
		'---\ntitle: Kept take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: microphone\naudioPath: audio/kept.wav\nmood: calm\n---\nMy notes\n';
	await writeFile(join(root, 'recordings', 'kept.md'), recording);
	await writeFile(join(root, 'audio', 'kept.wav'), toneWav());
	await writeFile(
		join(root, 'transcriptions', 'kept-t.md'),
		'---\nrecordingId: kept\ncreatedAt: 2026-01-02T03:05:00.000Z\nmodel: whisper-1\nendpoint: https://api.openai.com/v1\n---\nhello there\n',
	);
	// What the earlier version published beside its files stays as it is.
	await writeFile(join(root, 'epicenter.json'), '{"title":"Whispering"}\n');

	const { library } = await open({ root });

	const entry = library.entries[0]!;
	expect(entry.stem).toBe('kept');
	expect(entry.row.fields).toMatchObject({
		title: 'Kept take',
		audioPath: 'audio/kept.wav',
	});
	expect(entry.row.body).toBe('My notes\n');
	expect(library.audioOf(entry).kind).toBe('here');
	expect(library.resultsFor('kept').map((item) => item.row.body)).toEqual([
		'hello there\n',
	]);
	expect(
		expectOk(await readBytes(library.local.folder, 'audio/kept.wav')),
	).toEqual(toneWav());

	// Editing the notes keeps the field this version does not know.
	const view = library.rowEdit('recordings', entry.path);
	expect(view.row?.body).toBeDefined();
	library.editBody(view, 'My notes, edited\n');
	await view.save();
	await settle(library);
	const saved = await readFile(join(root, 'recordings', 'kept.md'), 'utf8');
	expect(saved).toContain('mood: calm');
	expect(saved).toContain('My notes, edited');
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
		'{"title":"Whispering"}\n',
	);
});

test('a row written before audioPath does not read: it is named for repair, and no same-stem file is used', async () => {
	const { library, root, transcribed } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	await mkdir(join(root, 'audio'), { recursive: true });
	const old =
		'---\ntitle: Old take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\nNotes\n';
	await writeFile(join(root, 'recordings', 'old.md'), old);
	await writeFile(join(root, 'audio', 'old.wav'), toneWav());
	await settle(library);

	expect(library.entries).toEqual([]);
	expect(library.repairs).toEqual([
		{
			path: 'recordings/old.md',
			stem: 'old',
			reason: expect.stringContaining('audioPath'),
		},
	]);
	expect(library.isRecording('recordings/old.md')).toBe(true);
	expect(library.recordingNaming('audio/old.wav')).toBeUndefined();

	// The person repairs it as text by naming the audio.
	expect(await library.open('recordings/old.md')).toBeUndefined();
	expect(library.showsText('recordings/old.md')).toBe(true);
	const text = await openText(library, 'recordings/old.md');
	expect(text.draft).toBe(old);
	text.input(
		old.replace(
			'capture: fixture\n',
			'capture: fixture\naudioPath: audio/old.wav\n',
		),
	);
	await settle(library);
	expect(await library.useForm('recordings/old.md')).toBeUndefined();
	await settle(library);
	const repaired = library.entries.find((item) => item.stem === 'old')!;
	expect(library.recordingNaming('audio/old.wav')?.path).toBe(
		'recordings/old.md',
	);
	await library.transcribe(repaired);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		'audio/old.wav',
	]);
});

test('audio replaced by bytes of the same length is noticed by its content', async () => {
	const { library, root } = await open();
	await record(library);
	const path = library.entries[0]!.row.fields.audioPath;
	const observer = new QueryObserver(
		library.local.queryClient,
		library.local.queries.file(path, audioRead),
	);
	const stop = observer.subscribe(() => {});
	try {
		const first = await readAudio(library, path);

		await settle(library);
		expect(await readAudio(library, path)).toBe(first);

		const replaced = new Uint8Array(toneWav({ frequency: 880 }));
		expect(replaced.length).toBe(toneWav().length);
		await writeFile(join(root, path), replaced);
		await settle(library);

		const next = await readAudio(library, path);
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
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const { audioPath } = entry.row.fields;

	await library.transcribe(entry);
	await quiet(library);

	expect(transcribed).toEqual([
		{
			audioPath,
			expectedBaseUrl: TEST_BASE_URL,
			model: 'verification-model',
		},
	]);
	const results = library.resultsFor(entry.stem);
	expect(results.map((result) => result.row.body)).toEqual(['a steady tone\n']);
	const row = await readFile(join(root, results[0]!.path), 'utf8');
	expect(row).toContain(entry.stem);
	expect(row).toContain('model: verification-model');

	const second = await reopen(library, root);

	expect(second.library.entries.map((item) => item.path)).toEqual([entry.path]);
	expect(second.library.resultsFor(entry.stem)[0]!.row.body).toBe(
		'a steady tone\n',
	);
	expect(
		expectOk(await readBytes(second.library.local.folder, audioPath)),
	).toEqual(toneWav());
});

const transcripts = (root: string) =>
	readdir(join(root, 'transcriptions')).catch(() => [] as string[]);

/** The state of the newest transcript of `recording`. */
function newest(library: Library, recording: string) {
	const transcript = library.resultsFor(recording)[0]!;
	return {
		transcript,
		state: library.resultState(transcript.path, transcript.row.body),
	};
}

test('a transcript row is written with an empty body before the request goes out, and filled when the answer arrives', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { library, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(library);
	const entry = library.entries[0]!;

	const transcribing = library.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(library);

	const { transcript, state } = newest(library, entry.stem);
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
	await settle(library);

	expect(newest(library, entry.stem).state.kind).toBe('answered');
	expect(library.resultsFor(entry.stem).map((item) => item.row.body)).toEqual([
		'arrived\n',
	]);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
});

test('an answer is filled as a change from the empty row: a field changed meanwhile is kept', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { library, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(library);
	const entry = library.entries[0]!;
	const transcribing = library.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(library);
	const { transcript } = newest(library, entry.stem);

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
	await settle(library);

	const saved = await readFile(file, 'utf8');
	expect(saved).toContain('language: en');
	expect(saved).toEndWith('arrived\n');
});

test('a transport that throws leaves the row unfinished; running it again sends the same request into the same row', async () => {
	let attempts = 0;
	const { library, root, transcribed } = await open({
		transcribe: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'second try' });
		},
	});
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);
	await settle(library);

	const { transcript, state } = newest(library, entry.stem);
	expect(state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});
	expect(library.transcriptionRun(entry.stem)).toBeUndefined();
	expect(transcript.row.body).toBe('');

	expect(await library.runAgain(transcript.path)).toBeUndefined();
	await settle(library);

	expect(attempts).toBe(2);
	expect(transcribed[1]).toEqual(transcribed[0]);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
	expect(library.resultsFor(entry.stem)[0]!.row.body).toBe('second try\n');
	expect(await library.runAgain(transcript.path)).toContain(
		'already has its answer',
	);
	expect(attempts).toBe(2);
});

test('a row that cannot be written when the run starts sends nothing, and says why', async () => {
	const { library, root, transcribed } = await open({ failResultStarts: 1 });
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('Nothing was sent'),
	});
	expect(await transcripts(root)).toEqual([]);
});

test('an answer whose write fails is written again while the page lives, and does not hold the page open', async () => {
	const { library, root } = await open({ failAnswerWrites: 2 });
	await record(library);
	await settle(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);
	await settle(library);

	expect(newest(library, entry.stem).state).toMatchObject({
		kind: 'writing',
		text: 'a steady tone',
		message: expect.stringContaining('the disk refused the result'),
	});
	expect(library.unwrittenAnswers).toBe(1);
	expect(status(library).label).toBe('1 answer not written yet');

	await eventually(() => library.unwrittenAnswers === 0);
	await settle(library);

	expect(library.resultsFor(entry.stem)[0]!.row.body).toBe('a steady tone\n');
	expect(await transcripts(root)).toHaveLength(1);
	expect(status(library).tone).toBe('good');
});

test('after a reload, a row whose answer was never written is unfinished, and running it again fills it', async () => {
	const first = await open({ failAnswerWrites: 100 });
	await record(first.library);
	const entry = first.library.entries[0]!;
	await first.library.transcribe(entry);
	await settle(first.library);
	expect(newest(first.library, entry.stem).state.kind).toBe('writing');

	const second = await reopen(first.library, first.root);

	const { transcript, state } = newest(second.library, entry.stem);
	expect(state.kind).toBe('unfinished');
	expect(transcript.row.body).toBe('');
	expect(second.library.unwrittenAnswers).toBe(0);

	expect(await second.library.runAgain(transcript.path)).toBeUndefined();
	await settle(second.library);

	expect(second.transcribed).toHaveLength(1);
	expect(
		second.library.resultsFor(entry.stem).map((item) => item.stem),
	).toEqual([transcript.stem]);
	expect(newest(second.library, entry.stem).state.kind).toBe('answered');
});

test('a running transcription cannot be asked for again; deleting its row discards it, and its answer writes nothing', async () => {
	const answer =
		Promise.withResolvers<
			Awaited<ReturnType<WhisperingServices['transcribe']>>
		>();
	const { library, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(library);
	const entry = library.entries[0]!;
	const transcribing = library.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	await settle(library);
	const { transcript } = newest(library, entry.stem);

	await library.transcribe(entry);
	expect(transcribed).toHaveLength(1);
	expect(await library.runAgain(transcript.path)).toContain('already running');

	const deletion = expectOk(await library.deletionFor(transcript.path));
	expect(await library.delete(deletion)).toBeUndefined();
	answer.resolve(Ok({ text: 'too late' }));
	await transcribing;
	await settle(library);

	expect(await transcripts(root)).toEqual([]);
	expect(library.resultsFor(entry.stem)).toEqual([]);
	expect(library.unwrittenAnswers).toBe(0);
});

// ============================================================================
// Deleting a recording
// ============================================================================

test('deleting a recording removes its row and results, keeps its audio, and says so first', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const { audioPath } = entry.row.fields;
	await library.transcribe(entry);
	await settle(library);

	const deletion = expectOk(await library.deletionFor(entry.path));
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion).description;
	expect(asked).toContain(
		`This deletes ${entry.path}, 1 result from the folder.`,
	);
	expect(asked).toContain(`Its audio ${audioPath} is not deleted`);
	expect(asked).not.toMatch(/version|history/i);
	expect(await library.delete(deletion)).toBeUndefined();
	await settle(library);

	expect(library.entries).toHaveLength(0);
	expect(await transcripts(root)).toEqual([]);
	// The table removed its row file. The audio is an ordinary file and stays.
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, audioPath))),
	).toEqual(toneWav());

	// The audio is deleted as the file it is, from Files, with its own question.
	expect(library.recordingNaming(audioPath)).toBeUndefined();
	const file = expectOk(await library.deletionFor(audioPath));
	expect(file).toMatchObject({ kind: 'file', path: audioPath });
	expect(await library.delete(file)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([]);
});

test('deleting the audio a recording names keeps the recording, and the missing file is reported', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const { audioPath } = entry.row.fields;
	expect(await library.rename(audioPath, 'other.wav')).toContain(
		'names this audio file',
	);

	const deletion = expectOk(await library.deletionFor(audioPath));
	expect(describeDeletion(deletion).description).toContain(
		'names it as its audio and is kept',
	);
	expect(await library.delete(deletion)).toBeUndefined();
	await settle(library);

	expect(await recordingFiles(root)).toEqual([`${entry.stem}.md`]);
	expect(library.entries[0]!.row.fields.audioPath).toBe(audioPath);
	expect(library.audioOf(library.entries[0]!).kind).toBe('absent');
	await expect(readAudio(library, audioPath)).rejects.toThrow('No file exists');
});

test('a file is deleted as it holds when the deletion runs, whatever changed since the person was asked', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.txt'), 'first\n');
	await settle(library);
	const deletion = expectOk(await library.deletionFor('notes.txt'));

	await writeFile(join(root, 'notes.txt'), 'changed elsewhere\n');
	const kept = await library.delete(deletion);

	// The person asked to delete the file; it goes as it is now.
	expect(kept).toBeUndefined();
	expect(await Bun.file(join(root, 'notes.txt')).exists()).toBe(false);
});

test('a recording is not deleted while a result cannot say which recording it belongs to', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	await settle(library);

	await writeFile(
		join(root, 'transcriptions/unparsed.md'),
		`---\nrecordingId: ${entry.stem}\nmodel: [open\n---\ntext\n`,
	);
	const { error: refusal } = await library.deletionFor(entry.path);
	expect(refusal).toContain('cannot be told apart');
	expect(refusal).toContain('transcriptions/unparsed.md');

	// A deletion confirmed before such a file appeared is refused when it runs.
	await rm(join(root, 'transcriptions/unparsed.md'));
	const confirmed = expectOk(await library.deletionFor(entry.path));
	await mkdir(join(root, 'transformation_runs'), { recursive: true });
	await writeFile(join(root, 'transformation_runs/odd.md'), 'no fence\n');
	expect(await library.delete(confirmed)).toContain('cannot be told apart');
	expect(await recordingFiles(root)).toHaveLength(2);

	await rm(join(root, 'transformation_runs/odd.md'));
	expect(await library.delete(confirmed)).toBeUndefined();
	await settle(library);
	expect(library.entries).toEqual([]);
});

test('a recording cannot be deleted while its transcription runs, including one started after confirming', async () => {
	let answer!: (
		value: Awaited<ReturnType<WhisperingServices['transcribe']>>,
	) => void;
	const { library, root } = await open({
		transcribe: () => new Promise((resolve) => (answer = resolve)),
	});
	await record(library);
	const entry = library.entries[0]!;
	const confirmed = expectOk(await library.deletionFor(entry.path));

	const transcribing = library.transcribe(entry);
	expect((await library.deletionFor(entry.path)).error).toContain(
		'still running',
	);
	expect(await library.delete(confirmed)).toContain('still running');

	await eventually(() => answer !== undefined);
	answer(Ok({ text: 'arrived late' }));
	await transcribing;

	// The transcript saved since was never named to the person, so they are asked again.
	expect(await library.delete(confirmed)).toContain('after you were asked');
	expect(await transcripts(root)).toHaveLength(1);
	const again = expectOk(await library.deletionFor(entry.path));
	expect(await library.delete(again)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect(await transcripts(root)).toEqual([]);
});

test('a recording file that does not read is deleted alone, as the bytes it holds, and its results are kept', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	await writeFile(join(root, entry.path), new Uint8Array([0xff, 0xfe, 0x00]));
	await settle(library);
	expect(library.repairs.map((item) => item.path)).toEqual([entry.path]);

	const deletion = expectOk(await library.deletionFor(entry.path));
	expect(deletion).toMatchObject({ kind: 'file', recordingId: entry.stem });
	expect(describeDeletion(deletion).description).toContain(
		'deletes only that file',
	);
	expect(await library.delete(deletion)).toBeUndefined();
	expect(await recordingFiles(root)).toEqual([`${entry.stem}.wav`]);
	expect(await transcripts(root)).toHaveLength(1);
});

// ============================================================================
// Files
// ============================================================================

test('renaming an open text file saves its typing first and moves what it saved; the selection follows', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await settle(library);
	expect(await library.open('notes.md')).toBeUndefined();
	(await openText(library, 'notes.md')).input('typed\n');

	expect(await library.rename('notes.md', 'renamed.md')).toBeUndefined();
	await settle(library);

	expect(library.selectedPath).toBe('renamed.md');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('typed\n');
	(await openText(library, 'renamed.md')).input('typed again\n');
	await settle(library);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'typed again\n',
	);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});

test('a rename never replaces a file already at the new name', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'a.txt'), 'a\n');
	await writeFile(join(root, 'b.txt'), 'b\n');
	await settle(library);

	expect(await library.rename('a.txt', 'b.txt')).toContain(
		'Another file already has this name',
	);
	expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n');
	expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n');
});

test('renaming audio no recording names moves its exact bytes', async () => {
	const { library, root } = await open();
	await mkdir(join(root, 'audio'), { recursive: true });
	await writeFile(join(root, 'audio', 'loose.wav'), toneWav());
	await settle(library);

	expect(await library.rename('audio/loose.wav', 'kept.wav')).toBeUndefined();

	expect<Uint8Array>(
		new Uint8Array(await readFile(join(root, 'audio', 'kept.wav'))),
	).toEqual(toneWav());
	expect(await Bun.file(join(root, 'audio', 'loose.wav')).exists()).toBe(false);
});

test('recording and transformation files keep their names, and a transcript keeps its extension', async () => {
	const { library } = await open();
	await record(library);
	const entry = library.entries[0]!;
	expect(await library.rename(entry.path, 'other.md')).toContain(
		'Change the title instead',
	);
	await library.transcribe(entry);
	await settle(library);
	const result = library.resultsFor(entry.stem)[0]!;
	expect(await library.rename(result.path, 'plain.txt')).toContain(
		'keeps its .md extension',
	);
	expect(await library.rename(result.path, 'renamed.md')).toBeUndefined();
	await settle(library);
	expect(
		library.rowEdit('transcriptions', 'transcriptions/renamed.md').row,
	).toBeDefined();
	expect(library.resultsFor(entry.stem).map((item) => item.path)).toEqual([
		'transcriptions/renamed.md',
	]);
});

// ============================================================================
// Closing
// ============================================================================

test('close drains accepted work and refuses new work', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeFileWrite: async (path) => {
			if (path !== 'first.txt') return;
			reached.resolve();
			await release.promise;
		},
	});
	const first = library.createFile('', 'first.txt');
	await reached.promise;
	let closed = false;
	const closing = closeTestLibrary(library).then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(await library.createFile('', 'late.txt')).toContain('closing');
	await Bun.sleep(10);
	expect(closed).toBe(false);
	release.resolve();
	expect(await first).toBeUndefined();
	await closing;
	opened.splice(opened.indexOf(library), 1);
	expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('');
	expect(await Bun.file(join(root, 'late.txt')).exists()).toBe(false);
});

test('close waits for a rename still copying, and the rename finishes before the folder closes', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeFileWrite: async (path) => {
			if (path !== 'renamed.md') return;
			reached.resolve();
			await release.promise;
		},
	});
	await writeFile(join(root, 'notes.md'), 'original\n');
	await settle(library);

	const renaming = library.rename('notes.md', 'renamed.md');
	await reached.promise;
	let closed = false;
	const closing = closeTestLibrary(library).then(() => {
		closed = true;
	});
	await Bun.sleep(10);
	expect(closed).toBe(false);

	release.resolve();
	expect(await renaming).toBeUndefined();
	await closing;
	opened.splice(opened.indexOf(library), 1);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('original\n');
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});
