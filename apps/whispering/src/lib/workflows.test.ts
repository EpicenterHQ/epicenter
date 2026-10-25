/**
 * Whispering workflow tests
 *
 * Drives the real product state against a real directory, opened as the
 * folder mirror with Whispering's tables, with a fixture capture device and
 * a stubbed transcription answer. A test that holds or refuses a save opens
 * the folder over memory instead, whose storage does that below the folder.
 * No window, shell, or microphone is involved, so these establish the
 * workflow's logic and what it leaves on disk, not that the desktop app runs.
 *
 * Key behaviors:
 * - A first launch creates no files, and saving a connection writes nothing
 *   to the folder
 * - Record and stop leave same-stem Markdown and audio with its exact
 *   bytes; reopening reads both, and a recording being captured or just
 *   stopped never reads as absent
 * - Files supplied in an ordinary directory read as they are: rows,
 *   transcripts, results, and audio, with every field kept through edits
 * - Captured audio survives a row write that fails at start
 * - Only same-stem siblings resolve as audio; unrelated metadata never redirects
 *   playback or transcription, and malformed rows are repaired as text
 * - Deleting a recording deletes its row and its results and keeps its audio.
 *   It is refused while work for it runs or a result cannot say whose it is
 * - A transcription result is its own row naming the recording, written with
 *   an empty body before the request goes out and filled when the answer
 *   arrives (ADR-0542)
 * - A row with no body and no request in this window is unfinished; running
 *   it again fills the same row, and deleting it discards it; after a reload
 *   a row whose answer was not written is unfinished
 * - Renaming copies the file as the folder shows it, refuses while a save
 *   runs, and keeps both files when the original changes during the copy;
 *   recording and transformation files keep their names
 * - Stop waits for its own initial row save across overlapping captures
 * - Closing refuses new work and selection without draining workflows; the
 *   writes already asked for still land
 */
import {
	closeTestWhispering,
	headerLine,
	openTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Folder } from '@epicenter/folder/next';
import { pathProblem } from '@epicenter/folder/file-browser';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { audioMimeTypeOf } from './audio-format.js';
import { createFixtureDevice, toneWav } from './capture.js';
import { recordingAudioStem, type WhisperingTables } from './definition.js';
import { describeDeletion } from './deletion.js';
import { readBytes } from './files.js';
import type { WhisperingFolder } from './folder.js';
import { createMicrophoneDevice } from './microphone.js';
import type { WhisperingServices } from './platform/types.js';
import {
	deferred,
	eventually,
	openMemoryTestFolder,
	openTestFolder,
	settled,
	TEST_BASE_URL,
	testConnections,
	whisperingDirectory,
} from './services.test-support.js';
import type { Whispering } from './whispering.svelte.js';

/** The recording rows and their sibling audio, sorted. */
const recordingFiles = async (root: string) =>
	(await readdir(join(root, 'recordings')).catch(() => [] as string[])).sort();

const { recordingId } = await import('./whispering.svelte.js');

type Fixture = {
	whispering: Whispering;
	folder: WhisperingFolder;
	opened: Folder<WhisperingTables>;
};
const fixtures: Fixture[] = [];
const roots: string[] = [];

type Answer = Awaited<ReturnType<WhisperingServices['transcribe']>>;

type Options = {
	/** Replace the stubbed transcription answer. */
	transcribe?: WhisperingServices['transcribe'];
	/** Open this directory again. */
	root?: string;
	/** Over memory, whose storage a test can hold or make refuse. */
	memory?: boolean;
	/** Record as the desktop does: the audio is written by the shell, not through the folder. */
	nativeCapture?: boolean;
	/** What the device has set up. Both connections, keyless, unless a test says otherwise. */
	connections?: Parameters<typeof testConnections>[0];
};

