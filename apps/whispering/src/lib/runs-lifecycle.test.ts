/**
 * Run preparation and deletion races over the real Folder and library.
 * Requests use freshly saved recording facts, failed input never sends older
 * audio, and reserving a deletion blocks work throughout its asynchronous reads.
 * Closing during preparation sends no request. Running an unfinished result
 * again first saves its accepted edits, so an answer typed there is not resent.
 */
import { closeTestLibrary, openTestLibrary } from './library.test-support.js';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectOk } from 'wellcrafted/testing';
import { quiet } from './query.test-support.js';
import { RECORDINGS } from './definition.js';
import {
	deferred,
	openTestServices,
	replaceTables,
	type TestServicesOptions,
} from './services.test-support.js';
import { TranscriptionError } from './transcription.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(options: TestServicesOptions = {}) {
	const services = await openTestServices(options);
	const library = await openTestLibrary(services);
	cleanups.push(async () => {
		await closeTestLibrary(library);
		await services.remove();
	});
	await library.startRecording();
	await library.stopRecording();
	await quiet(library);
	return { ...services, library, entry: library.entries[0]! };
}

test('transcribing discovers the current sibling format without waiting for a listing refresh', async () => {
	const { library, root, entry, transcribed } = await open();
	const wav = entry.path.replace(/\.md$/, '.wav');
	const webm = entry.path.replace(/\.md$/, '.webm');
	await rename(join(root, wav), join(root, webm));
	await library.transcribe(entry);
	expect(transcribed.map((request) => request.audioPath)).toEqual([webm]);
});

test('ambiguous sibling audio refuses transcription without sending a provider request', async () => {
	const { library, root, entry, transcribed } = await open();
	await writeFile(
		join(root, entry.path.replace(/\.md$/, '.webm')),
		new Uint8Array([1, 2]),
	);
	await library.transcribe(entry);
	expect(transcribed).toEqual([]);
	expect(library.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('More than one audio file'),
	});
});

test('transcribing saves accepted recording notes before preparing its request', async () => {
	const { library, folder, entry, transcribed } = await open();
	const edit = folder.tables.recordings.edit(entry.stem);
	await edit.read();
	expectOk(edit.change({ body: 'Notes accepted before transcription.\n' }));
	await library.transcribe(entry);
	expect(expectOk(await folder.tables.recordings.get(entry.stem))?.body).toBe(
		'Notes accepted before transcription.\n',
	);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		entry.path.replace(/\.md$/, '.wav'),
	]);
});

for (const replacement of ['missing', 'malformed'] as const)
	test(`a recording made ${replacement} since its listing sends nothing and can run after repair`, async () => {
		const { library, root, entry, transcribed } = await open();
		const path = join(root, entry.path);
		const source = await readFile(path, 'utf8');
		if (replacement === 'missing') await rm(path);
		else await writeFile(path, '---\ntitle: broken\n---\n');
		await library.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(library.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
		});
		await writeFile(path, source);
		await library.transcribe(entry);
		expect(transcribed).toHaveLength(1);
	});

test('recording notes that cannot save prevent transcription', async () => {
	const { library, folder, root, entry, transcribed } = await open();
	const edit = folder.tables.recordings.edit(entry.stem);
	await edit.read();
	chmodSync(join(root, 'recordings'), 0o555);
	try {
		expectOk(edit.change({ body: 'Notes accepted before transcription.\n' }));
		await library.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(library.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('unsaved changes'),
		});
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
		await edit.save();
	}
});

test('a deletion blocks new transcriptions while it reads the recording’s confirmed results', async () => {
	const { library, folder, entry, transcribed } = await open();
	const deletion = expectOk(await library.deletionFor(entry.path));
	const entered = deferred<void>();
	const release = deferred<void>();
	const transcripts = folder.tables.transcriptions;
	let armed = true;
	replaceTables(folder, {
		transcriptions: {
			...transcripts,
			async list() {
				const rows = await transcripts.list();
				if (armed) {
					armed = false;
					entered.resolve();
					await release.promise;
				}
				return rows;
			},
		},
	});
	const removing = library.delete(deletion);
	await entered.promise;
	try {
		await library.transcribe(entry);
		expect(transcribed).toEqual([]);
	} finally {
		release.resolve();
	}
	expect(await removing).toBeUndefined();
	expect(expectOk(await folder.tables.transcriptions.list())).toEqual([]);
});

