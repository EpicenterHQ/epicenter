/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and a stubbed transcription answer. No window,
 * shell, or microphone is involved, so these establish the workflow's logic and
 * what it leaves on disk, not that the desktop app runs. Editing open drafts
 * is covered in `editing.test.ts`.
 *
 * Key behaviors:
 * - A first launch creates no files or history, and saving a connection
 *   writes nothing to the folder
 * - `kv.json` from an earlier build is read and reported, never written, and
 *   never where a request goes
 * - Record, stop, and save produce audio, a row that names it, and a commit
 * - Captured audio and its id survive a row write that fails after the
 *   audio landed, and an explicit retry finishes one recording
 * - A row that does not read, such as one with no audioPath, is named for
 *   repair; nothing is guessed from a file's name
 * - Deleting a recording deletes its row and its results and keeps its audio. It is
 *   refused while work for it runs or a result cannot say whose it is
 * - A transcription result is its own row naming the recording, written with
 *   an empty body before the request goes out and filled when the answer
 *   arrives (ADR-0542)
 * - A row with no body and no request in this window is unfinished; running
 *   it again fills the same row, and deleting it discards it
 * - An answer whose write fails is written again while the page lives; after
 *   a reload its row is unfinished
 * - Renaming a file moves its open draft; recording and transformation files
 *   keep their names
 * - Closing waits for admitted commands
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathProblem } from '@epicenter/folder';
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { loadAudio } from './audio-source.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { recordingAudioStem } from './definition.js';
import { describeDeletion } from './deletion.js';
import { openText, settle } from './edits.test-support.js';
import type { Library } from './library.svelte.js';
import { createQueryClient } from './query.test-support.js';
import {
	commitLine,
	filesLine,
	summaryLine,
	uncommittedLine,
} from './status.js';
import { WHISPERING_FOLDER_ID, type Workspace } from './workspace/types.js';
import {
	eventually,
	openTestFolder,
	type ResultFailures,
	TEST_BASE_URL,
	testConnections,
	testInjection,
	withResultFailures,
} from './workspace.test-support.js';

