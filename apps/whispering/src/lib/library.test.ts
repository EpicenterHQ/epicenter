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
 * - A transcription result is its own row naming the recording
 * - A received transcript has one file name: saving it again never calls the
 *   endpoint, recognizes a save that landed with its reply lost, leaves
 *   another file at that name alone, and cannot write a second result
 * - A held transcript refuses a new request, and a save that finishes late
 *   restores nothing that was discarded and replaces nothing newer
 * - Renaming a file moves its open draft; recording and transformation files
 *   keep their names
 * - Leaving and closing wait for admitted commands
 */
import './svelte-modules.test-support.js';
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
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { loadAudio } from './audio-source.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { describeDeletion } from './deletion.js';
import type { Library } from './library.svelte.js';
import {
	commitLine,
	filesLineOf,
	summaryLine,
	uncommittedLine,
} from './status.js';
import type { Workspace } from './workspace/types.js';
import {
	openTestFolder,
	TEST_BASE_URL,
	testConnections,
	testInjection,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const opened: Library[] = [];
const roots: string[] = [];

type Options = {
	/** Fail this many recording row writes after the audio lands. */
	failRowWrites?: number;
	/** Fail this many transcription result row writes. */
	failResultWrites?: number;
	/** Report this many transcription result row writes as unconfirmed after the file landed. */
	loseResultReplies?: number;
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
	failResultWrites = 0,
	loseResultReplies = 0,
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
	const failures = { resultWrites: failResultWrites };
	let remainingLostReplies = loseResultReplies;
	const transcriptions = folder.tables.transcriptions;
	const tables = {
		...folder.tables,
		transcriptions: {
			...transcriptions,
			create: async (
				...args: Parameters<typeof transcriptions.create>
			): ReturnType<typeof transcriptions.create> => {
				if (failures.resultWrites > 0) {
					failures.resultWrites -= 1;
					return FileError.Io({
						path: 'transcriptions/result.md',
						operation: 'create',
						cause: new Error('disk refused the result'),
					});
				}
				const created = await transcriptions.create(...args);
				const { data: row, error: createError } = created;
				if (remainingLostReplies === 0 || createError !== null) return created;
				remainingLostReplies -= 1;
				return FileError.Unconfirmed({
					path: row.path,
					operation: 'create',
					cause: 'reply lost after the write',
				});
			},
		},
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
		location: directory,
		terminal: {
			cwd: '/',
			exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		},
		terminalNote: 'test',
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
		connections: device.member,
		preferences: {
			microphone: async () => undefined,
			setMicrophone: async () => undefined,
		},
		window: undefined,
		debugControls: true,
		// A debug shell's injection: the row write fails after the audio landed.
		injection: testInjection(directory, { audio: 0, row: failRowWrites }),
		close: () => folder.close(),
	};
	const library = createLibrary(workspace);
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
	const files = filesLineOf(library);
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

test('the first launch creates no files or history, and saving a connection writes nothing to the folder', async () => {
	const { library, root, device } = await open({
		connections: { connections: {} },
	});
	expect(await readdir(root)).not.toContain('kv.json');
	expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
	expect(await Bun.file(join(root, '.git/refs/heads/main')).exists()).toBe(
		false,
	);
	// The folder publishes its definition beside the data; nothing else is there.
	expect(git(root, 'status', '--porcelain').trim()).toBe('?? epicenter.json');
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
	expect(await readdir(root)).not.toContain('kv.json');
	expect(git(root, 'status', '--porcelain').trim()).toBe('?? epicenter.json');
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
	await library.refreshAll();
	expect(library.settingsProblem).toContain('transcriptionModel');
	expect(library.legacySettings).toEqual({
		transcriptionBaseUrl: 'http://kept',
	});

	await writeFile(join(root, 'kv.json'), '{"transcriptionModel": "kept"}\n');
	await library.refreshAll();
	expect(library.settingsProblem).toBeUndefined();
	expect(library.legacySettings).toEqual({ transcriptionModel: 'kept' });
});

// ============================================================================
// Recording
// ============================================================================

test('record, stop, and save leave a row, real audio, and a commit, and the recording opens', async () => {
	const { library, root } = await open();

	await record(library);

	expect(library.pending).toHaveLength(0);
	expect(library.entries).toHaveLength(1);
	const entry = library.entries[0]!;
	const { fields } = entry.row;
	expect(fields.capture).toBe('fixture');
	expect(fields.durationMs).toBe(1000);
	expect(fields.audioPath).toBe(`recordings/${entry.stem}.wav`);
	expect(library.selectedPath).toBe(entry.path);
	expect(library.selection?.draft.kind).toBe('row');
	expect(new Uint8Array(await readFile(join(root, fields.audioPath)))).toEqual(
		new Uint8Array(toneWav()),
	);

	const outcome = await library.commit();
	expect(['committed', 'unchanged']).toContain(outcome.status);
	const tree = git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
	expect(tree).toContain(entry.path);
	expect(tree).toContain(fields.audioPath);
	expect(tree).not.toContain('kv.json');
});

test('a row write that fails after the audio landed keeps the capture and its id, and an explicit retry makes one recording', async () => {
	const { library, root } = await open({ failRowWrites: 1 });

	await record(library);

	expect(library.entries).toHaveLength(0);
	expect(library.pending).toHaveLength(1);
	const pending = library.pending[0]!;
	expect(pending.state).toMatchObject({
		kind: 'rowNotSaved',
		certainty: 'failed',
		audio: { by: 'receipt', file: { path: pending.capture.fields.audioPath } },
	});
	expect(pending.capture.bytes).toEqual(toneWav());
	expect(library.holdsUnsavedWork).toBe(true);
	expect(status(library).files.label).toBe('1 recording not saved');
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.capture.id}.wav`,
	]);

	await library.retryPending(pending.capture.id);

	expect(library.pending).toHaveLength(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(library.entries.map((entry) => entry.stem)).toEqual([
		pending.capture.id,
	]);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.capture.id}.md`,
		`${pending.capture.id}.wav`,
	]);
});

