/**
 * Transformation workflow tests
 *
 * Drives the real product state against a real directory, opened as the
 * native `Folder`, with a fixture capture device and stubbed transcription
 * and chat endpoints.
 * No window, provider, key, or network is involved, so these establish the
 * workflow's logic and what it leaves on disk, not that a provider accepts the
 * request.
 *
 * Key behaviors:
 * - Nothing is seeded: a transformation exists only after it is created
 * - A transformation is an ordinary Markdown row: title and model in
 *   frontmatter, the prompt as its body
 * - Applying one writes a new result row and never writes the transcript
 * - A result carries the prompt and text that were sent, so it outlives edits
 *   to, and deletion of, its transformation
 * - A run's result row is written with every field and an empty body before
 *   the request goes out, and its body is filled when the answer arrives
 *   (ADR-0542)
 * - A request that fails leaves its row unfinished, keeps the transcript, and
 *   runs again from the row's own fields into the same row
 * - An answer whose write fails is written again while the page lives; a row
 *   already deleted when checked is not written
 * - An answer publishes into the current body and replaces earlier body text
 * - Requests capture valid held source, reading only when unacquired; invalid
 *   transcript source or a deleted recording refuses
 * - A recording cannot be deleted while a request for it runs, including work
 *   that began after the deletion was confirmed
 * - A transformation is edited in its own draft: a save keeps unknown fields
 *   and the person's own lines; a row that does not read is named for repair
 *   and repaired as text
 * - Two asks for the same transcript and transformation at once are one
 *   request and one result, while another pair and a later run stay separate;
 *   a row run again twice at once is sent once
 */
import type { WhisperingContext } from './folder.js';
import {
	closeTestWhispering,
	createTestWhispering,
	headerLine,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import {
	openText,
	settle,
	transcriptEditor,
	transformationEditor,
} from './edits.test-support.js';
import { quiet } from './query.test-support.js';
import {
	deferred,
	eventually,
	openTestServices,
	replaceTables,
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

async function open(options: TestServicesOptions = {}) {
	const test = await openTestServices(options);
	const { whispering, context } = await createTestWhispering(test);
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await test.remove();
	});
	await whispering.start();
	return { whispering, context, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** A recording with one saved transcript, and the transcript's bytes on disk. */
async function transcribed(
	whispering: Whispering,
	context: WhisperingContext,
	root: string,
) {
	await whispering.startRecording();
	await whispering.stopRecording();
	await quiet(context);
	const recording = whispering.entries[0]!;
	await whispering.transcribe(recording);
	await quiet(context);
	const transcript = whispering.resultsFor(recording.stem)[0]!;
	const transcriptBytes = await readFile(join(root, transcript.path));
	return {
		recording,
		transcript,
		transcriptBytes,
		transcriptText: new TextDecoder().decode(transcriptBytes),
	};
}

/** Create the cleanup starter and give it a model, as a person would before running it. */
async function cleanupProfile(
	whispering: Whispering,
	context: WhisperingContext,
) {
	expect(await whispering.createTransformation(CLEANUP)).toBeUndefined();
	const session = await transformationEditor(whispering);
	session.edit((row) => {
		row.fields.model = 'chat-model';
	});
	await settle(whispering, context);
	return session;
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
	const { context, whispering } = await open();
	const editor = await cleanupProfile(whispering, context);
	editor.edit((row) => {
		row.fields.model = 'other-model';
	});
	await settle(whispering, context);

	await whispering.createTransformation({
		title: 'Summarize',
		prompt: 'Sum.\n',
	});

	const created = whispering.selectedTransformation!.entry!;
	expect(created.row.fields).toEqual({ title: 'Summarize', model: null });
});

test('editing a transformation keeps fields the app does not know and the person’s own lines', async () => {
	const { context, whispering, root } = await open();
	await mkdir(join(root, 'transformations'));
	const source =
		'---\n# a comment\ntitle: Mine\nmodel: chat-model\ntemperature: 0.2\n---\nOriginal prompt\n';
	const path = join(root, 'transformations', 'mine.md');
	await writeFile(path, source);
	await settle(whispering, context);
	whispering.open('transformations/mine.md');
	const editor = await transformationEditor(whispering);
	// Opening reads; it writes nothing.
	expect(whispering.isSaving(editor.path)).toBe(false);
	expect(await readFile(path, 'utf8')).toBe(source);

	editor.edit((row) => {
		row.fields.title = 'Renamed';
		row.body = 'A new prompt\n';
	});
	await settle(whispering, context);

	const written = await readFile(path, 'utf8');
	const row = expectOk(
		await context.folder.tables.transformations.get('mine'),
	)!;
	expect<Record<string, unknown>>(row.fields).toEqual({
		title: 'Renamed',
		model: 'chat-model',
		temperature: 0.2,
	});
	expect(row.body).toBe('A new prompt\n');
	// A field the app does not declare is kept, and so is the person's comment.
	expect(written).toContain('temperature: 0.2');
	expect(written).toContain('# a comment');
	expect(await whispering.rename(editor.path, 'other.md')).toContain(
		'named by its ID',
	);
});

test('a transformation that does not read is named for repair, cannot run, and is repaired as text', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	await mkdir(join(root, 'transformations'));
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	const path = 'transformations/broken.md';
	await writeFile(join(root, path), broken);
	await settle(whispering, context);

	expect(whispering.transformations).toEqual([]);
	expect(whispering.transformationRepairs.map((item) => item.path)).toEqual([
		path,
	]);
	whispering.open(path);
	expect(whispering.showsText(path)).toBe(true);
	const text = await openText(whispering, context, path);
	expect(text.draft).toBe(broken);
	expect(await whispering.transform(transcript.path, path)).toBe(
		'Repair this transformation before running it.',
	);
	expect(transformed).toHaveLength(0);
	expect(await readFile(join(root, path), 'utf8')).toBe(broken);

	text.input(
		'---\ntitle: Repaired\nmodel: chat-model\nmood: curious\n---\nStill here\n',
	);
	await settle(whispering, context);
	expect(whispering.transformations.map((item) => item.path)).toEqual([path]);
	expect(await whispering.transform(transcript.path, path)).toBeUndefined();
	expect(transformed).toHaveLength(1);
	// Repaired, it is edited as fields again, with its unknown field kept.
	expect(await whispering.useForm(path)).toBeUndefined();
	expect((await transformationEditor(whispering)).draft.fields).toMatchObject({
		title: 'Repaired',
		mood: 'curious',
	});
});