async function open({
	transcribe,
	root,
	memory = false,
	nativeCapture = false,
	connections,
}: Options = {}) {
	const directory =
		root ?? (await whisperingDirectory('whispering-whispering-'));
	if (root === undefined) roots.push(directory);
	const inMemory = memory ? await openMemoryTestFolder() : undefined;
	const { folder, opened } = inMemory ?? (await openTestFolder(directory));
	const transcribed: Parameters<WhisperingServices['transcribe']>[0][] = [];
	const device = testConnections(connections);
	const services: WhisperingServices = {
		kind: 'native',
		location: directory,
		capture: nativeCapture
			? createMicrophoneDevice({
					inputs: {
						list: async () => Ok({ devices: [] }),
						meter: async () => {
							throw new Error('No microphone test is requested');
						},
						onChange: () => () => {},
					},
					record: async ({ path }) =>
						Ok({
							path: `${path}.wav`,
							device: 'Test microphone',
							startedAt: Date.now(),
							onLevel: () => () => {},
							onEnded: () => () => {},
							stop: async () => Ok({ path: `${path}.wav`, durationMs: 1000 }),
						}),
				})
			: createFixtureDevice({
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
	};
	const { whispering } = await openTestWhispering({ services, folder });
	fixtures.push({ whispering, folder, opened });
	return {
		whispering,
		folder,
		opened,
		root: directory,
		host: inMemory?.host,
		transcribed,
		device,
	};
}

/** Stop the app, then close its folder as `<OpenFolder>` does once it unmounts. */
async function close(whispering: Whispering) {
	const index = fixtures.findIndex(
		(fixture) => fixture.whispering === whispering,
	);
	const [fixture] = fixtures.splice(index, 1);
	if (fixture === undefined) return;
	closeTestWhispering(fixture);
	await fixture.opened.close();
}

afterEach(async () => {
	for (const fixture of [...fixtures]) await close(fixture.whispering);
	for (const root of roots.splice(0))
		await rm(dirname(root), { recursive: true, force: true });
});

async function record(whispering: Whispering, folder: WhisperingFolder) {
	await whispering.startRecording();
	expect(whispering.recorder.phase).toBe('recording');
	await whispering.stopRecording();
	await settled(folder);
}

/** Close `whispering` in the test, so the next opening reads what it left. */
async function reopen(whispering: Whispering, root: string) {
	await close(whispering);
	return open({ root });
}

/** A recording row as another program might write it. */
const recordingText = (title: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-01-02T03:04:05.000Z\ncapture: microphone\n---\n`;

/** Make storage refuse every save under `prefix` from now on. */
function refuseUnder(
	host: NonNullable<Awaited<ReturnType<typeof open>>['host']>,
	prefix: string,
	only: (path: string) => boolean = () => true,
) {
	host.control.beforePut = (path) => {
		if (path.startsWith(prefix) && only(path))
			throw new Error('the disk refused it');
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
	const { folder, whispering, transcribed } = await open({
		connections: { connections: {} },
	});
	await record(whispering, folder);
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
	const { folder, whispering, root } = await open();

	await record(whispering, folder);

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

	const second = await reopen(whispering, root);

	expect(second.whispering.entries.map((item) => item.row.fields)).toEqual([
		fields,
	]);
	// The audio is listed, not kept; the player reads its bytes, typed as the
	// container they are.
	expect(second.folder.file(audioPath)).toMatchObject({
		data: undefined,
		readError: null,
	});
	expect(expectOk(await readBytes(second.folder, audioPath))).toEqual(
		toneWav(),
	);
	expect(audioMimeTypeOf(audioPath)).toBe('audio/wav');
});

test('a recording being captured, and once it stops, has its audio here, never absent', async () => {
	const { folder, whispering } = await open();

	await whispering.startRecording();
	// The fixture's audio is written when it stops, so until then the
	// listing lacks it.
	await settled(folder);
	const [entry] = whispering.entries;
	expect(whispering.audioOf(entry!).kind).toBe('here');

	await whispering.stopRecording();
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
	await settled(folder);
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
});

test('just-stopped audio the shell writes is here before the folder lists it, and the listing decides once it does', async () => {
	const { folder, whispering, root } = await open({ nativeCapture: true });
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');
	// Nothing listed it yet: it plays from where the capture wrote it.
	expect(folder.file(audioPath)).toBeUndefined();
	expect(whispering.audioOf(entry)).toEqual({ kind: 'here', path: audioPath });

	// The shell's file arrives, and the folder lists it.
	await writeFile(join(root, audioPath), toneWav());
	folder.checkpoint();
	await eventually(() => folder.file(audioPath) !== undefined);
	expect(whispering.audioOf(entry)).toEqual({ kind: 'here', path: audioPath });

	// From then on the listing decides: once it is gone, it is absent.
	expectOk(await folder.delete(audioPath));
	expect(whispering.audioOf(entry).kind).toBe('absent');
});

test('a recording’s row is written when it starts, naming its audio, and gets its length when it stops', async () => {
	const { folder, whispering, root } = await open();

	await whispering.startRecording();

	expect(whispering.recorder.phase).toBe('recording');
	await settled(folder);
	const [entry] = whispering.entries;
	expect(entry?.row.fields).toMatchObject({
		capture: 'fixture',
	});
	expect(entry?.row.fields.durationMs).toBeUndefined();

	await whispering.stopRecording();
	await settled(folder);

	expect(
		whispering.entries.map((stored) => stored.row.fields.durationMs),
	).toEqual([1000]);
	expect(await recordingFiles(root)).toEqual([
		`${entry?.stem}.md`,
		`${entry?.stem}.wav`,
	]);
});

test('Stop pressed while the row’s first save runs writes the length once the row is there', async () => {
	const { folder, host, whispering } = await open({ memory: true });
	const release = deferred<void>();
	host!.control.putGate = release.promise;

	const starting = whispering.startRecording();
	await eventually(() => whispering.recorder.phase === 'recording');
	const stopping = whispering.stopRecording();
	await Bun.sleep(10);
	host!.control.putGate = undefined;
	release.resolve();
	await Promise.all([starting, stopping]);
	await settled(folder);

	expect(whispering.recorderError).toBeUndefined();
	const [entry] = whispering.entries;
	expect(entry?.row.fields.durationMs).toBe(1000);
	expect(host!.text(entry!.path)).toContain('durationMs: 1000');
});

test('each capture’s Stop waits for its own row while a second capture starts', async () => {
	// The shell writes the audio, so Stop frees the microphone while the row waits.
	const { folder, host, whispering } = await open({
		memory: true,
		nativeCapture: true,
	});
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const firstStart = whispering.startRecording();
	await eventually(() => whispering.recorder.phase === 'recording');
	const finishing = whispering.stopRecording();
	let secondStart: Promise<void> | undefined;
	try {
		await eventually(() => whispering.recorder.phase === 'idle');
		secondStart = whispering.startRecording();
		await eventually(() => whispering.recorder.phase === 'recording');
	} finally {
		host!.control.putGate = undefined;
		release.resolve();
		await Promise.all([firstStart, secondStart, finishing]);
	}
	expect(whispering.recorder.phase).toBe('recording');
	await whispering.stopRecording();
	await settled(folder);
	expect(whispering.entries).toHaveLength(2);
	for (const entry of whispering.entries)
		expect(entry.row.fields.durationMs).toBe(1000);
	expect(whispering.recorderError).toBeUndefined();
});

test('a recording still recording is not transcribed', async () => {
	const { folder, whispering, transcribed } = await open();

	await whispering.startRecording();
	await settled(folder);
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
	const { folder, host, whispering } = await open({ memory: true });
	refuseUnder(host!, 'recordings/', (path) => path.endsWith('.md'));

	await whispering.startRecording();

	expect(whispering.recorder.phase).toBe('recording');
	expect(whispering.recorderError).toContain('its file could not be written');
	expect(whispering.entries).toEqual([]);

	await whispering.stopRecording();

	const files = folder.files.filter((file) =>
		file.path.startsWith('recordings/'),
	);
	expect(files).toHaveLength(1);
	expect(files[0]!.path).toEndWith('.wav');
	expect(expectOk(await folder.read(files[0]!.path))).toEqual(toneWav());
});

test('files in an ordinary directory read as they are, and a field the app does not know survives an edit', async () => {
	const root = await whisperingDirectory('whispering-files-');
	roots.push(root);
	const recording =
		'---\ntitle: Kept take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: microphone\nmood: calm\n---\nMy notes\n';
	await Bun.write(join(root, 'recordings', 'kept.md'), recording);
	await Bun.write(join(root, 'recordings', 'kept.wav'), toneWav());
	await Bun.write(
		join(root, 'transcriptions', 'kept-t.md'),
		'---\nrecordingId: kept\ncreatedAt: 2026-01-02T03:05:00.000Z\nmodel: whisper-1\nendpoint: https://api.openai.com/v1\n---\nhello there\n',
	);
	// An unrelated file beside the documents stays as it is.
	await writeFile(join(root, 'epicenter.json'), '{"title":"Whispering"}\n');

	const { folder, whispering } = await open({ root });

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
	expect(expectOk(await readBytes(folder, 'recordings/kept.wav'))).toEqual(
		toneWav(),
	);

	// Editing the notes keeps the field this version does not know.
	expectOk(
		await folder.tables.recordings.update('kept', {
			body: 'My notes, edited\n',
		}),
	);
	const saved = await readFile(join(root, 'recordings', 'kept.md'), 'utf8');
	expect(saved).toContain('mood: calm');
	expect(saved).toContain('My notes, edited');
	expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
		'{"title":"Whispering"}\n',
	);
});

test('a field another program added survives every edit of the row', async () => {
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	await writeFile(
		join(root, entry.path),
		recordingText('Theirs').replace('---\n', '---\nspeaker: Ada\n'),
	);
	folder.checkpoint();
	await eventually(() => whispering.entries[0]?.row.fields.title === 'Theirs');

	expectOk(
		await folder.tables.recordings.update(entry.stem, {
			fields: { title: 'Mine' },
		}),
	);
	expectOk(
		await folder.tables.recordings.update(entry.stem, { body: 'Notes.\n' }),
	);

	const written = await readFile(join(root, entry.path), 'utf8');
	expect(written).toContain('speaker: Ada');
	expect(written).toContain('title: Mine');
	expect(written).toEndWith('Notes.\n');
});

test('a row that is not valid is named for repair, is written as typed text, and reads as fields once repaired', async () => {
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
	const { path, stem } = whispering.entries[0]!;
	const broken = '---\ntitle: Broken\n---\n';
	expectOk(await folder.write(path, broken));

	expect(whispering.repairs.map((item) => item.path)).toEqual([path]);
	expect(whispering.showsText(path)).toBe(true);
	expect(folder.file(path)?.data).toBe(broken);
	expect(whispering.useForm(path, broken)).toContain('does not read');

	// Source saves the whole text as typed.
	expectOk(await folder.write(path, recordingText('Repaired')));
	expect(await readFile(join(root, path), 'utf8')).toBe(
		recordingText('Repaired'),
	);
	expect(whispering.repairs).toEqual([]);
	expect(whispering.useForm(path, recordingText('Repaired'))).toBeUndefined();
	expect(whispering.showsText(path)).toBe(false);
	expect(folder.tables.recordings.row(stem)?.fields).toMatchObject({
		title: 'Repaired',
	});
});

test('frontmatter paths never redirect audio and opening never relocates files', async () => {
	const { folder, whispering, root, transcribed } = await open();
	const source =
		'---\ntitle: Take\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: audio/take.wav\n---\nNotes\n';
	expectOk(await folder.write('recordings/take.md', source));
	expectOk(await folder.write('audio/take.wav', toneWav()));
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

	expectOk(await folder.write('recordings/take.wav', toneWav()));
	await whispering.transcribe(entry);
	expect(whispering.audioOf(entry)).toEqual({
		kind: 'here',
		path: 'recordings/take.wav',
	});
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		'recordings/take.wav',
	]);
});

// ============================================================================
// Transcription
// ============================================================================

test('a transcription is saved as its own row naming the recording, and reopening keeps the recording, result, and exact audio', async () => {
	const { folder, whispering, root, transcribed } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');

	await whispering.transcribe(entry);
	await settled(folder);

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

	const second = await reopen(whispering, root);

	expect(second.whispering.entries.map((item) => item.path)).toEqual([
		entry.path,
	]);
	expect(second.whispering.resultsFor(entry.stem)[0]!.row.body).toBe(
		'a steady tone\n',
	);
	expect(expectOk(await readBytes(second.folder, audioPath))).toEqual(
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
	const answer = deferred<Answer>();
	const { folder, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;

	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);

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

	expect(newest(whispering, entry.stem).state.kind).toBe('answered');
	expect(
		whispering.resultsFor(entry.stem).map((item) => item.row.body),
	).toEqual(['arrived\n']);
	expect(await transcripts(root)).toEqual([`${transcript.stem}.md`]);
});

test('an answer sets the row body over the file as it is then, keeping its other fields', async () => {
	const answer = deferred<Answer>();
	const { folder, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const { transcript } = newest(whispering, entry.stem);

	// Another program adds a field while the request is out.
	const file = join(root, transcript.path);
	await writeFile(
		file,
		(await readFile(file, 'utf8')).replace(/^---\n/, '---\nlanguage: en\n'),
	);

	answer.resolve(Ok({ text: 'arrived' }));
	await transcribing;

	const saved = await readFile(file, 'utf8');
	expect(saved).toContain('language: en');
	expect(saved).toEndWith('arrived\n');
});

test('a transport that throws leaves the row unfinished; running it again sends the same request into the same row', async () => {
	let attempts = 0;
	const { folder, whispering, root, transcribed } = await open({
		transcribe: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'second try' });
		},
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;

	await whispering.transcribe(entry);

	const { transcript, state } = newest(whispering, entry.stem);
	expect(state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});
	expect(whispering.transcriptionRun(entry.stem)).toBeUndefined();
	expect(transcript.row.body).toBe('');

	expect(await whispering.runAgain(transcript.path)).toBeUndefined();

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
	const { folder, host, whispering, transcribed } = await open({
		memory: true,
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	refuseUnder(host!, 'transcriptions/');

	await whispering.transcribe(entry);

	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('Nothing was sent'),
	});
	expect(folder.tables.transcriptions.rows).toEqual([]);
});

test('after a reload, a row whose answer was never written is unfinished, and running it again fills it', async () => {
	const answer = deferred<Answer>();
	const first = await open({ transcribe: () => answer.promise });
	await record(first.whispering, first.folder);
	const entry = first.whispering.entries[0]!;
	const transcribing = first.whispering.transcribe(entry);
	await eventually(() => first.transcribed.length === 1);
	chmodSync(join(first.root, 'transcriptions'), 0o555);
	try {
		answer.resolve(Ok({ text: 'a steady tone' }));
		await transcribing;
	} finally {
		chmodSync(join(first.root, 'transcriptions'), 0o755);
	}
	expect(newest(first.whispering, entry.stem).state).toMatchObject({
		kind: 'writing',
		text: 'a steady tone',
		message: expect.any(String),
	});
	expect(headerLine(first.whispering).label).toBe('1 answer not written yet');

	const second = await reopen(first.whispering, first.root);

	const { transcript, state } = newest(second.whispering, entry.stem);
	expect(state.kind).toBe('unfinished');
	expect(transcript.row.body).toBe('');
	expect(second.whispering.unwrittenAnswers).toBe(0);

	expect(await second.whispering.runAgain(transcript.path)).toBeUndefined();

	expect(second.transcribed).toHaveLength(1);
	expect(
		second.whispering.resultsFor(entry.stem).map((item) => item.stem),
	).toEqual([transcript.stem]);
	expect(newest(second.whispering, entry.stem).state.kind).toBe('answered');
});

test('a running transcription cannot be asked for again; deleting its row discards it, and its answer writes nothing', async () => {
	const answer = deferred<Answer>();
	const { folder, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
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
	await settled(folder);

	expect(await transcripts(root)).toEqual([]);
	expect(whispering.resultsFor(entry.stem)).toEqual([]);
	expect(whispering.unwrittenAnswers).toBe(0);
});

// ============================================================================
// Deleting a recording
// ============================================================================

test('deleting a recording removes its row and results, keeps its audio, and says so first', async () => {
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const audioPath = entry.path.replace(/\.md$/, '.wav');
	await whispering.transcribe(entry);

	const deletion = expectOk(await whispering.deletionFor(entry.path));
	// What the person is asked matches what the deletion does.
	const asked = describeDeletion(deletion).description;
	expect(asked).toContain(
		`This deletes ${entry.path}, 1 result from the folder.`,
	);
	expect(asked).toContain(`Its audio ${audioPath} is not deleted`);
	expect(asked).not.toMatch(/version|history/i);
	expect(await whispering.delete(deletion)).toBeUndefined();

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
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
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

	expect(await recordingFiles(root)).toEqual([`${entry.stem}.md`]);
	expect(whispering.entries[0]!.path.replace(/\.md$/, '.wav')).toBe(audioPath);
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('absent');
	expect(expectErr(await readBytes(folder, audioPath))).toContain(
		'No file exists',
	);
});

test.each([
	'notes.txt',
	'text_runs/result.md',
	'transformation_runs/result.md',
])(
	'%s is deleted as it holds when deletion runs, whatever changed since confirmation',
	async (path) => {
		const { folder, whispering, root } = await open();
		expectOk(await folder.write(path, 'first\n'));
		const deletion = expectOk(await whispering.deletionFor(path));
		expect(deletion).toMatchObject({ kind: 'file', path });
		const description = describeDeletion(deletion).description;
		expect(description).toContain(`This deletes ${path} from the folder.`);
		expect(
			description.includes('The transcript it was made from is not changed.'),
		).toBe(path.startsWith('transformation_runs/'));
		expect(description).not.toContain('Git history');

		await writeFile(join(root, path), 'changed elsewhere\n');
		expect(await whispering.delete(deletion)).toBeUndefined();
		expect(await Bun.file(join(root, path)).exists()).toBe(false);
	},
);

test('a recording is not deleted while a result cannot say which recording it belongs to', async () => {
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	await whispering.transcribe(entry);

	expectOk(
		await folder.write(
			'transcriptions/unparsed.md',
			`---\nrecordingId: ${entry.stem}\nmodel: [open\n---\ntext\n`,
		),
	);
	const { error: refusal } = await whispering.deletionFor(entry.path);
	expect(refusal).toContain('cannot be told apart');
	expect(refusal).toContain('transcriptions/unparsed.md');

	// A deletion confirmed before such a file appeared is refused when it runs.
	expectOk(await folder.delete('transcriptions/unparsed.md'));
	const confirmed = expectOk(await whispering.deletionFor(entry.path));
	expectOk(await folder.write('transformation_runs/odd.md', 'no fence\n'));
	expect(await whispering.delete(confirmed)).toContain('cannot be told apart');
	expect(await recordingFiles(root)).toHaveLength(2);

	expectOk(await folder.delete('transformation_runs/odd.md'));
	expect(await whispering.delete(confirmed)).toBeUndefined();
	expect(whispering.entries).toEqual([]);
});

test('a recording cannot be deleted while its transcription runs, including one started after confirming', async () => {
	const answer = deferred<Answer>();
	const { folder, whispering, root, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	const confirmed = expectOk(await whispering.deletionFor(entry.path));

	const transcribing = whispering.transcribe(entry);
	expect((await whispering.deletionFor(entry.path)).error).toContain(
		'still running',
	);
	expect(await whispering.delete(confirmed)).toContain('still running');

	await eventually(() => transcribed.length === 1);
	answer.resolve(Ok({ text: 'arrived late' }));
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
	const { folder, whispering, root } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	await whispering.transcribe(entry);
	expectOk(await folder.write(entry.path, new Uint8Array([0xff, 0xfe, 0x00])));
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

test('renaming a text file copies it as the folder shows it and moves the selection', async () => {
	const { folder, whispering, root } = await open();
	expectOk(await folder.write('notes.md', 'typed\n'));
	expect(whispering.open('notes.md')).toBe(true);

	expect(await whispering.rename('notes.md', 'renamed.md')).toBeUndefined();

	expect(whispering.selectedPath).toBe('renamed.md');
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe('typed\n');
	expectOk(await folder.write('renamed.md', 'typed again\n'));
	expect(await readFile(join(root, 'renamed.md'), 'utf8')).toBe(
		'typed again\n',
	);
	expect(await Bun.file(join(root, 'notes.md')).exists()).toBe(false);
});

test('a rename never replaces a file already at the new name', async () => {
	const { folder, whispering, root } = await open();
	expectOk(await folder.write('a.txt', 'a\n'));
	expectOk(await folder.write('b.txt', 'b\n'));

	expect(await whispering.rename('a.txt', 'b.txt')).toContain(
		'Another file already has this name',
	);
	expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a\n');
	expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b\n');
});

test('renaming audio no recording names moves its exact bytes', async () => {
	const { folder, whispering, root } = await open();
	expectOk(await folder.write('recordings/loose.wav', toneWav()));

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

test('renaming text copies its exact bytes, a byte order mark and line endings included', async () => {
	const { folder, whispering, root } = await open();
	const original = '﻿Unopened café\r\n';
	await writeFile(join(root, 'unopened.txt'), original);
	folder.checkpoint();
	await eventually(() => folder.file('unopened.txt') !== undefined);

	expect(await whispering.rename('unopened.txt', 'renamed.txt')).toBeUndefined();
	expect(await readFile(join(root, 'renamed.txt'))).toEqual(
		Buffer.from(original, 'utf8'),
	);
	expect(await Bun.file(join(root, 'unopened.txt')).exists()).toBe(false);
});

test('a rename is refused while a save runs, and nothing is copied', async () => {
	const { folder, host, whispering } = await open({ memory: true });
	expectOk(await folder.write('from.txt', 'Saved text'));
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const saving = folder.write('other.txt', 'Still saving');
	try {
		expect(folder.saving).toBe(true);
		expect(await whispering.rename('from.txt', 'to.txt')).toBe(
			'A save is still running. Rename again in a moment.',
		);
	} finally {
		host!.control.putGate = undefined;
		release.resolve();
	}
	expectOk(await saving);
	expect(folder.file('to.txt')).toBeUndefined();
	expect(folder.file('from.txt')?.data).toBe('Saved text');
});

test('a rename keeps both files when a write to the original arrives during the copy', async () => {
	const { folder, host, whispering } = await open({ memory: true });
	expectOk(await folder.write('from.txt', 'Copied text'));
	let typed: ReturnType<typeof folder.write> | undefined;
	host!.control.beforePut = (path) => {
		// The person types into the original while the copy is out.
		if (path === 'to.txt') typed = folder.write('from.txt', 'Newer text');
	};

	expect(await whispering.rename('from.txt', 'to.txt')).toContain(
		'Different text arrived',
	);
	expectOk(await typed!);
	expect(host!.text('to.txt')).toBe('Copied text');
	expect(host!.text('from.txt')).toBe('Newer text');
	expect(folder.file('from.txt')?.data).toBe('Newer text');
	expect(whispering.selectedPath).not.toBe('to.txt');
});

test('recording and transformation files keep their names, and a transcript keeps its extension', async () => {
	const { folder, whispering } = await open();
	await record(whispering, folder);
	const entry = whispering.entries[0]!;
	expect(await whispering.rename(entry.path, 'other.md')).toContain(
		'Change the title instead',
	);
	await whispering.transcribe(entry);
	const result = whispering.resultsFor(entry.stem)[0]!;
	expect(await whispering.rename(result.path, 'plain.txt')).toContain(
		'keeps its .md extension',
	);
	expect(await whispering.rename(result.path, 'renamed.md')).toBeUndefined();
	expect(typeof folder.file('transcriptions/renamed.md')?.data).toBe('string');
	expect(whispering.resultsFor(entry.stem).map((item) => item.path)).toEqual([
		'transcriptions/renamed.md',
	]);
});

// ============================================================================
// Closing
// ============================================================================

test.each(['saved', 'unknown'] as const)(
	'closing preserves a %s connection save outcome without installing its late reply',
	async (outcome) => {
		const { whispering, folder, root } = await open();
		const connectionsBefore = whispering.connections;
		const reached = deferred<void>();
		const release = deferred<void>();
		const set = whispering.services.connections.set;
		whispering.services.connections.set = async (...args) => {
			reached.resolve();
			await release.promise;
			if (outcome === 'unknown')
				return Err('The save may or may not have completed.');
			return set(...args);
		};
		const saving = whispering.saveConnection('transcription', {
			baseUrl: TEST_BASE_URL,
			model: 'held',
			key: { action: 'keep' },
		});
		await reached.promise;

		// Held before it reaches the folder: the folder closes without it.
		await close(whispering);
		const selected = whispering.selectedPath;
		expect(whispering.open('late.txt')).toBe(false);
		expect(whispering.selectedPath).toBe(selected);
		expect(await whispering.createFile('', 'late.txt')).toContain('closing');
		expect(
			await whispering.createTransformation({ title: 'Late', prompt: '' }),
		).toContain('closing');
		expect(
			await whispering.delete({
				kind: 'file',
				path: 'text_runs/late.md',
			}),
		).toContain('closing');
		expect(
			await whispering.delete({
				kind: 'file',
				path: 'transformation_runs/late.md',
			}),
		).toContain('closing');

		release.resolve();
		expect(await saving).toBe(
			outcome === 'saved'
				? undefined
				: 'The save may or may not have completed.',
		);
		expect(whispering.connections).toBe(connectionsBefore);
		expect(folder.file('late.txt')).toBeUndefined();
		expect(await Bun.file(join(root, 'late.txt')).exists()).toBe(false);
	},
);

test('stopping the app returns at once while a save it asked for lands', async () => {
	const { host, whispering } = await open({ memory: true });
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const creating = whispering.createFile('', 'kept.txt');
	await eventually(() => host!.log.puts.some((put) => put.path === 'kept.txt'));
	try {
		const fixture = fixtures.find((item) => item.whispering === whispering)!;
		expect(closeTestWhispering(fixture)).toBeUndefined();
	} finally {
		host!.control.putGate = undefined;
		release.resolve();
	}
	expect(await creating).toBeUndefined();
	expect(host!.text('kept.txt')).toBe('');
});

test('closing during a rename lands its copy and keeps the original', async () => {
	const { folder, host, whispering } = await open({ memory: true });
	expectOk(await folder.write('original.txt', ''));
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const renaming = whispering.rename('original.txt', 'renamed.txt');
	await eventually(() =>
		host!.log.puts.some((put) => put.path === 'renamed.txt'),
	);
	const closing = close(whispering);
	host!.control.putGate = undefined;
	release.resolve();
	expect(await renaming).toContain('was kept because the folder is closing');
	await closing;
	expect(host!.text('original.txt')).toBe('');
	expect(host!.text('renamed.txt')).toBe('');
});

test('a result deletion asked for before the app stopped removes the path', async () => {
	const path = 'text_runs/result.md';
	const { folder, host, whispering } = await open({ memory: true });
	expectOk(await folder.write(path, 'Original result.\n'));
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const removing = whispering.delete(
		expectOk(await whispering.deletionFor(path)),
	);
	await eventually(() => folder.saving);
	whispering.dispose();
	host!.control.putGate = undefined;
	release.resolve();
	expect(await removing).toBeUndefined();
	expect(host!.text(path)).toBeUndefined();
});
