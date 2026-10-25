/**
 * Transformation workflow tests
 *
 * Drives the real product state against a real directory, opened as the
 * folder mirror, with a fixture capture device and stubbed transcription and
 * chat endpoints. No window, provider, key, or network is involved, so these
 * establish the workflow's logic and what it leaves on disk, not that a
 * provider accepts the request.
 *
 * Key behaviors:
 * - Nothing is seeded: a transformation exists only after it is created
 * - A transformation is an ordinary Markdown row: title and model in
 *   frontmatter, the prompt as its body
 * - Applying one writes a new result row and never writes the transcript
 * - A run sends the transcript as shown, typing included, or else its row as
 *   the folder shows it now; a transcript that does not read, or whose
 *   recording is gone, refuses
 * - A result carries the prompt and text that were sent, so it outlives edits
 *   to, and deletion of, its transformation
 * - A run's result row is written with every field and an empty body before
 *   the request goes out, and its body is filled when the answer arrives
 *   (ADR-0542)
 * - A request that fails leaves its row unfinished, keeps the transcript, and
 *   runs again from the row's own fields into the same row
 * - An answer whose write fails is kept until the person saves it again; a
 *   row already deleted is not written
 * - An answer sets the body over the file as it is then, replacing earlier
 *   body text
 * - A recording cannot be deleted while a request for it runs, including work
 *   that began after the deletion was confirmed
 * - A saved transformation keeps fields the app does not know, written in the
 *   canonical form; a row that does not read is named for repair and
 *   repaired as text
 * - Two asks for the same transcript and transformation at once are one
 *   request and one result, while another pair and a later run stay separate;
 *   a row run again twice at once is sent once
 */