// ============================================================================
// Applying a transformation
// ============================================================================

test('applying a transformation writes a new result row and leaves the transcript untouched', async () => {
	const { context, whispering, root, transformed } = await open();
	const { recording, transcript, transcriptBytes } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	const profile = whispering.transformations[0]!;

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();
	await quiet(context);

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

test('a transformation uses held instructions while their explicit publication finishes', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	editor.edit((row) => {
		row.body = 'Edited just now.\n';
	});
	expect(whispering.isSaving(editor.path)).toBe(true);

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	expect(whispering.isSaving(editor.path)).toBe(false);
	expect(transformed[0]!.prompt).toBe('Edited just now.\n');
	expect(await readFile(join(root, editor.path), 'utf8')).toContain(
		'Edited just now.',
	);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.fields.prompt).toBe(
		'Edited just now.\n',
	);
});

test('a transformation with no instructions, or a transcript with no text, sends nothing', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(
		whispering,
		context,
		root,
	);
	await whispering.createTransformation({ title: 'Empty', prompt: '' });
	const editor = await transformationEditor(whispering);

	expect(await whispering.transform(transcript.path, editor.path)).toBe(
		'Write instructions to run this.',
	);
	editor.edit((row) => {
		row.body = 'Fix it.\n';
	});
	await writeFile(
		join(root, transcript.path),
		transcriptText.replace(transcript.row.body, ' \n'),
	);
	expectOk(await context.folder.files.edit(transcript.path).refresh());
	expect(await whispering.transform(transcript.path, editor.path)).toContain(
		'no text',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

// ============================================================================
// The folder's current files decide what is sent
// ============================================================================

test('an observed outside transcript edit is sent without rewriting its source', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	// Another program rewrites the transcript and adds a field.
	await settle(whispering, context);
	const outside = transcriptText
		.replace('---\n', '---\nreviewedBy: someone\n')
		.replace(transcript.row.body, 'A steady tone, corrected by hand.\n');
	await writeFile(join(root, transcript.path), outside);
	expect(
		whispering.resultsFor(transcript.row.fields.recordingId)[0]!.row.body,
	).toBe('um so a steady tone\n');
	expectOk(await context.folder.files.edit(transcript.path).refresh());

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();
	await quiet(context);

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

test('invalid acquired transcript source refuses even after its file is deleted', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	// Settle the list now, so what it shows below is known to predate the outside changes.
	await settle(whispering, context);

	const broken = '---\nrecordingId: *missing\n---\nStill some text\n';
	await writeFile(join(root, transcript.path), broken);
	expectOk(await context.folder.files.edit(transcript.path).refresh());
	expect(await whispering.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(broken);

	await rm(join(root, transcript.path));
	// The list still shows the transcript: nothing has refreshed it.
	expect(whispering.resultsFor(transcript.row.fields.recordingId)).toHaveLength(
		1,
	);
	expect(await whispering.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transcript whose recording was deleted outside refuses', async () => {
	const { context, whispering, root, transformed } = await open();
	const { recording, transcript } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	await settle(whispering, context);
	await rm(join(root, recording.path));
	await rm(join(root, recording.path.replace(/\.md$/, '.wav')));
	// The list still shows the recording: nothing has refreshed it.
	expect(whispering.entries).toHaveLength(1);

	expect(await whispering.transform(transcript.path, editor.path)).toBe(
		'The recording this transcript was made from is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(whispering.recipeRuns).toHaveLength(0);
});

/** A transcript's file opened from Files, as its view edits it. */
async function openedTranscript(whispering: Whispering, path: string) {
	whispering.open(path);
	return await transcriptEditor(whispering, path);
}

test('a transformation captures accepted transcript input without publishing it', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const recipe = await cleanupProfile(whispering, context);
	const edit = context.folder.tables.transcriptions.edit(transcript.stem);
	expectOk(await edit.refresh());
	const before = await readFile(join(root, transcript.path), 'utf8');
	expectOk(edit.change({ body: 'Accepted in memory.\n' }));
	expect(
		await whispering.transform(transcript.path, recipe.path),
	).toBeUndefined();
	expect(transformed[0]?.input).toBe('Accepted in memory.\n');
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(before);
	expect(edit.getSnapshot().isDirty).toBe(true);
});

test('a transformation captures failed transcript input without retrying its publication', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	const source = await openedTranscript(whispering, transcript.path);
	const before = await readFile(join(root, transcript.path), 'utf8');
	chmodSync(join(root, 'transcriptions'), 0o555);
	try {
		source.edit((row) => {
			row.body = 'Mine.\n';
		});
		await settle(whispering, context);
	} finally {
		chmodSync(join(root, 'transcriptions'), 0o755);
	}
	// The typing is kept, and the transcript says it did not save.
	expect(whispering.isUnsaved(transcript.path)).toBe(true);
	expect(source.draft.body).toBe('Mine.\n');

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]?.input).toBe('Mine.\n');
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(before);
	expect(whispering.edit(transcript.path).saveError).toBeDefined();
});

// ============================================================================
// Deleting a recording while work for it runs
// ============================================================================

/**
 * The state of the newest result made from `transcriptionId`, once the
 * reads its row's saves started have landed.
 */
async function newestResult(
	whispering: Whispering,
	context: WhisperingContext,
	transcriptionId: string,
) {
	await quiet(context);
	const output = whispering.outputsFor(transcriptionId)[0]!;
	return {
		output,
		state: whispering.resultState(output.path, output.row.body),
	};
}

test('a recording cannot be deleted while a transformation of it runs, including one started after confirming', async () => {
	const answer =
		deferred<Awaited<ReturnType<Whispering['services']['transform']>>>();
	const started = deferred<void>();
	const { context, whispering, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { recording, transcript } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	// The person is asked, and agrees, before any request exists.
	const confirmed = expectOk(await whispering.deletionFor(recording.path));

	const running = whispering.transform(transcript.path, editor.path);
	await started.promise;
	expect(
		(await newestResult(whispering, context, transcript.stem)).state.kind,
	).toBe('running');

	// Asking now refuses, and so does the deletion already confirmed.
	const { error: refusal } = await whispering.deletionFor(recording.path);
	expect(refusal).toContain('still running');
	expect(await whispering.delete(confirmed)).toContain('still running');
	expect(
		[
			...(await names(root, 'recordings')),
			...(await names(root, 'audio')),
		].sort(),
	).toEqual([`${recording.stem}.md`, `${recording.stem}.wav`]);

	answer.resolve(Ok({ text: 'arrived' }));
	await running;

	// The result written since was never named to the person, so they are asked again.
	expect(await whispering.delete(confirmed)).toContain('after you were asked');
	expect(await names(root, RUNS)).toHaveLength(1);
	const again = expectOk(await whispering.deletionFor(recording.path));
	expect(again).toMatchObject({ kind: 'recording' });
	expect(await whispering.delete(again!)).toBeUndefined();
	// The row and the results are gone. The audio is an ordinary file and stays.
	expect(
		(await names(root, 'recordings')).filter((path) => path.endsWith('.md')),
	).toEqual([]);
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run does not block deletion, and its row goes with the recording', async () => {
	const { context, whispering, root, transformed } = await open({
		transform: async () =>
			TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
	});
	const { recording, transcript } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	await whispering.transform(transcript.path, editor.path);
	const { output, state } = await newestResult(
		whispering,
		context,
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
	const { context, whispering, root, transformed } = await open();
	const { recording, transcript } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
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
	const { context, whispering, root } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	await whispering.transform(transcript.path, editor.path);
	const output = whispering.outputsFor(transcript.stem)[0]!;
	const result = await readFile(join(root, output.path), 'utf8');

	editor.edit((row) => {
		row.fields.title = 'Renamed';
		row.body = 'A different prompt.\n';
	});
	await settle(whispering, context);
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
	const { context, whispering, root } = await open();
	const { recording, transcript } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
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
	const answer =
		deferred<Awaited<ReturnType<Whispering['services']['transform']>>>();
	const started = deferred<void>();
	const { context, whispering, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);

	const running = whispering.transform(transcript.path, editor.path);
	await started.promise;

	const { output, state } = await newestResult(
		whispering,
		context,
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
		(await newestResult(whispering, context, transcript.stem)).state.kind,
	).toBe('answered');
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe('done\n');
});

test('a refused request leaves its row unfinished; running it again sends the same request into the same row', async () => {
	let attempts = 0;
	const { context, whispering, root, transformed } = await open({
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
	const { transcript, transcriptBytes } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);

	expect(
		await whispering.transform(transcript.path, editor.path),
	).toBeUndefined();

	const { output, state } = await newestResult(
		whispering,
		context,
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
		(await newestResult(whispering, context, transcript.stem)).state,
	).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});

	expect(await whispering.runAgain(output.path)).toBeUndefined();
	await quiet(context);

	expect(transformed).toHaveLength(3);
	expect(transformed[2]).toEqual(transformed[0]!);
	const filled = whispering.outputsFor(transcript.stem);
	expect(filled.map((item) => item.stem)).toEqual([output.stem]);
	expect(filled[0]!.row.fields).toEqual(output.row.fields);
	expect(filled[0]!.row.body).toBe('Third try: um so a steady tone\n');
});

test('running again sends what the row holds, not what the transcript holds now', async () => {
	let refuse = true;
	const { context, whispering, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: input }),
	});
	const { transcript, transcriptText } = await transcribed(
		whispering,
		context,
		root,
	);
	const editor = await cleanupProfile(whispering, context);
	await whispering.transform(transcript.path, editor.path);
	const { output } = await newestResult(whispering, context, transcript.stem);
	refuse = false;
	await writeFile(
		join(root, transcript.path),
		transcriptText.replace(transcript.row.body, 'Different now.\n'),
	);

	expect(await whispering.runAgain(output.path)).toBeUndefined();
	await quiet(context);

	expect(transformed.map((request) => request.input)).toEqual([
		'um so a steady tone\n',
		'um so a steady tone\n',
	]);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'um so a steady tone\n',
	);
});