test('a row written before audioPath does not read: it is named for repair, and no same-stem file is used', async () => {
	const { library, root, transcribed } = await open();
	await mkdir(join(root, 'recordings'), { recursive: true });
	const old =
		'---\ntitle: Old take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\n---\nNotes\n';
	await writeFile(join(root, 'recordings', 'old.md'), old);
	await writeFile(join(root, 'recordings', 'old.wav'), toneWav());
	await library.refreshAll();

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
	const draft = library.selection?.draft;
	if (draft?.kind !== 'text')
		throw new Error(`Expected text, got ${draft?.kind}`);
	expect(draft.session.draft).toBe(old);
	draft.session.input(
		old.replace(
			'capture: fixture\n',
			'capture: fixture\naudioPath: recordings/old.wav\n',
		),
	);
	expect((await draft.session.settled()).status).toBe('saved');
	expect(await library.useForm('recordings/old.md')).toBeUndefined();
	await library.refresh();
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
	await library.refreshAll();
	expect(library.generation).toBeGreaterThan(before);
	expect(expectOk(await loadAudio(library.folder.files, path, first))).toBe(
		first,
	);

	const replaced = new Uint8Array(toneWav({ frequency: 880 }));
	expect(replaced.length).toBe(toneWav().length);
	await writeFile(join(root, path), replaced);
	await library.refreshAll();

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
	await library.commit();
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

test('a transcription transport that throws ends as a failure that can be retried', async () => {
	let attempts = 0;
	const { library } = await open({
		transcribe: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'second try' });
		},
	});
	await record(library);
	const entry = library.entries[0]!;

	await library.transcribe(entry);

	expect(library.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});
	expect(library.resultsFor(entry.stem)).toHaveLength(0);

	await library.transcribe(entry);

	expect(attempts).toBe(2);
	expect(library.transcriptionRun(entry.stem)).toBeUndefined();
	expect(library.resultsFor(entry.stem)[0]!.row.body).toBe('second try\n');
});

const transcripts = (root: string) =>
	readdir(join(root, 'transcriptions')).catch(() => [] as string[]);

/** The transcript held for a recording. */
function heldTranscript(library: Library, recording: string) {
	const run = library.transcriptionRun(recording);
	if (run?.kind !== 'unsaved')
		throw new Error(`Expected a held transcript, got ${run?.kind}`);
	return run;
}

