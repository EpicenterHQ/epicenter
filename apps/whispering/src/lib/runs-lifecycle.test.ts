/**
 * Run preparation and deletion races over the real Folder and whispering.
 * Requests use freshly saved recording facts, failed input never sends older
 * audio, and reserving a deletion blocks work throughout its asynchronous reads.
 * Closing during preparation sends no request. Running an unfinished result
 * again first saves its accepted edits, so an answer typed there is not resent.
 */
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { RECORDINGS } from './definition.js';
import { quiet } from './query.test-support.js';
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
	const { whispering, context } = await openTestWhispering(services);
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await services.remove();
	});
	await whispering.startRecording();
	await whispering.stopRecording();
	await quiet(context);
	return { ...services, whispering, context, entry: whispering.entries[0]! };
}

test('transcribing discovers the current sibling format without waiting for a listing refresh', async () => {
	const { whispering, root, entry, transcribed } = await open();
	const wav = entry.path.replace(/\.md$/, '.wav');
	const webm = entry.path.replace(/\.md$/, '.webm');
	await rename(join(root, wav), join(root, webm));
	await whispering.transcribe(entry);
	expect(transcribed.map((request) => request.audioPath)).toEqual([webm]);
});

test('ambiguous sibling audio refuses transcription without sending a provider request', async () => {
	const { whispering, root, entry, transcribed } = await open();
	await writeFile(
		join(root, entry.path.replace(/\.md$/, '.webm')),
		new Uint8Array([1, 2]),
	);
	await whispering.transcribe(entry);
	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('More than one audio file'),
	});
});

test('transcribing saves accepted recording notes before preparing its request', async () => {
	const { whispering, folder, entry, transcribed } = await open();
	const edit = folder.tables.recordings.edit(entry.stem);
	await edit.read();
	expectOk(edit.change({ body: 'Notes accepted before transcription.\n' }));
	await whispering.transcribe(entry);
	expect(expectOk(await folder.tables.recordings.get(entry.stem))?.body).toBe(
		'Notes accepted before transcription.\n',
	);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		entry.path.replace(/\.md$/, '.wav'),
	]);
});

for (const replacement of ['missing', 'malformed'] as const)
	test(`a recording made ${replacement} since its listing sends nothing and can run after repair`, async () => {
		const { whispering, root, entry, transcribed } = await open();
		const path = join(root, entry.path);
		const source = await readFile(path, 'utf8');
		if (replacement === 'missing') await rm(path);
		else await writeFile(path, '---\ntitle: broken\n---\n');
		await whispering.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
		});
		await writeFile(path, source);
		await whispering.transcribe(entry);
		expect(transcribed).toHaveLength(1);
	});

test('recording notes that cannot save prevent transcription', async () => {
	const { whispering, folder, root, entry, transcribed } = await open();
	const edit = folder.tables.recordings.edit(entry.stem);
	await edit.read();
	chmodSync(join(root, 'recordings'), 0o555);
	try {
		expectOk(edit.change({ body: 'Notes accepted before transcription.\n' }));
		await whispering.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('unsaved changes'),
		});
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
		await edit.save();
	}
});

test('a deletion blocks new transcriptions while it reads the recording’s confirmed results', async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	let armed = false;
	const { whispering, folder, entry, transcribed } = await open({
		async beforeStorageList() {
			if (!armed) return;
			armed = false;
			entered.resolve();
			await release.promise;
		},
	});
	const deletion = expectOk(await whispering.deletionFor(entry.path));
	armed = true;
	const removing = whispering.delete(deletion);
	await entered.promise;
	try {
		await whispering.transcribe(entry);
		expect(transcribed).toEqual([]);
	} finally {
		release.resolve();
	}
	expect(await removing).toBeUndefined();
	expect(expectOk(await folder.tables.transcriptions.list())).toEqual([]);
});

test('closing while the recording is being read prevents its transcription request', async () => {
	const { whispering, folder, root, entry, transcribed } = await open();
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
	const transcribing = whispering.transcribe(entry);
	await entered.promise;
	whispering.dispose();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	expect(await Bun.file(join(root, 'transcriptions')).exists()).toBe(false);
});