test('an answer whose write fails is written again while the page lives', async () => {
	const { context, whispering, root, transformed, failures } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	await settle(whispering, context);
	failures.answers = 2;

	await whispering.transform(transcript.path, editor.path);

	expect(
		(await newestResult(whispering, context, transcript.stem)).state,
	).toMatchObject({
		kind: 'writing',
		text: 'Transformed: um so a steady tone',
		message: expect.stringContaining('disk refused the result'),
	});
	expect(headerLine(whispering).label).toBe('1 answer not written yet');

	await eventually(() => whispering.unwrittenAnswers === 0);
	await settle(whispering, context);

	expect(transformed).toHaveLength(1);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'Transformed: um so a steady tone\n',
	);
	expect(headerLine(whispering).tone).toBe('good');
});

test('an answer replaces the current body, and an answer for an already deleted row writes nothing', async () => {
	const answers = [
		deferred<Awaited<ReturnType<Whispering['services']['transform']>>>(),
		deferred<Awaited<ReturnType<Whispering['services']['transform']>>>(),
	];
	const { context, whispering, root, transformed } = await open({
		transform: () => answers[transformed.length - 1]!.promise,
	});
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);

	const first = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = await newestResult(whispering, context, transcript.stem);
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
	await settle(whispering, context);
	const discarded = whispering
		.outputsFor(transcript.stem)
		.find((item) => item.stem !== output.stem)!;
	expect(
		await whispering.deleteTransformationResult(discarded),
	).toBeUndefined();
	answers[1]!.resolve(Ok({ text: 'too late' }));
	await second;

	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(whispering.unwrittenAnswers).toBe(0);
});