import {
	closeTestWhispering,
	createTestWhispering,
	headerLine,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import type { WhisperingFolder } from './folder.js';
import {
	deferred,
	eventually,
	openMemoryTestFolder,
	openTestServices,
	settled,
	type TestServicesOptions,
} from './services.test-support.js';
import { TransformationError } from './transformation.js';
import type { Whispering } from './whispering.svelte.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const RUNS = 'transformation_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;

type Answer = Awaited<ReturnType<Whispering['services']['transform']>>;

async function open({
	memory = false,
	...options
}: TestServicesOptions & { memory?: boolean } = {}) {
	const inMemory = memory ? await openMemoryTestFolder() : undefined;
	const test = await openTestServices({ ...options, folder: inMemory });
	const { whispering } = await createTestWhispering(test);
	cleanups.push(async () => {
		closeTestWhispering({ whispering, folder: test.folder });
		await test.remove();
	});
	await whispering.start();
	return { whispering, host: inMemory?.host, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** A file's text as the folder shows it. */
function textOf(folder: WhisperingFolder, path: string) {
	const data = folder.file(path)?.data;
	if (typeof data !== 'string') throw new Error(`${path} is not text`);
	return data;
}

/** A recording with one saved transcript, and the transcript's text. */
async function transcribed(whispering: Whispering, folder: WhisperingFolder) {
	await whispering.startRecording();
	await whispering.stopRecording();
	await settled(folder);
	const recording = whispering.entries[0]!;
	await whispering.transcribe(recording);
	await settled(folder);
	const transcript = whispering.resultsFor(recording.stem)[0]!;
	return {
		recording,
		transcript,
		transcriptText: textOf(folder, transcript.path),
	};
}

/** Create the cleanup starter and give it a model, as a person would before running it. */
async function cleanupProfile(
	whispering: Whispering,
	folder: WhisperingFolder,
) {
	expect(await whispering.createTransformation(CLEANUP)).toBeUndefined();
	const path = whispering.selectedTransformation!.path;
	const stem = path.slice('transformations/'.length, -'.md'.length);
	expectOk(
		await folder.tables.transformations.update(stem, {
			fields: { model: 'chat-model' },
		}),
	);
	return { path, stem };
}

// ============================================================================
// Transformation files
// ============================================================================

test('opening a folder seeds no transformation; creating one writes an ordinary Markdown row', async () => {
	const { whispering, root } = await open();
	expect(whispering.transformations).toHaveLength(0);
	expect(await names(root, 'transformations')).toEqual([]);

	expect(await whispering.createTransformation(CLEANUP)).toBeUndefined();

	expect(whispering.transformations).toHaveLength(1);
	const entry = whispering.transformations[0]!;
	expect(whispering.selectedTransformationPath).toBe(entry.path);
	const source = await readFile(join(root, entry.path), 'utf8');
	// A new recipe names no model: it runs with the text connection.
	expect(entry.row.fields).toEqual({ title: 'Clean up', model: null });
	expect(source).toContain('model: null\n');
	expect(entry.row.body).toBe(CLEANUP.prompt);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a new transformation copies no model from another one', async () => {
	const { folder, whispering } = await open();
	const { stem } = await cleanupProfile(whispering, folder);
	expectOk(
		await folder.tables.transformations.update(stem, {
			fields: { model: 'other-model' },
		}),
	);

	await whispering.createTransformation({
		title: 'Summarize',
		prompt: 'Sum.\n',
	});

	const created = whispering.selectedTransformation!.entry!;
	expect(created.row.fields).toEqual({ title: 'Summarize', model: null });
});

test('saving a transformation keeps fields the app does not know, in the canonical form', async () => {
	const { folder, whispering, root } = await open();
	const source =
		'---\n# a comment\ntemperature: 0.2\ntitle: Mine\nmodel: chat-model\n---\nOriginal prompt\n';
	const path = join(root, 'transformations', 'mine.md');
	expectOk(await folder.write('transformations/mine.md', source));
	whispering.open('transformations/mine.md');
	// Opening reads; it writes nothing.
	expect(whispering.saving).toBe(false);
	expect(await readFile(path, 'utf8')).toBe(source);

	expectOk(
		await folder.tables.transformations.update('mine', {
			fields: { title: 'Renamed' },
			body: 'A new prompt\n',
		}),
	);

	const written = await readFile(path, 'utf8');
	const row = folder.tables.transformations.row('mine')!;
	expect<Record<string, unknown>>(row.fields as Record<string, unknown>).toEqual({
		title: 'Renamed',
		model: 'chat-model',
		temperature: 0.2,
	});
	expect(row.body).toBe('A new prompt\n');
	// A field the app does not declare is kept, after the declared ones; the
	// comment is not, since a save writes the canonical frontmatter.
	expect(written).toBe(
		'---\ntitle: Renamed\nmodel: chat-model\ntemperature: 0.2\n---\nA new prompt\n',
	);
	expect(
		await whispering.rename('transformations/mine.md', 'other.md'),
	).toContain('named by its ID');
});

test('a transformation that does not read is named for repair, cannot run, and is repaired as text', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	const path = 'transformations/broken.md';
	expectOk(await folder.write(path, broken));

	expect(whispering.transformations).toEqual([]);
	expect(whispering.transformationRepairs.map((item) => item.path)).toEqual([
		path,
	]);
	whispering.open(path);
	expect(whispering.showsText(path)).toBe(true);
	expect(textOf(folder, path)).toBe(broken);
	expect(await whispering.transform(transcript.path, path)).toBe(
		'Repair this transformation before running it.',
	);
	expect(transformed).toHaveLength(0);
	expect(await readFile(join(root, path), 'utf8')).toBe(broken);

	// Repaired in Source: the whole text is written.
	const repaired =
		'---\ntitle: Repaired\nmodel: chat-model\nmood: curious\n---\nStill here\n';
	expectOk(await folder.write(path, repaired));
	expect(whispering.transformations.map((item) => item.path)).toEqual([path]);
	expect(await whispering.transform(transcript.path, path)).toBeUndefined();
	expect(transformed).toHaveLength(1);
	// Repaired, it is edited as fields again, with its unknown field kept.
	expect(whispering.useForm(path, repaired)).toBeUndefined();
	expect(whispering.showsText(path)).toBe(false);
	expect(whispering.transformations[0]!.row.fields).toMatchObject({
		title: 'Repaired',
		mood: 'curious',
	});
});

// ============================================================================
// Applying a transformation
// ============================================================================

test('applying a transformation writes a new result row and leaves the transcript untouched', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { recording, transcript } = await transcribed(whispering, folder);
	const transcriptBytes = await readFile(join(root, transcript.path));
	const editor = await cleanupProfile(whispering, folder);
	const profile = whispering.transformations[0]!;

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	// Prepared for the text connection; the recipe's own model is used.
	expect(transformed).toEqual([
		{
			expectedBaseUrl: 'http://127.0.0.1:18080/v1',
			model: 'chat-model',
			prompt: CLEANUP.prompt,
			input: 'um so a steady tone\n',
		},
	]);
	expect(whispering.recipeRuns).toHaveLength(0);
	const outputs = whispering.outputsFor(transcript.stem);
	expect(outputs).toHaveLength(1);
	const output = outputs[0]!;
	expect(output.row.body).toBe('Transformed: um so a steady tone\n');
	expect(output.row.fields).toMatchObject({
		recordingId: recording.stem,
		transcriptionId: transcript.stem,
		transformationId: profile.stem,
		transformationTitle: 'Clean up',
		model: 'chat-model',
		endpoint: 'http://127.0.0.1:18080/v1',
		prompt: CLEANUP.prompt,
		input: 'um so a steady tone\n',
	});
	expect(whispering.outputsOf(profile.stem)).toEqual(outputs);
	// The original transcript is the same bytes, and still the only transcript.
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
	expect(await names(root, 'transcriptions')).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
});

test('a run sends the transcript as shown, typing included, records exactly that, and writes no transcript', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const before = await readFile(join(root, transcript.path), 'utf8');
	const editor = await cleanupProfile(whispering, folder);

	expect(
		await whispering.transform(transcript.path, editor.path, {
			input: 'Typed over the transcript, not saved yet.\n',
		}),
	).toBeUndefined();

	expect(transformed.map((request) => request.input)).toEqual([
		'Typed over the transcript, not saved yet.\n',
	]);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.fields.input).toBe(
		'Typed over the transcript, not saved yet.\n',
	);
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(before);
});

