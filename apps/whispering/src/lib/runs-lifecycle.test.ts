/**
 * Run preparation and deletion races over the real Folder and whispering.
 * Requests capture valid held recording facts without publishing the source.
 * Deletion blocks related work throughout its asynchronous reads.
 * Closing during preparation sends no request, and an answer that arrives
 * once closing began writes nothing. Running an unfinished result
 * again inspects held input, so an answer typed there is not resent.
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
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { RECORDINGS } from './definition.js';
import type { WhisperingServices } from './platform/types.js';
import { quiet } from './query.test-support.js';
import {
	deferred,
	eventually,
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

test('transcribing captures accepted recording notes without publishing them', async () => {
	const { whispering, folder, entry, transcribed } = await open();
	const edit = folder.tables.recordings.document(entry.stem);
	await edit.refresh();
	expectOk(edit.patch({ body: 'Notes accepted before transcription.\n' }));
	await whispering.transcribe(entry);
	expect(expectOk(await folder.tables.recordings.get(entry.stem))?.body).toBe(
		'',
	);
	expect(edit.getSnapshot().content?.body).toBe(
		'Notes accepted before transcription.\n',
	);
	expect(edit.getSnapshot().isDirty).toBe(true);
	expect(transcribed.map((request) => request.audioPath)).toEqual([
		entry.path.replace(/\.md$/, '.wav'),
	]);
});

for (const replacement of ['missing', 'malformed'] as const)
	test(`a recording made ${replacement} since its listing sends nothing and can run after repair`, async () => {
		const { whispering, folder, root, entry, transcribed } = await open();
		const path = join(root, entry.path);
		const source = await readFile(path, 'utf8');
		if (replacement === 'missing') await rm(path);
		else await writeFile(path, '---\ntitle: broken\n---\n');
		await folder.tables.recordings.document(entry.stem).refresh();
		await whispering.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
		});
		await writeFile(path, source);
		await folder.tables.recordings.document(entry.stem).refresh();
		await whispering.transcribe(entry);
		expect(transcribed).toHaveLength(1);
	});

test('failed recording-note publication does not block a request whose own result record can save', async () => {
	const { whispering, folder, root, entry, transcribed } = await open();
	const edit = folder.tables.recordings.document(entry.stem);
	await edit.refresh();
	chmodSync(join(root, 'recordings'), 0o555);
	try {
		expectOk(edit.patch({ body: 'Failed notes retained in memory.\n' }));
		await edit.save();
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
	}
	expect(edit.getSnapshot().saveError).toBeDefined();
	await whispering.transcribe(entry);
	expect(transcribed).toHaveLength(1);
	expect(edit.getSnapshot().saveError).toBeDefined();
	expect(expectOk(await folder.tables.recordings.get(entry.stem))?.body).toBe(
		'',
	);
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

test('context close while the recording is being read prevents its transcription request', async () => {
	const { context, whispering, folder, root, entry, transcribed } =
		await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const get = folder.tables.recordings.get;
	let armed = true;
	replaceTables(folder, {
		recordings: {
			...folder.tables.recordings,
			async get(id) {
				const row = await get(id);
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
	context.close();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	expect(await Bun.file(join(root, 'transcriptions')).exists()).toBe(false);
});

test('two transcription presses while the recording is being read send one request', async () => {
	const { whispering, folder, entry, transcribed } = await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const get = folder.tables.recordings.get;
	let armed = true;
	replaceTables(folder, {
		recordings: {
			...folder.tables.recordings,
			async get(id) {
				const row = await get(id);
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

test('context close while the initial result is saving prevents a later provider request', async () => {
	const { context, whispering, folder, root, entry, transcribed } =
		await open();
	const entered = deferred<void>();
	const release = deferred<void>();
	const write = folder.tables.transcriptions.write;
	replaceTables(folder, {
		transcriptions: {
			...folder.tables.transcriptions,
			async write(id, change) {
				const result = await write(id, change);
				if (change.body === '') {
					entered.resolve();
					await release.promise;
				}
				return result;
			},
		},
	});
	const transcribing = whispering.transcribe(entry);
	await entered.promise;
	context.close();
	release.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	const rows = await Array.fromAsync(
		new Bun.Glob('transcriptions/*.md').scan(root),
	);
	expect(rows).toHaveLength(1);
	expect(await Bun.file(join(root, rows[0]!)).text()).toMatch(/\n---\n$/);
});

test('an answer arriving after the folder closes is not written', async () => {
	const answer =
		deferred<Awaited<ReturnType<WhisperingServices['transcribe']>>>();
	const { context, whispering, folder, root, entry, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const [row] = expectOk(await folder.tables.transcriptions.list());
	const path = `transcriptions/${row!.id}.md`;
	context.close();
	answer.resolve(Ok({ text: 'arrived after closing' }));
	await transcribing;
	expect(transcribed).toHaveLength(1);
	expect(await readFile(join(root, path), 'utf8')).toMatch(/\n---\n$/);
});

test('running a failed result again refuses held answer input without publishing it', async () => {
	const { context, whispering, folder, entry, transcribed } = await open({
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await whispering.transcribe(entry);
	await quiet(context);
	const transcript = whispering.resultsFor(entry.stem)[0]!;
	const edit = folder.tables.transcriptions.document(transcript.stem);
	await edit.refresh();
	expectOk(edit.patch({ body: 'An answer supplied by the person.\n' }));
	expect(await whispering.runAgain(transcript.path)).toContain(
		'already has its answer',
	);
	expect(transcribed).toHaveLength(1);
	expect(edit.getSnapshot().content?.body).toBe(
		'An answer supplied by the person.\n',
	);
	expect(edit.getSnapshot().isDirty).toBe(true);
	expect(
		expectOk(await folder.tables.transcriptions.get(transcript.stem))?.body,
	).toBe('');
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
	replaceTables(
		folder,
		{},
		{
			...files,
			async list(prefix) {
				const listed = await files.list(prefix);
				if (prefix === RECORDINGS && removing === undefined)
					removing = whispering.delete(deletion);
				return listed;
			},
		},
	);
	await whispering.runAgain(transcript.path);
	expect(removing).toBeDefined();
	expect(transcribed).toHaveLength(1);
	expect(await removing).toBeUndefined();
	expect(
		expectOk(await folder.tables.recordings.get(entry.stem)),
	).toBeUndefined();
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
	const closing = context.close();
	try {
		expect(closing).toBeUndefined();
	} finally {
		release.resolve();
	}
	expect(expectErr(await preflight)).toContain('closing');
	await closing;
});