/**
 * Run a transformation whose result row someone fills by hand with `typed`
 * right after the fill reads it empty. Answers the file afterwards.
 */
async function fillRace(typed: string) {
	const answer =
		deferred<Awaited<ReturnType<Whispering['services']['transform']>>>();
	const { context, whispering, root, folder, transformed } = await open({
		transform: () => answer.promise,
	});
	const { transcript } = await transcribed(whispering, context, root);
	const editor = await cleanupProfile(whispering, context);
	const running = whispering.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = await newestResult(whispering, context, transcript.stem);
	const path = join(root, output.path);
	const table = folder.tables.transformation_runs;
	const get = table.get;
	let filled = false;
	(table as { get: typeof get }).get = async (stem) => {
		const read = await get(stem);
		if (stem === output.stem && !filled) {
			filled = true;
			await writeFile(path, `${await readFile(path, 'utf8')}${typed}`);
		}
		return read;
	};

	answer.resolve(Ok({ text: 'from the endpoint' }));
	await running;
	await settle(whispering, context);

	expect(filled).toBe(true);
	expect(whispering.unwrittenAnswers).toBe(0);
	return {
		text: await readFile(path, 'utf8'),
		shown: whispering.outputsFor(transcript.stem)[0]?.row.body,
	};
}

test('answer publication replaces a body written between its read and publication', async () => {
	const { text, shown } = await fillRace('Typed by hand.\n');
	expect(text).not.toContain('Typed by hand.\n');
	expect(text).toEndWith('from the endpoint\n');
	expect(shown).toBe('from the endpoint\n');
});