test('a transformation with no instructions, or a transcript with no text, sends nothing', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(whispering, folder);
	await whispering.createTransformation({ title: 'Empty', prompt: '' });
	const path = whispering.selectedTransformation!.path;

	expect(await whispering.transform(transcript.path, path)).toBe(
		'Write instructions to run this.',
	);
	expectOk(
		await folder.tables.transformations.update(path.slice(16, -3), {
			body: 'Fix it.\n',
		}),
	);
	expectOk(
		await folder.write(
			transcript.path,
			transcriptText.replace(transcript.row.body, ' \n'),
		),
	);
	expect(await whispering.transform(transcript.path, path)).toContain(
		'no text',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

// ============================================================================
// The folder's current files decide what is sent
// ============================================================================

test('an outside transcript edit the folder shows is sent without rewriting its source', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	// Another program rewrites the transcript and adds a field.
	const outside = transcriptText
		.replace('---\n', '---\nreviewedBy: someone\n')
		.replace(transcript.row.body, 'A steady tone, corrected by hand.\n');
	await writeFile(join(root, transcript.path), outside);
	folder.checkpoint();
	await eventually(
		() =>
			whispering.resultsFor(transcript.row.fields.recordingId)[0]?.row.body ===
			'A steady tone, corrected by hand.\n',
	);

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]!.input).toBe('A steady tone, corrected by hand.\n');
	const output = whispering.outputsFor(transcript.stem)[0]!;
	expect(output.row.fields.input).toBe('A steady tone, corrected by hand.\n');
	expect(output.row.body).toBe(
		'Transformed: A steady tone, corrected by hand.\n',
	);
	// The transcript is exactly what the other program wrote, unknown field included.
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(outside);
});