/** Record and transcribe once, with the answer received and its row not confirmed. */
async function held(options: Options) {
	const result = await open(options);
	await record(result.library);
	const entry = result.library.entries[0]!;
	await result.library.transcribe(entry);
	return {
		...result,
		entry,
		id: entry.stem,
		held: heldTranscript(result.library, entry.stem),
	};
}

/**
 * Hold the next transcription row write until the test releases it. The write
 * then goes to the folder, or is refused before anything is written.
 */
function holdNextResultWrite(library: Library) {
	const table = library.folder.tables.transcriptions;
	const create = table.create;
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<'write' | 'refuse'>();
	Object.assign(table, {
		create: async (...args: Parameters<typeof create>) => {
			Object.assign(table, { create });
			started.resolve();
			return (await release.promise) === 'write'
				? create(...args)
				: FileError.Io({
						path: `transcriptions/${args[1]?.stem}.md`,
						operation: 'create',
						cause: new Error('disk refused the result late'),
					});
		},
	});
	return { started: started.promise, release: release.resolve };
}

test('a transcript whose file was not saved is reported as unsaved until it is', async () => {
	const { library, root } = await open({ failResultWrites: 1 });
	await record(library);
	await library.commit();
	await library.refreshAll();
	const entry = library.entries[0]!;
	expect(status(library).files.tone).toBe('good');

	await library.transcribe(entry);

	expect(heldTranscript(library, entry.stem).text).toBe('a steady tone');
	expect(library.unsavedResults).toBe(1);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(status(library).files.label).toBe('1 transcription not saved');
	expect(await transcripts(root)).toEqual([]);

	await library.retrySaveResult(entry.stem);

	expect(library.unsavedResults).toBe(0);
	expect(status(library).files.tone).toBe('good');
	expect(library.resultsFor(entry.stem)[0]!.row.body).toBe('a steady tone\n');
	expect(await transcripts(root)).toHaveLength(1);
});

test('a transcript save that landed with its reply lost is recognized on saving again: one file, one request', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ loseResultReplies: 1 });
	expect(await transcripts(root)).toHaveLength(1);
	expect(first.message).toContain('may or may not have happened');
	expect(library.holdsUnsavedWork).toBe(true);

	await library.retrySaveResult(id);

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	const results = library.resultsFor(id);
	expect(results.map((result) => result.stem)).toEqual([first.id]);
	expect(results[0]!.row).toEqual(first.row);
});

test('two simultaneous saves of a held transcript write one file and leave nothing unsaved', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });
	expect(await transcripts(root)).toEqual([]);

	await Promise.all([library.retrySaveResult(id), library.retrySaveResult(id)]);

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
});

test('another file at a held transcript’s path is left as it is, and the transcript stays held', async () => {
	const {
		library,
		root,
		transcribed,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });
	const path = join(root, 'transcriptions', `${first.id}.md`);
	await mkdir(join(root, 'transcriptions'), { recursive: true });
	const squatter =
		'---\ntitle: not a transcript\n---\nSomeone else wrote this\n';
	await writeFile(path, squatter);

	await library.retrySaveResult(id);

	expect(await readFile(path, 'utf8')).toBe(squatter);
	const still = heldTranscript(library, id);
	expect(still).toMatchObject({ id: first.id, text: 'a steady tone' });
	expect(still.message).toContain('Nothing was overwritten');
	expect(library.holdsUnsavedWork).toBe(true);

	// The same fields with other text is another row too, not this transcript.
	await rm(path);
	expectOk(
		await library.folder.tables.transcriptions.create(
			{ fields: first.row.fields, body: 'a steady tone, edited since\n' },
			{ stem: first.id },
		),
	);
	const theirs = await readFile(path, 'utf8');

	await library.retrySaveResult(id);

	expect(await readFile(path, 'utf8')).toBe(theirs);
	expect(heldTranscript(library, id).text).toBe('a steady tone');
	expect(transcribed).toHaveLength(1);
});

test('a held transcript refuses a new transcription request: the endpoint is not called and the text is kept', async () => {
	const {
		library,
		transcribed,
		entry,
		id,
		held: first,
	} = await held({ failResultWrites: 1 });

	await library.transcribe(entry);

	expect(transcribed).toHaveLength(1);
	expect(library.transcriptionRun(id)).toEqual(first);
});