test('closing while the recording is being read prevents its transcription request', async () => {
	const { library, folder, entry, transcribed } = await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const recordings = folder.tables.recordings;
	let armed = true;
	replaceTables(folder, {
		recordings: {
			...recordings,
			async get(id) {
				const row = await recordings.get(id);
				if (armed) {
					armed = false;
					entered.resolve();
					await release.promise;
				}
				return row;
			},
		},
	});
	const transcribing = library.transcribe(entry);
	await entered.promise;
	library.stop();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	expect(expectOk(await folder.tables.transcriptions.list())).toEqual([]);
});

test('two transcription presses while the recording is being read send one request', async () => {
	const { library, folder, entry, transcribed } = await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const recordings = folder.tables.recordings;
	let armed = true;
	replaceTables(folder, {
		recordings: {
			...recordings,
			async get(id) {
				const row = await recordings.get(id);
				if (armed) {
					armed = false;
					entered.resolve();
					await release.promise;
				}
				return row;
			},
		},
	});
	const first = library.transcribe(entry);
	await entered.promise;
	await library.transcribe(entry);
	release.resolve();
	await first;
	expect(transcribed).toHaveLength(1);
});

test('closing while the initial result is saving prevents a later provider request', async () => {
	const { library, folder, entry, transcribed } = await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const transcripts = folder.tables.transcriptions;
	replaceTables(folder, {
		transcriptions: {
			...transcripts,
			async set(id, from, change) {
				const result = await transcripts.set(id, from, change);
				if (from === null) {
					entered.resolve();
					await release.promise;
				}
				return result;
			},
		},
	});
	const transcribing = library.transcribe(entry);
	await entered.promise;
	library.stop();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	const rows = expectOk(await folder.tables.transcriptions.list());
	expect(rows).toHaveLength(1);
	expect(rows[0]?.body).toBe('');
});

test('running a failed result again first saves an answer typed into its file', async () => {
	const { library, folder, entry, transcribed } = await open({
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await library.transcribe(entry);
	await quiet(library);
	const transcript = library.resultsFor(entry.stem)[0]!;
	const edit = folder.tables.transcriptions.edit(transcript.stem);
	await edit.read();
	expectOk(edit.change({ body: 'An answer supplied by the person.\n' }));
	expect(await library.runAgain(transcript.path)).toContain(
		'already has its answer',
	);
	expect(transcribed).toHaveLength(1);
	expect(
		expectOk(await folder.tables.transcriptions.get(transcript.stem))?.body,
	).toBe('An answer supplied by the person.\n');
});

test('a deletion reserved during the final preparation read prevents its provider request', async () => {
	const { library, folder, entry, transcribed } = await open({
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await library.transcribe(entry);
	await quiet(library);
	const transcript = library.resultsFor(entry.stem)[0]!;
	const deletion = expectOk(await library.deletionFor(entry.path));
	const entered = deferred<void>();
	const release = deferred<void>();
	const transcripts = folder.tables.transcriptions;
	let listArmed = true;
	const files = folder.files;
	let removing: Promise<string | undefined> | undefined;
	replaceTables(folder, {
		transcriptions: {
			...transcripts,
			async list() {
				const rows = await transcripts.list();
				if (listArmed) {
					listArmed = false;
					entered.resolve();
					await release.promise;
				}
				return rows;
			},
		},
	}, {
		...files,
		async list(prefix) {
			const listed = await files.list(prefix);
			if (prefix === RECORDINGS && removing === undefined) {
				removing = library.delete(deletion);
				await entered.promise;
			}
			return listed;
		},
	});
	try {
		await library.runAgain(transcript.path);
		await entered.promise;
		expect(removing).toBeDefined();
		expect(transcribed).toHaveLength(1);
	} finally {
		release.resolve();
		await removing;
	}
	expect(
		expectOk(await folder.tables.recordings.get(entry.stem)),
	).toBeUndefined();
});