test('a transcript that does not read refuses, and so does one that is gone', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);

	const broken = '---\nrecordingId: *missing\n---\nStill some text\n';
	expectOk(await folder.write(transcript.path, broken));
	expect(await whispering.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(broken);

	expectOk(await folder.delete(transcript.path));
	expect(await whispering.transform(transcript.path, editor.path)).toContain(
		'no longer in the folder',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transcript whose recording was deleted refuses', async () => {
	const { folder, whispering, transformed } = await open();
	const { recording, transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	expectOk(await folder.delete(recording.path));
	expectOk(await folder.delete(recording.path.replace(/\.md$/, '.wav')));

	expect(await whispering.transform(transcript.path, editor.path)).toBe(
		'The recording this transcript was made from is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
});

// ============================================================================
// Deleting a recording while work for it runs
// ============================================================================

/**
 * The state of the newest result made from `transcriptionId`, once the
 * saves under way have landed.
 */
async function newestResult(
	whispering: Whispering,
	folder: WhisperingFolder,
	transcriptionId: string,
) {
	await settled(folder);
	const output = whispering.outputsFor(transcriptionId)[0]!;
	return {
		output,
		state: whispering.resultState(output.path, output.row.body),
	};
}

test('a recording cannot be deleted while a transformation of it runs, including one started after confirming', async () => {
	const answer = deferred<Answer>();
	const started = deferred<void>();
	const { folder, whispering, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { recording, transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	// The person is asked, and agrees, before any request exists.
	const confirmed = expectOk(await whispering.deletionFor(recording.path));

	const running = whispering.transform(transcript.path, editor.path);
	await started.promise;
	expect(
		(await newestResult(whispering, folder, transcript.stem)).state.kind,
	).toBe('running');

	// Asking now refuses, and so does the deletion already confirmed.
	const { error: refusal } = await whispering.deletionFor(recording.path);
	expect(refusal).toContain('still running');
	expect(await whispering.delete(confirmed)).toContain('still running');
	expect((await names(root, 'recordings')).sort()).toEqual([
		`${recording.stem}.md`,
		`${recording.stem}.wav`,
	]);

	answer.resolve(Ok({ text: 'arrived' }));
	await running;

	// The result written since was never named to the person, so they are asked again.
	expect(await whispering.delete(confirmed)).toContain('after you were asked');
	expect(await names(root, RUNS)).toHaveLength(1);
	const again = expectOk(await whispering.deletionFor(recording.path));
	expect(again).toMatchObject({ kind: 'recording' });
	expect(await whispering.delete(again!)).toBeUndefined();
	// The row and the results are gone. The audio is an ordinary file and stays.
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run does not block deletion, and its row goes with the recording', async () => {
	const { folder, whispering, root, transformed } = await open({
		transform: async () =>
			TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
	});
	const { recording, transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	await whispering.transform(transcript.path, editor.path);
	const { output, state } = await newestResult(
		whispering,
		folder,
		transcript.stem,
	);
	expect(state.kind).toBe('failed');

	const deletion = expectOk(await whispering.deletionFor(recording.path));
	expect(await whispering.delete(deletion!)).toBeUndefined();

	// Nothing is left that could be run again against the deleted recording.
	expect(await whispering.runAgain(output.path)).toContain(
		'no longer in the folder',
	);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transformation asked for while its recording is being deleted sends nothing', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { recording, transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	const deletion = expectOk(await whispering.deletionFor(recording.path));

	const removing = whispering.delete(deletion!);
	const problem = await whispering.transform(transcript.path, editor.path);
	expect(await removing).toBeUndefined();

	expect(problem).toMatch(/being deleted|no longer in the folder/);
	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toEqual([]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a result outlives edits to its transformation and the transformation’s deletion', async () => {
	const { folder, whispering, root } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	await whispering.transform(transcript.path, editor.path);
	const output = whispering.outputsFor(transcript.stem)[0]!;
	const result = await readFile(join(root, output.path), 'utf8');

	expectOk(
		await folder.tables.transformations.update(editor.stem, {
			fields: { title: 'Renamed' },
			body: 'A different prompt.\n',
		}),
	);
	expect(await readFile(join(root, output.path), 'utf8')).toBe(result);

	const deletion = expectOk(await whispering.deletionFor(editor.path));
	expect(deletion).toMatchObject({ kind: 'transformation', results: 1 });
	expect(await whispering.delete(deletion!)).toBeUndefined();

	expect(whispering.transformations).toHaveLength(0);
	expect(whispering.selectedTransformation).toBeUndefined();
	expect(await names(root, 'transformations')).toEqual([]);
	expect(await readFile(join(root, output.path), 'utf8')).toBe(result);
	const kept = whispering.outputsFor(transcript.stem)[0]!;
	expect(kept.row.fields.transformationTitle).toBe('Clean up');
	expect(kept.row.fields.prompt).toBe(CLEANUP.prompt);
});

test('deleting a recording removes the results made from its transcripts', async () => {
	const { folder, whispering, root } = await open();
	const { recording, transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	await whispering.transform(transcript.path, editor.path);
	expect(await names(root, RUNS)).toHaveLength(1);

	const deletion = expectOk(await whispering.deletionFor(recording.path));
	expect(deletion).toMatchObject({ kind: 'recording' });
	expect(await whispering.delete(deletion!)).toBeUndefined();

	expect(await names(root, RUNS)).toEqual([]);
	expect(await names(root, 'transcriptions')).toEqual([]);
	// The transformation itself is not the recording's.
	expect(whispering.transformations).toHaveLength(1);
});

// ============================================================================
// A run's row, from its start
// ============================================================================

test('a run’s row is in the folder from its start with every field and no body, and holds nothing in the window', async () => {
	const answer = deferred<Answer>();
	const started = deferred<void>();
	const { folder, whispering, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);

	const running = whispering.transform(transcript.path, editor.path);
	await started.promise;

	const { output, state } = await newestResult(
		whispering,
		folder,
		transcript.stem,
	);
	expect(state.kind).toBe('running');
	expect(output.row.body).toBe('');
	expect(output.row.fields).toMatchObject({
		transcriptionId: transcript.stem,
		prompt: CLEANUP.prompt,
		input: 'um so a steady tone\n',
	});
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(whispering.recipeRuns).toHaveLength(1);

	answer.resolve(Ok({ text: 'done' }));
	await running;

	expect(whispering.recipeRuns).toEqual([]);
	expect(
		(await newestResult(whispering, folder, transcript.stem)).state.kind,
	).toBe('answered');
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe('done\n');
});

test('a refused request leaves its row unfinished; running it again sends the same request into the same row', async () => {
	let attempts = 0;
	const { folder, whispering, root, transformed } = await open({
		transform: async ({ input }) => {
			attempts += 1;
			if (attempts === 1)
				return TransformationError.Rejected({
					url: 'http://127.0.0.1:18080/v1/chat/completions',
					status: 429,
					detail: 'slow down',
				});
			if (attempts === 2) throw new Error('the folder host went away');
			return Ok({ text: `Third try: ${input.trim()}` });
		},
	});
	const { transcript } = await transcribed(whispering, folder);
	const transcriptBytes = await readFile(join(root, transcript.path));
	const editor = await cleanupProfile(whispering, folder);

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	const { output, state } = await newestResult(
		whispering,
		folder,
		transcript.stem,
	);
	expect(state).toEqual({
		kind: 'failed',
		message: 'The endpoint answered 429: slow down',
	});
	expect(output.row.body).toBe('');
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);

	// A transport that throws is a failure too, never a run left running.
	expect(await whispering.runAgain(output.path)).toBeUndefined();
	expect(
		(await newestResult(whispering, folder, transcript.stem)).state,
	).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});

	expect(await whispering.runAgain(output.path)).toBeUndefined();

	expect(transformed).toHaveLength(3);
	expect(transformed[2]).toEqual(transformed[0]!);
	const filled = whispering.outputsFor(transcript.stem);
	expect(filled.map((item) => item.stem)).toEqual([output.stem]);
	expect(filled[0]!.row.fields).toEqual(output.row.fields);
	expect(filled[0]!.row.body).toBe('Third try: um so a steady tone\n');
});

test('running again sends what the row holds, not what the transcript holds now', async () => {
	let refuse = true;
	const { folder, whispering, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: input }),
	});
	const { transcript, transcriptText } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	await whispering.transform(transcript.path, editor.path);
	const { output } = await newestResult(whispering, folder, transcript.stem);
	refuse = false;
	expectOk(
		await folder.write(
			transcript.path,
			transcriptText.replace(transcript.row.body, 'Different now.\n'),
		),
	);

	expect(await whispering.runAgain(output.path)).toBeUndefined();

	expect(transformed.map((request) => request.input)).toEqual([
		'um so a steady tone\n',
		'um so a steady tone\n',
	]);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'um so a steady tone\n',
	);
});