test('an answer that someone filled with the same text between its read and its write is in the body once', async () => {
	const { shown } = await fillRace('from the endpoint\n');
	expect(shown).toBe('from the endpoint\n');
});

// ============================================================================
// One run for one ask
// ============================================================================

/** Wait until `condition` holds: work runs through the mutation cache, a few turns later. */
async function until(condition: () => boolean) {
	for (let tries = 0; tries < 500 && !condition(); tries++) await Bun.sleep(2);
	expect(condition()).toBe(true);
}

/**
 * A whispering whose reads of one table's rows wait while `reads.hold` is set.
 * A run reads its transformation and its transcript before anything is sent,
 * so holding those reads is what puts two asks inside that time together.
 */
async function openHoldingReads(
	held: 'transformations' | 'transformation_runs',
	options: TestServicesOptions = {},
) {
	const test = await openTestServices(options);
	const reads: { hold?: Promise<void>; waiting: number } = { waiting: 0 };
	const { tables } = test.folder;
	const table = tables[held];
	const { whispering, context } = await createTestWhispering({
		folder: replaceTables(test.folder, {
			[held]: {
				...table,
				async get(stem: string) {
					reads.waiting += 1;
					await reads.hold;
					return table.get(stem);
				},
			},
		}),
		services: {
			...test.services,
		},
	});
	cleanups.push(async () => {
		await closeTestWhispering({ whispering, context });
		await test.remove();
	});
	await whispering.start();
	return { whispering, context, reads, ...test };
}