const { createLibrary, recordingId } = await import('./library.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

type Options = {
	/** Fail this many recording row writes after the audio lands. */
	failRowWrites?: number;
	/** Fail this many transcript rows written when a transcription starts. */
	failResultStarts?: number;
	/** Fail this many answers written into transcript rows. */
	failAnswerWrites?: number;
	/** Replace the stubbed transcription answer. */
	transcribe?: Workspace['transcribe'];
	root?: string;
	beforeFileCreate?: () => Promise<void>;
	/** Runs before each `files.read` of the folder. */
	beforeFileRead?: (path: string) => Promise<void>;
	/** Stand in front of the folder's settings methods; `real` is the folder's own. */
	kv?: (real: Kv) => Kv;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Parameters<typeof testConnections>[0];
};
type Kv = Workspace['folder']['kv'];

async function open({
	failRowWrites = 0,
	failResultStarts = 0,
	failAnswerWrites = 0,
	transcribe,
	beforeFileCreate,
	beforeFileRead,
	root,
	kv,
	connections,
}: Options = {}) {
	const directory =
		root ??
		(await realpath(await mkdtemp(join(tmpdir(), 'whispering-library-'))));
	if (root === undefined) roots.push(directory);
	const folder = await openTestFolder(directory);
	/** Result row writes still to fail. A test may arm more after opening. */
	const failures: ResultFailures = {
		starts: failResultStarts,
		answers: failAnswerWrites,
	};
	const tables = {
		...folder.tables,
		transcriptions: withResultFailures(folder.tables.transcriptions, failures),
	};
	const transcribed: Parameters<Workspace['transcribe']>[0][] = [];
	const device = testConnections(connections);
	const workspace: Workspace = {
		kind: 'native',
		folder: {
			...folder,
			tables,
			kv: kv?.(folder.kv) ?? folder.kv,
			files: {
				...folder.files,
				async create(path, content) {
					await beforeFileCreate?.();
					return folder.files.create(path, content);
				},
				async read(path) {
					await beforeFileRead?.(path);
					return folder.files.read(path);
				},
			},
		} as Workspace['folder'],
		folderId: WHISPERING_FOLDER_ID,
		location: directory,
		terminal: {
			cwd: '/',
			exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
			note: 'test',
		},
		capture: createFixtureDevice({
			name: 'tone.wav',
			load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
		}),
		captureNotice: undefined,
		reveal: undefined,
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
		debugControls: true,
		// A debug shell's injection: the row write fails after the audio landed.
		injection: testInjection(directory, { audio: 0, row: failRowWrites }),
		close: () => folder.close(),
	};
	const library = createLibrary(workspace, createQueryClient());
	opened.push(library);
	await library.start();
	return { library, root: directory, transcribed, failures, device };
}

afterEach(async () => {
	for (const library of opened.splice(0)) await library.close();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8' });

async function record(library: Library) {
	await library.startRecording();
	expect(library.recorder.phase).toBe('recording');
	await library.stopRecording();
}

/** The header's lines, from the same function AppHeader calls. */
function status(library: Library) {
	const files = filesLine(library);
	return {
		files,
		summary: summaryLine({
			files,
			uncommitted: uncommittedLine(library.git),
			commit: commitLine(library.git),
		}),
	};
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

test('the first launch creates no files or history, and saving a connection writes nothing to the folder', async () => {
	const { library, root, device } = await open({
		connections: { connections: {} },
	});
	// Opening writes nothing: not the definition, which waits for a write,
	// and no repository, which the first commit creates.
	expect(await readdir(root)).toEqual([]);
	expect(library.connections).toEqual({
		transcription: undefined,
		text: undefined,
		legacyKey: false,
	});
	expect(library.legacySettings).toEqual({});

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

test('kv.json from an earlier build is offered, never written, and never where a request goes', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-library-')),
	);
	roots.push(root);
	const saved =
		'{"transcriptionBaseUrl": "https://elsewhere.example/v1", "transcriptionModel": "old-model"}\n';
	await writeFile(join(root, 'kv.json'), saved);
	const { library, transcribed } = await open({ root });

	expect(library.legacySettings).toEqual({
		transcriptionBaseUrl: 'https://elsewhere.example/v1',
		transcriptionModel: 'old-model',
	});
	await record(library);
	await library.transcribe(library.entries[0]!);

	// The request is prepared for the device's connection, never kv.json's.
	expect(transcribed).toEqual([
		expect.objectContaining({
			expectedBaseUrl: TEST_BASE_URL,
			model: 'verification-model',
		}),
	]);
	expect(
		library.resultsFor(library.entries[0]!.stem)[0]!.row.fields,
	).toMatchObject({ endpoint: TEST_BASE_URL, model: 'verification-model' });
	expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(saved);
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

test('a launch whose kv.json read fails creates no settings file and says why', async () => {
	const { library, root } = await open({
		kv: (real) => ({
			...real,
			get: async () =>
				FileError.Io({
					path: 'kv.json',
					operation: 'read',
					cause: new Error('disk refused the read'),
				}),
		}),
	});

	expect(await readdir(root)).not.toContain('kv.json');
	expect(library.settingsProblem).toContain('disk refused the read');
	expect(library.legacySettings).toEqual({});
});

test('kv.json that does not parse, or holds a value that does not conform, is the settings problem, and only values that read are offered', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-library-')),
	);
	roots.push(root);
	await writeFile(join(root, 'kv.json'), '{"transcriptionModel": ');
	const { library } = await open({ root });

	expect(library.settingsProblem).toContain('not valid JSON');
	expect(library.legacySettings).toEqual({});

	await writeFile(
		join(root, 'kv.json'),
		'{"transcriptionModel": 7, "transcriptionBaseUrl": "http://kept"}\n',
	);
	await settle(library);
	expect(library.settingsProblem).toContain('transcriptionModel');
	expect(library.legacySettings).toEqual({
		transcriptionBaseUrl: 'http://kept',
	});

	await writeFile(join(root, 'kv.json'), '{"transcriptionModel": "kept"}\n');
	await settle(library);
	expect(library.settingsProblem).toBeUndefined();
	expect(library.legacySettings).toEqual({ transcriptionModel: 'kept' });
});

// ============================================================================
// Recording
// ============================================================================

test('record, stop, and save leave a row, real audio, and a commit, and the recording opens', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	const { fields } = entry.row;
	expect(fields.capture).toBe('fixture');
	expect(fields.durationMs).toBe(1000);
	expect(fields.audioPath).toBe(`recordings/${entry.stem}.wav`);
	expect(library.selectedPath).toBe(entry.path);
	expect(library.selection?.entry?.path).toBe(entry.path);
	expect(library.showsText(entry.path)).toBe(false);
	expect(new Uint8Array(await readFile(join(root, fields.audioPath)))).toEqual(
		new Uint8Array(toneWav()),
	);

	const outcome = await library.saveVersion();
	expect(['committed', 'unchanged']).toContain(outcome.status);
	const tree = git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
	expect(tree).toContain(entry.path);
	expect(tree).toContain(fields.audioPath);
	expect(tree).not.toContain('kv.json');
});

test('a recording’s row is written when it starts, naming its audio, and gets its length when it stops', async () => {
	const { library, root } = await open();

	await library.startRecording();

	expect(library.recorder.phase).toBe('recording');
	const [entry] = library.entries;
	expect(entry?.row.fields).toMatchObject({
		capture: 'fixture',
		audioPath: `recordings/${entry?.stem}.wav`,
	});
	expect(entry?.row.fields.durationMs).toBeUndefined();

	await library.stopRecording();

	expect(library.entries.map((stored) => stored.row.fields.durationMs)).toEqual(
		[1000],
	);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${entry?.stem}.md`,
		`${entry?.stem}.wav`,
	]);
});

test('cancel deletes the recording’s row and its audio', async () => {
	const { library, root } = await open();

	await library.startRecording();
	expect(library.entries).toHaveLength(1);
	await library.cancelRecording();

	expect(library.recorder).toEqual({ phase: 'idle' });
	expect(library.entries).toEqual([]);
	expect(await readdir(join(root, 'recordings'))).toEqual([]);
});

test('a recording still recording is not transcribed', async () => {
	const { library, transcribed } = await open();

	await library.startRecording();
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

	const files = await readdir(join(root, 'recordings'));
	expect(files).toHaveLength(1);
	expect(files[0]).toEndWith('.wav');
});

test('a row written before audioPath does not read: it is named for repair, and no same-stem file is used', async () => {
	const { library, root, transcribed } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	const old =
		'---\ntitle: Old take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\nNotes\n';
	await writeFile(join(root, 'recordings', 'old.md'), old);
	await writeFile(join(root, 'recordings', 'old.wav'), toneWav());
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
	expect(library.recordingNaming('recordings/old.wav')).toBeUndefined();

	// The person repairs it as text by naming the audio.
	expect(await library.open('recordings/old.md')).toBeUndefined();
	expect(library.showsText('recordings/old.md')).toBe(true);
	const text = await openText(library, 'recordings/old.md');
	expect(text.draft).toBe(old);
	text.input(
		old.replace(
			'capture: fixture\n',
			'capture: fixture\naudioPath: recordings/old.wav\n',
		),
	);
	await settle(library);
	expect(await library.useForm('recordings/old.md')).toBeUndefined();
	await settle(library);
	const repaired = library.entries.find((item) => item.stem === 'old')!;
	expect(library.recordingNaming('recordings/old.wav')?.path).toBe(
		'recordings/old.md',
	);
	await library.transcribe(repaired);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		'recordings/old.wav',
	]);
});

test('audio replaced by bytes of the same length is noticed by its content', async () => {
	const { library, root } = await open();
	await record(library);
	const path = library.entries[0]!.row.fields.audioPath;
	const first = expectOk(
		await loadAudio(library.folder.files, path, undefined),
	);

	const before = library.generation;
	await settle(library);
	expect(library.generation).toBeGreaterThan(before);
	expect(expectOk(await loadAudio(library.folder.files, path, first))).toBe(
		first,
	);

	const replaced = new Uint8Array(toneWav({ frequency: 880 }));
	expect(replaced.length).toBe(toneWav().length);
	await writeFile(join(root, path), replaced);
	await settle(library);

	const next = expectOk(await loadAudio(library.folder.files, path, first));
	expect(next).not.toBe(first);
	expect(new Uint8Array(await next!.blob.arrayBuffer())).toEqual(replaced);
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
	expect(row).toContain(`recordingId: "${entry.stem}"`);
	expect(row).toContain('model: verification-model');
	await library.saveVersion();
	opened.splice(opened.indexOf(library), 1);
	await library.close();

	const second = await open({ root });

	expect(second.library.entries.map((item) => item.path)).toEqual([entry.path]);
	expect(second.library.resultsFor(entry.stem)[0]!.row.body).toBe(
		'a steady tone\n',
	);
	const audio = expectOk(await second.library.folder.files.open(audioPath));
	expect(new Uint8Array(await audio.arrayBuffer())).toEqual(
		new Uint8Array(toneWav()),
	);
	expect(git(root, 'status', '--porcelain').trim()).toBe('');
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
		Promise.withResolvers<Awaited<ReturnType<Workspace['transcribe']>>>();
	const { library, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(library);
	const entry = library.entries[0]!;

	const transcribing = library.transcribe(entry);
	await eventually(() => transcribed.length === 1);

	const { transcript, state } = newest(library, entry.stem);
	expect(state.kind).toBe('running');
	expect(transcript.row).toEqual({
		fields: {
			recordingId: entry.stem,
			createdAt: expect.any(String),
			model: 'verification-model',
			endpoint: TEST_BASE_URL,
		},
		body: '',
	});
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
	// What is happening is never written: the row holds facts only.
	expect(await readFile(join(root, transcript.path), 'utf8')).not.toContain(
		'status',
	);

	answer.resolve(Ok({ text: 'arrived' }));
	await transcribing;

	expect(newest(library, entry.stem).state.kind).toBe('answered');
	expect(library.resultsFor(entry.stem).map((item) => item.row.body)).toEqual([
		'arrived\n',
	]);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
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

	const { transcript, state } = newest(library, entry.stem);
	expect(state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});
	expect(library.transcriptionRun(entry.stem)).toBeUndefined();
	expect(transcript.row.body).toBe('');

	expect(await library.runAgain(transcript.path)).toBeUndefined();

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
	await library.saveVersion();
	await settle(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(newest(library, entry.stem).state).toMatchObject({
		kind: 'writing',
		text: 'a steady tone',
		message: expect.stringContaining('disk refused the result'),
	});
	expect(library.unwrittenAnswers).toBe(1);
	expect(status(library).files.label).toBe('1 answer not written yet');

	await eventually(() => library.unwrittenAnswers === 0);
	await settle(library);

	expect(library.resultsFor(entry.stem)[0]!.row.body).toBe('a steady tone\n');
	expect(await transcripts(root)).toHaveLength(1);
	expect(status(library).files.tone).toBe('good');
});

test('after a reload, a row whose answer was never written is unfinished, and running it again fills it', async () => {
	const first = await open({ failAnswerWrites: 100 });
	await record(first.library);
	const entry = first.library.entries[0]!;
	await first.library.transcribe(entry);
	expect(newest(first.library, entry.stem).state.kind).toBe('writing');
	opened.splice(opened.indexOf(first.library), 1);
	await first.library.close();

	const second = await open({ root: first.root });

	const { transcript, state } = newest(second.library, entry.stem);
	expect(state.kind).toBe('unfinished');
	expect(transcript.row.body).toBe('');
	expect(second.library.unwrittenAnswers).toBe(0);

	expect(await second.library.runAgain(transcript.path)).toBeUndefined();

	expect(second.transcribed).toHaveLength(1);
	expect(
		second.library.resultsFor(entry.stem).map((item) => item.stem),
	).toEqual([transcript.stem]);
	expect(newest(second.library, entry.stem).state.kind).toBe('answered');
});

test('a running transcription cannot be asked for again; deleting its row discards it, and its answer writes nothing', async () => {
	const answer =
		Promise.withResolvers<Awaited<ReturnType<Workspace['transcribe']>>>();
	const { library, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(library);
	const entry = library.entries[0]!;
	const transcribing = library.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const { transcript } = newest(library, entry.stem);

	await library.transcribe(entry);
	expect(transcribed).toHaveLength(1);
	expect(await library.runAgain(transcript.path)).toContain('already running');

	const deletion = expectOk(await library.deletionFor(transcript.path));
	expect(await library.remove(deletion)).toBeUndefined();
	answer.resolve(Ok({ text: 'too late' }));
	await transcribing;

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

	const deletion = expectOk(await library.deletionFor(entry.path));
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion).description;
	expect(asked).toContain(
		`This deletes ${entry.path}, 1 result from the folder.`,
	);
	expect(asked).toContain(`Its audio ${audioPath} is not deleted`);
	expect(await library.remove(deletion)).toBeUndefined();

	expect(library.entries).toHaveLength(0);
	expect(await transcripts(root)).toEqual([]);
	// The table removed its row file. The audio is an ordinary file and stays.
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
	expect(new Uint8Array(await readFile(join(root, audioPath)))).toEqual(
		new Uint8Array(toneWav()),
	);

	// The audio is deleted as the file it is, from Files, with its own question.
	expect(library.recordingNaming(audioPath)).toBeUndefined();
	const file = expectOk(await library.deletionFor(audioPath));
	expect(file).toMatchObject({ kind: 'file', file: { path: audioPath } });
	expect(await library.remove(file)).toBeUndefined();
	expect(await readdir(join(root, 'recordings'))).toEqual([]);
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
	expect(await library.remove(deletion)).toBeUndefined();

	expect(await readdir(join(root, 'recordings'))).toEqual([`${entry.stem}.md`]);
	expect(library.entries[0]!.row.fields.audioPath).toBe(audioPath);
	const { error: loadError } = await loadAudio(
		library.folder.files,
		audioPath,
		undefined,
	);
	expect(loadError?.name).toBe('NotFound');
});

test('a recording is not deleted while a result cannot say which recording it belongs to', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);

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
	expect(await library.remove(confirmed)).toContain('cannot be told apart');
	expect(await readdir(join(root, 'recordings'))).toHaveLength(2);

	await rm(join(root, 'transformation_runs/odd.md'));
	expect(await library.remove(confirmed)).toBeUndefined();
	expect(library.entries).toEqual([]);
});

test('a recording cannot be deleted while its transcription runs, including one started after confirming', async () => {
	let answer!: (value: Awaited<ReturnType<Workspace['transcribe']>>) => void;
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
	expect(await library.remove(confirmed)).toContain('still running');

	await eventually(() => answer !== undefined);
	answer(Ok({ text: 'arrived late' }));
	await transcribing;

	// The transcript saved since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await transcripts(root)).toHaveLength(1);
	const again = expectOk(await library.deletionFor(entry.path));
	expect(await library.remove(again)).toBeUndefined();
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
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
	expect(await library.remove(deletion)).toBeUndefined();
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${entry.stem}.wav`,
	]);
	expect(await transcripts(root)).toHaveLength(1);
});

// ============================================================================
// Files
// ============================================================================

test('renaming an open text file runs after its writes and moves what they saved; the selection follows', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await settle(library);
	expect(await library.open('notes.md')).toBeUndefined();
	(await openText(library, 'notes.md')).input('typed\n');

	expect(await library.rename('notes.md', 'renamed.md')).toBeUndefined();

	expect(library.selectedPath).toBe('renamed.md');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('typed\n');
	(await openText(library, 'renamed.md')).input('typed again\n');
	await settle(library);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'typed again\n',
	);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});