test('an answer whose write fails is kept until Save again writes it, with no second request', async () => {
	const answer = deferred<Answer>();
	const { folder, whispering, root, transformed } = await open({
		transform: () => answer.promise,
	});
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);

	const running = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = await newestResult(whispering, folder, transcript.stem);
	chmodSync(join(root, RUNS), 0o555);
	try {
		answer.resolve(Ok({ text: 'Transformed: um so a steady tone' }));
		await running;
	} finally {
		chmodSync(join(root, RUNS), 0o755);
	}

	expect(whispering.resultState(output.path, '')).toMatchObject({
		kind: 'writing',
		text: 'Transformed: um so a steady tone',
		message: expect.any(String),
	});
	expect(headerLine(whispering).label).toBe('1 answer not written yet');
	// Nothing writes it again on its own.
	await Bun.sleep(30);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe('');

	await whispering.saveAgain(output.path);

	expect(transformed).toHaveLength(1);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'Transformed: um so a steady tone\n',
	);
	expect(whispering.unwrittenAnswers).toBe(0);
	expect(headerLine(whispering).tone).toBe('good');
});

test('an answer replaces the current body, and an answer for an already deleted row writes nothing', async () => {
	const answers = [deferred<Answer>(), deferred<Answer>()];
	const { folder, whispering, root, transformed } = await open({
		transform: () => answers[transformed.length - 1]!.promise,
	});
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);

	const first = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = await newestResult(whispering, folder, transcript.stem);
	const path = join(root, output.path);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/---\n$/, '---\nTyped by hand.\n'),
	);
	answers[0]!.resolve(Ok({ text: 'from the endpoint' }));
	await first;
	const filled = await readFile(path, 'utf8');
	expect(filled).toEndWith('---\nfrom the endpoint\n');
	expect(filled).not.toContain('Typed by hand.');

	const second = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 2);
	await settled(folder);
	const discarded = whispering
		.outputsFor(transcript.stem)
		.find((item) => item.stem !== output.stem)!;
	expect(
		await whispering.delete(
			expectOk(await whispering.deletionFor(discarded.path)),
		),
	).toBeUndefined();
	answers[1]!.resolve(Ok({ text: 'too late' }));
	await second;

	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(whispering.unwrittenAnswers).toBe(0);
});

