/**
 * Run preparation, answers, and deletion races over the real folder and
 * whispering. A run reads the recording and its audio from the folder as it
 * shows them now. Deletion blocks related work while it runs. Closing before
 * a request goes out sends none, and an answer that arrives once closing
 * began writes nothing. An answer whose file cannot be written stays in the
 * window until the person saves it again, and a row deleted meanwhile is
 * left absent.
 */
import {
	closeTestWhispering,
	headerLine,
	openTestWhispering,
} from './whispering.test-support.js';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { SaveError } from '../../../../packages/folder/src/shared/errors.js';
import type { WhisperingServices } from './platform/types.js';
import {
	deferred,
	eventually,
	openMemoryTestFolder,
	openTestServices,
	type TestServicesOptions,
	waitForSaves,
} from './services.test-support.js';
import { TranscriptionError } from './transcription.js';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Answer = Awaited<ReturnType<WhisperingServices['transcribe']>>;

/** Whispering with one finished recording, over a directory or, with `memory`, over memory. */
async function open({
	memory = false,
	...options
}: TestServicesOptions & { memory?: boolean } = {}) {
	const inMemory = memory ? await openMemoryTestFolder() : undefined;
	const services = await openTestServices({ ...options, folder: inMemory });
	const { whispering } = await openTestWhispering(services);
	cleanups.push(async () => {
		closeTestWhispering({ whispering, folder: services.folder });
		await services.remove();
	});
	await whispering.startRecording();
	await whispering.stopRecording();
	await waitForSaves(services.folder);
	return {
		...services,
		host: inMemory?.host,
		whispering,
		entry: whispering.entries[0]!,
	};
}

test('transcribing sends the sibling audio the folder lists now', async () => {
	const { whispering, folder, entry, transcribed } = await open();
	const wav = entry.path.replace(/\.md$/, '.wav');
	const webm = entry.path.replace(/\.md$/, '.webm');
	const bytes = expectOk(await folder.read(wav))!;
	expectOk(await folder.write(webm, bytes));
	expectOk(await folder.delete(wav));
	await whispering.transcribe(entry);
	expect(transcribed.map((request) => request.audioPath)).toEqual([webm]);
});

test('ambiguous sibling audio refuses transcription without sending a provider request', async () => {
	const { whispering, folder, entry, transcribed } = await open();
	expectOk(
		await folder.write(
			entry.path.replace(/\.md$/, '.webm'),
			new Uint8Array([1, 2]),
		),
	);
	await whispering.transcribe(entry);
	expect(transcribed).toEqual([]);
	expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('More than one audio file'),
	});
});

for (const replacement of ['missing', 'malformed'] as const)
	test(`a recording made ${replacement} since it was listed sends nothing and can run after repair`, async () => {
		const { whispering, folder, entry, transcribed } = await open();
		const source = folder.file(entry.path)?.data;
		if (typeof source !== 'string') throw new Error('Expected row text');
		if (replacement === 'missing') expectOk(await folder.delete(entry.path));
		else expectOk(await folder.write(entry.path, '---\ntitle: broken\n---\n'));
		await whispering.transcribe(entry);
		expect(transcribed).toEqual([]);
		expect(whispering.transcriptionRun(entry.stem)).toMatchObject({
			kind: 'failed',
		});
		expectOk(await folder.write(entry.path, source));
		await whispering.transcribe(entry);
		expect(transcribed).toHaveLength(1);
	});

test('a recording-note save that failed does not block a request whose own result row can save', async () => {
	const { whispering, folder, root, entry, transcribed } = await open();
	chmodSync(join(root, 'recordings'), 0o555);
	try {
		const { error } = await folder.tables.recordings.update(entry.stem, {
			body: 'Notes that did not save.\n',
		});
		expect(error).not.toBeNull();
	} finally {
		chmodSync(join(root, 'recordings'), 0o755);
	}
	await whispering.transcribe(entry);
	expect(transcribed).toHaveLength(1);
	expect(folder.tables.recordings.row(entry.stem)?.body).toBe('');
});

test('a deletion under way blocks new transcriptions and Run again', async () => {
	const { whispering, folder, host, entry, transcribed } = await open({
		memory: true,
		transcribe: async () =>
			TranscriptionError.HostUnavailable({ reason: 'reply lost' }),
	});
	await whispering.transcribe(entry);
	const [failed] = whispering.resultsFor(entry.stem);
	expect(transcribed).toHaveLength(1);
	const deletion = expectOk(await whispering.deletionFor(entry.path));
	const gate = deferred<void>();
	host!.control.putGate = gate.promise;
	const removing = whispering.delete(deletion);
	try {
		await whispering.transcribe(entry);
		expect(await whispering.runAgain(failed!.path)).toBe(
			'This recording is being deleted.',
		);
		expect(transcribed).toHaveLength(1);
	} finally {
		host!.control.putGate = undefined;
		gate.resolve();
	}
	expect(await removing).toBeUndefined();
	expect(folder.tables.transcriptions.rows).toEqual([]);
	expect(folder.tables.recordings.row(entry.stem)).toBeUndefined();
});