test('a save that fails after its transcript was discarded does not bring the transcript back', async () => {
	const { library, root, id } = await held({ failResultWrites: 1 });
	const write = holdNextResultWrite(library);
	const saving = library.retrySaveResult(id);
	await write.started;
	expect(heldTranscript(library, id).saving).toBe(true);

	library.dismissRun(id);
	write.release('refuse');
	await saving;

	expect(library.transcriptionRun(id)).toBeUndefined();
	expect(library.holdsUnsavedWork).toBe(false);
	expect(await transcripts(root)).toEqual([]);
});

test('a save that lands after its transcript was discarded leaves a newer held transcript as it is', async () => {
	let answers = 0;
	const {
		library,
		root,
		failures,
		entry,
		id,
		held: first,
	} = await held({
		failResultWrites: 1,
		transcribe: async () => {
			answers += 1;
			return Ok({ text: answers === 1 ? 'first answer' : 'second answer' });
		},
	});
	const write = holdNextResultWrite(library);
	const saving = library.retrySaveResult(id);
	await write.started;
	library.dismissRun(id);
	failures.resultWrites = 1;
	await library.transcribe(entry);
	const second = heldTranscript(library, id);
	expect(second.text).toBe('second answer');

	write.release('write');
	await saving;

	expect(await transcripts(root)).toEqual([`${first.id}.md`]);
	expect(library.transcriptionRun(id)).toEqual(second);
});

test('the first write of a transcript keeps its run running: it cannot be dismissed, asked for again, or deleted under', async () => {
	const { library, root, transcribed } = await open();
	await record(library);
	const entry = library.entries[0]!;
	const id = entry.stem;
	const write = holdNextResultWrite(library);
	const transcribing = library.transcribe(entry);
	await write.started;

	expect(library.transcriptionRun(id)?.kind).toBe('running');
	library.dismissRun(id);
	await library.transcribe(entry);
	expect(library.transcriptionRun(id)?.kind).toBe('running');
	expect((await library.deletionFor(entry.path)).error).toContain(
		'still running',
	);
	expect(library.holdsUnsavedWork).toBe(true);

	write.release('refuse');
	await transcribing;

	const kept = heldTranscript(library, id);
	expect(transcribed).toHaveLength(1);
	await library.retrySaveResult(id);
	expect(await transcripts(root)).toEqual([`${kept.id}.md`]);
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

test('a recording cannot be deleted while a received transcript is unsaved; discarding it allows the deletion', async () => {
	const { library, entry } = await held({ failResultWrites: 1 });

	expect((await library.deletionFor(entry.path)).error).toContain(
		'Save it again or discard it',
	);

	library.dismissRun(entry.stem);
	const deletion = expectOk(await library.deletionFor(entry.path));
	expect(await library.remove(deletion)).toBeUndefined();
	expect(library.entries).toEqual([]);
});

test('a recording file that does not read is deleted alone, as the bytes it holds, and its results are kept', async () => {
	const { library, root } = await open();
	await record(library);
	const entry = library.entries[0]!;
	await library.transcribe(entry);
	await writeFile(join(root, entry.path), new Uint8Array([0xff, 0xfe, 0x00]));
	await library.refresh();
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

test('renaming an open text file waits for its saves and moves it with its draft', async () => {
	const { library, root } = await open();
	await writeFile(join(root, 'notes.md'), 'original\n');
	await library.refreshAll();
	expect(await library.open('notes.md')).toBeUndefined();
	const draft = library.selection?.draft;
	if (draft?.kind !== 'text')
		throw new Error(`Expected text, got ${draft?.kind}`);
	draft.session.input('typed\n');

	expect(await library.rename('notes.md', 'renamed.md')).toBeUndefined();

	expect(library.selectedPath).toBe('renamed.md');
	expect(library.selection?.draft).toBe(draft);
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('typed\n');
	draft.session.input('typed again\n');
	await draft.session.settled();
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
	await library.openTranscript(result.path);
	expect(await library.rename(result.path, 'plain.txt')).toContain(
		'keeps its .md extension',
	);
	expect(await library.rename(result.path, 'renamed.md')).toBeUndefined();
	expect(library.draftAt('transcriptions/renamed.md')?.kind).toBe('row');
	expect(library.resultsFor(entry.stem).map((item) => item.path)).toEqual([
		'transcriptions/renamed.md',
	]);
});

// ============================================================================
// Leaving and closing
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
	await library.refreshAll();

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