/**
 * Run a transformation whose result row another writer fills with `typed`
 * just before the answer's save lands. Answers the row afterwards.
 */
async function fillRace(typed: string) {
	const answer = deferred<Answer>();
	const { folder, host, whispering, transformed } = await open({
		memory: true,
		transform: () => answer.promise,
	});
	const { transcript } = await transcribed(whispering, folder);
	const editor = await cleanupProfile(whispering, folder);
	const running = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = await newestResult(whispering, folder, transcript.stem);
	let filled = false;
	host!.control.beforePut = (path) => {
		if (path !== output.path || filled) return;
		filled = true;
		host!.outside(path, `${host!.text(path)}${typed}`, { hint: false });
	};

	answer.resolve(Ok({ text: 'from the endpoint' }));
	await running;
	await settled(folder);

	expect(filled).toBe(true);
	expect(whispering.unwrittenAnswers).toBe(0);
	return {
		text: host!.text(output.path),
		shown: whispering.outputsFor(transcript.stem)[0]?.row.body,
	};
}

test('an answer replaces a body written just before it landed', async () => {
	const { text, shown } = await fillRace('Typed by hand.\n');
	expect(text).not.toContain('Typed by hand.\n');
	expect(text).toEndWith('from the endpoint\n');
	expect(shown).toBe('from the endpoint\n');
});