test('recording and transformation files keep their names, and a transcript keeps its extension', async () => {
	const { library } = await open();
	await record(library);
	const entry = library.entries[0]!;
	expect(await library.rename(entry.path, 'other.md')).toContain(
		'Change the title instead',
	);
	await library.transcribe(entry);
	const result = library.resultsFor(entry.stem)[0]!;
	expect(await library.rename(result.path, 'plain.txt')).toContain(
		'keeps its .md extension',
	);
	expect(await library.rename(result.path, 'renamed.md')).toBeUndefined();
	expect(
		library.rowAt('transcriptions', 'transcriptions/renamed.md'),
	).toBeDefined();
	expect(library.resultsFor(entry.stem).map((item) => item.path)).toEqual([
		'transcriptions/renamed.md',
	]);
});

// ============================================================================
// Closing
// ============================================================================

test('close drains accepted commands and refuses a new command', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeFileCreate: async () => {
			reached.resolve();
			await release.promise;
		},
	});
	const first = library.createFile('', 'first.txt');
	await reached.promise;
	let closed = false;
	const closing = library.close().then(() => {
		closed = true;
	});
	expect(await library.createFile('', 'late.txt')).toContain('closing');
	await Bun.sleep(10);
	expect(closed).toBe(false);
	release.resolve();
	expect(await first).toBeUndefined();
	await closing;
	opened.splice(opened.indexOf(library), 1);
	expect(await readFile(join(root, 'first.txt'), 'utf8')).toBe('');
});

test('close waits for a rename whose read is still held, and the rename finishes before the folder closes', async () => {
	const reached = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const { library, root } = await open({
		beforeFileRead: async (path) => {
			if (path !== 'notes.md') return;
			reached.resolve();
			await release.promise;
		},
	});
	await writeFile(join(root, 'notes.md'), 'original\n');
	await settle(library);

	const renaming = library.rename('notes.md', 'renamed.md');
	await reached.promise;
	let closed = false;
	const closing = library.close().then(() => {
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