test('two transcription presses while the recording is being read send one request', async () => {
	const { whispering, folder, entry, transcribed } = await open();
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
	const first = whispering.transcribe(entry);
	await entered.promise;
	await whispering.transcribe(entry);
	release.resolve();
	await first;
	expect(transcribed).toHaveLength(1);
});

test('closing while the initial result is saving prevents a later provider request', async () => {
	const { whispering, folder, root, entry, transcribed } = await open();
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
	const transcribing = whispering.transcribe(entry);
	await entered.promise;
	whispering.dispose();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	const rows = await Array.fromAsync(new Bun.Glob('transcriptions/*.md').scan(root));
	expect(rows).toHaveLength(1);
	expect(await Bun.file(join(root, rows[0]!)).text()).toMatch(/\n---\n$/);
});

test('running a failed result again first saves an answer typed into its file', async () => {
	const { context, whispering, folder, entry, transcribed } = await open({
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await whispering.transcribe(entry);
	await quiet(context);
	const transcript = whispering.resultsFor(entry.stem)[0]!;
	const edit = folder.tables.transcriptions.edit(transcript.stem);
	await edit.read();
	expectOk(edit.change({ body: 'An answer supplied by the person.\n' }));
	expect(await whispering.runAgain(transcript.path)).toContain(
		'already has its answer',
	);
	expect(transcribed).toHaveLength(1);
	expect(
		expectOk(await folder.tables.transcriptions.get(transcript.stem))?.body,
	).toBe('An answer supplied by the person.\n');
});

test('a deletion reserved during the final preparation read prevents its provider request', async () => {
	const { context, whispering, folder, entry, transcribed } = await open({
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await whispering.transcribe(entry);
	await quiet(context);
	const transcript = whispering.resultsFor(entry.stem)[0]!;
	const deletion = expectOk(await whispering.deletionFor(entry.path));
	const files = folder.files;
	let removing: Promise<string | undefined> | undefined;
	replaceTables(folder, {}, {
		...files,
		async list(prefix) {
			const listed = await files.list(prefix);
			if (prefix === RECORDINGS && removing === undefined)
				removing = whispering.delete(deletion);
			return listed;
		},
	});
	await whispering.runAgain(transcript.path);
	expect(removing).toBeDefined();
	expect(transcribed).toHaveLength(1);
	expect(await removing).toBeUndefined();
	expect(expectOk(await folder.tables.recordings.get(entry.stem))).toBeUndefined();
});

test('an admitted recording deletion finishes after close interrupts its result reads', async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	let armed = false;
	const { context, whispering, root, entry } = await open({
		async beforeStorageList() {
			if (!armed) return;
			armed = false;
			entered.resolve();
			await release.promise;
		},
	});
	await whispering.transcribe(entry);
	await quiet(context);
	const deletion = expectOk(await whispering.deletionFor(entry.path));
	if (deletion.kind !== 'recording') throw new Error('Expected recording deletion');
	expect(deletion.results).toHaveLength(1);
	armed = true;
	const removing = whispering.delete(deletion);
	await entered.promise;
	whispering.dispose();
	expect(context.folder.getStatus().closing).toBe(true);
	const closing = context.close();
	release.resolve();
	expect(await removing).toBeUndefined();
	await closing;
	for (const path of [entry.path, ...deletion.results])
		expect(await Bun.file(join(root, path)).exists()).toBe(false);
	expect(await Bun.file(join(root, entry.path.replace(/\.md$/, '.wav'))).exists()).toBe(true);
});


test('closing completes while deletion preflight is reading and its late answer is refused', async () => {
	const entered = deferred<void>();
	const release = deferred<void>();
	let armed = false;
	const { context, whispering, entry } = await open({
		async beforeStorageList() {
			if (!armed) return;
			armed = false;
			entered.resolve();
			await release.promise;
		},
	});
	armed = true;
	const preflight = whispering.deletionFor(entry.path);
	await entered.promise;
	whispering.dispose();
	const closing = context.close();
	try {
		expect(await Promise.race([
			closing.then(() => true),
			Bun.sleep(100).then(() => false),
		])).toBe(true);
	} finally {
		release.resolve();
	}
	expect(expectErr(await preflight)).toContain('closing');
	await closing;
});