test('two asks for the same transcript and transformation at once send one request and write one result; another pair and a later run are separate', async () => {
	const { whispering, context, root, transformed, reads } =
		await openHoldingReads('transformations');
	const { transcript, transcriptBytes } = await transcribed(
		whispering,
		context,
		root,
	);
	const cleanup = await cleanupProfile(whispering, context);
	expect(
		await whispering.createTransformation(STARTER_TRANSFORMATIONS[1]!),
	).toBeUndefined();
	const summarize = await transformationEditor(whispering);
	summarize.edit((row) => {
		row.fields.model = 'chat-model';
	});
	await settle(whispering, context);
	const reading = deferred<void>();
	reads.hold = reading.promise;

	const first = whispering.transform(transcript.path, cleanup.path);
	const second = whispering.transform(transcript.path, cleanup.path);
	const other = whispering.transform(transcript.path, summarize.path);

	// The second ask is refused while the first is still reading: nothing has been sent yet.
	expect(await second).toContain('already running on this transcript');
	expect(transformed).toEqual([]);
	reads.hold = undefined;
	reading.resolve();
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
	const { whispering, context, root, transformed, reads } =
		await openHoldingReads('transformation_runs', {
			transform: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('the folder host went away');
				return Ok({ text: 'after the host came back' });
			},
		});
	const { transcript } = await transcribed(whispering, context, root);
	const cleanup = await cleanupProfile(whispering, context);
	await whispering.transform(transcript.path, cleanup.path);
	const { output, state } = await newestResult(
		whispering,
		context,
		transcript.stem,
	);
	expect(state.kind).toBe('failed');
	const reading = deferred<void>();
	reads.hold = reading.promise;
	reads.waiting = 0;

	const again = Promise.all([
		whispering.runAgain(output.path),
		whispering.runAgain(output.path),
	]);
	await until(() => reads.waiting > 0);
	reads.hold = undefined;
	reading.resolve();
	const answers = await again;

	// One run again read the row; the other was refused while it did.
	expect(answers).toContain('This is already running.');
	expect(transformed).toHaveLength(2);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	await quiet(context);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'after the host came back\n',
	);
});

test('a transformation uses clean retained recipe and transcript source without recreating their deleted files', async () => {
	const { context, whispering, root, transformed } = await open();
	const { transcript } = await transcribed(whispering, context, root);
	const recipe = await cleanupProfile(whispering, context);
	const input = context.folder.tables.transcriptions.edit(transcript.stem);
	const instructions = context.folder.files.edit(recipe.path);
	expectOk(await input.refresh());
	expectOk(await instructions.refresh());
	const capturedInput = input.getSnapshot().content?.body;
	const capturedPrompt = instructions.getSnapshot().content?.body;
	await rm(join(root, transcript.path));
	await rm(join(root, recipe.path));
	expect(
		await whispering.transform(transcript.path, recipe.path),
	).toBeUndefined();
	expect(transformed).toHaveLength(1);
	expect(transformed[0]?.input).toBe(capturedInput);
	expect(transformed[0]?.prompt).toBe(capturedPrompt);
	expect(await Bun.file(join(root, transcript.path)).exists()).toBe(false);
	expect(await Bun.file(join(root, recipe.path)).exists()).toBe(false);
	expect(input.getSnapshot().isDirty).toBe(false);
	expect(instructions.getSnapshot().isDirty).toBe(false);
});