test('two transcription presses while the result row is created send one request', async () => {
	const { whispering, host, entry, transcribed } = await open({ memory: true });
	const gate = deferred<void>();
	host!.control.putGate = gate.promise;
	const first = whispering.transcribe(entry);
	await eventually(() => host!.log.puts.length > 0);
	await whispering.transcribe(entry);
	host!.control.putGate = undefined;
	gate.resolve();
	await first;
	expect(transcribed).toHaveLength(1);
});

test('closing while the result row is created prevents its provider request', async () => {
	const { whispering, folder, host, entry, transcribed } = await open({
		memory: true,
	});
	const gate = deferred<void>();
	host!.control.putGate = gate.promise;
	const transcribing = whispering.transcribe(entry);
	await eventually(() => folder.saving);
	closeTestWhispering({ whispering, folder });
	host!.control.putGate = undefined;
	gate.resolve();
	await transcribing;
	expect(transcribed).toEqual([]);
	const [row] = folder.tables.transcriptions.rows;
	expect(row?.body).toBe('');
});

test('an answer arriving after closing began is not written', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, root, entry, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const [row] = folder.tables.transcriptions.rows;
	closeTestWhispering({ whispering, folder });
	answer.resolve(Ok({ text: 'arrived after closing' }));
	await transcribing;
	expect(transcribed).toHaveLength(1);
	expect(
		await Bun.file(join(root, `transcriptions/${row!.id}.md`)).text(),
	).toMatch(/\n---\n$/);
});

test('an answer whose result row was deleted meanwhile writes nothing and is not kept', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, entry, transcribed } = await open({
		transcribe: () => answer.promise,
	});
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const [row] = folder.tables.transcriptions.rows;
	expectOk(await folder.tables.transcriptions.delete(row!.id));
	answer.resolve(Ok({ text: 'arrived after the row went' }));
	await transcribing;
	await waitForSaves(folder);
	expect(folder.file(row!.path)).toBeUndefined();
	expect(whispering.unwrittenAnswers).toBe(0);
	expect(whispering.resultState(row!.path, '')).toEqual({ kind: 'unfinished' });
});

test('an answer that could not be written is kept, and Save again writes it without another request', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, host, entry, transcribed } = await open({
		memory: true,
		transcribe: () => answer.promise,
	});
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const [row] = folder.tables.transcriptions.rows;
	host!.control.failPut.set(
		row!.path,
		SaveError.StorageFailed({ cause: new Error('the disk is full') }).error,
	);
	answer.resolve(Ok({ text: 'The words.' }));
	await transcribing;

	expect(whispering.resultState(row!.path, '')).toMatchObject({
		kind: 'writing',
		text: 'The words.',
		message: expect.stringContaining('the disk is full'),
	});
	expect(whispering.unwrittenAnswers).toBe(1);
	expect(headerLine(whispering).label).toBe('1 answer not written yet');
	expect(folder.tables.transcriptions.row(row!.id)?.body).toBe('');

	host!.control.failPut.delete(row!.path);
	await whispering.saveAgain(row!.path);
	expect(folder.tables.transcriptions.row(row!.id)?.body).toBe('The words.\n');
	expect(whispering.unwrittenAnswers).toBe(0);
	expect(transcribed).toHaveLength(1);
});

test('deleting a result drops its unwritten answer from the header', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, host, entry, transcribed } = await open({
		memory: true,
		transcribe: () => answer.promise,
	});
	const transcribing = whispering.transcribe(entry);
	await eventually(() => transcribed.length === 1);
	const [row] = folder.tables.transcriptions.rows;
	host!.control.failPut.set(
		row!.path,
		SaveError.StorageFailed({ cause: new Error('the disk is full') }).error,
	);
	answer.resolve(Ok({ text: 'The words.' }));
	await transcribing;
	expect(whispering.unwrittenAnswers).toBe(1);

	host!.control.failPut.delete(row!.path);
	const deletion = expectOk(await whispering.deletionFor(row!.path));
	expect(await whispering.delete(deletion)).toBeUndefined();
	expect(folder.file(row!.path)).toBeUndefined();
	expect(whispering.unwrittenAnswers).toBe(0);
});