test('an answer that someone filled with the same text just before it landed is in the body once', async () => {
	const { shown } = await fillRace('from the endpoint\n');
	expect(shown).toBe('from the endpoint\n');
});

// ============================================================================
// One run for one ask
// ============================================================================

test('two asks for the same transcript and transformation at once send one request and write one result; another pair and a later run are separate', async () => {
	const { folder, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const transcriptBytes = await readFile(join(root, transcript.path));
	const cleanup = await cleanupProfile(whispering, folder);
	expect(
		await whispering.createTransformation(STARTER_TRANSFORMATIONS[1]!),
	).toBeUndefined();
	const summarize = whispering.selectedTransformation!.path;
	expectOk(
		await folder.tables.transformations.update(summarize.slice(16, -3), {
			fields: { model: 'chat-model' },
		}),
	);

	const first = whispering.transform(transcript.path, cleanup.path);
	const second = whispering.transform(transcript.path, cleanup.path);
	const other = whispering.transform(transcript.path, summarize);

	// The second ask is refused while the first runs: nothing has been sent yet.
	expect(await second).toContain('already running on this transcript');
	expect(transformed).toEqual([]);
	expect(await first).toBeUndefined();
	expect(await other).toBeUndefined();

	expect(transformed).toHaveLength(2);
	expect(transformed.map((request) => request.prompt).sort()).toEqual(
		[
			STARTER_TRANSFORMATIONS[0]!.prompt,
			STARTER_TRANSFORMATIONS[1]!.prompt,
		].sort(),
	);
	expect(await names(root, RUNS)).toHaveLength(2);
	expect(whispering.recipeRuns).toEqual([]);

	// Asked again once the first has ended, it runs again and is its own result.
	expect(
		await whispering.transform(transcript.path, cleanup.path),
	).toBeUndefined();
	expect(transformed).toHaveLength(3);
	expect(await names(root, RUNS)).toHaveLength(3);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
});

test('a failed run run again twice at once is sent once more, not twice', async () => {
	let attempts = 0;
	const { folder, whispering, root, transformed } = await open({
		transform: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'after the host came back' });
		},
	});
	const { transcript } = await transcribed(whispering, folder);
	const cleanup = await cleanupProfile(whispering, folder);
	await whispering.transform(transcript.path, cleanup.path);
	const { output, state } = await newestResult(
		whispering,
		folder,
		transcript.stem,
	);
	expect(state.kind).toBe('failed');

	const answers = await Promise.all([
		whispering.runAgain(output.path),
		whispering.runAgain(output.path),
	]);

	// One run again sent the row; the other was refused while it ran.
	expect(answers).toContain('This is already running.');
	expect(transformed).toHaveLength(2);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'after the host came back\n',
	);
});
