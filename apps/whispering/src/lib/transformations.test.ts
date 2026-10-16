/**
 * Transformation workflow tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with a fixture capture device and stubbed transcription and chat endpoints.
 * No window, provider, key, or network is involved, so these establish the
 * workflow's logic and what it leaves on disk, not that a provider accepts the
 * request.
 *
 * Key behaviors:
 * - Nothing is seeded: a transformation exists only after it is created
 * - A transformation is an ordinary Markdown row: title, model, and endpoint in
 *   frontmatter, the prompt as its body
 * - Applying one writes a new result row and never writes the transcript
 * - A result carries the prompt and text that were sent, so it outlives edits
 *   to, and deletion of, its transformation
 * - A request that fails ends the run, keeps the transcript, and can be retried
 * - A result that cannot be saved keeps its text and its file name; saving it
 *   again does not call the endpoint and cannot make a second result; a row at
 *   that name counts as this result only if its body and every field match,
 *   fields another writer added included
 * - What is sent is read from the folder when asked: an outside edit is sent,
 *   a deleted or malformed transcript or a deleted recording refuses
 * - A recording cannot be deleted while a request for it runs or its answer is
 *   unsaved, including work that began after the deletion was confirmed
 * - A transformation is edited in its own draft: a save writes the whole row
 *   and keeps unknown fields; a row that does not read is named for repair
 *   and repaired as text
 * - Two asks for the same transcript and transformation at once are one
 *   request and one result, while another pair and a later run stay separate;
 *   a run retried or saved again twice at once is retried or saved once
 * - A run discarded while it is saved or retried stays discarded: a failed
 *   save does not restore it, a retry does not send it, and a row already
 *   being written may land and is counted by a deletion
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { STARTER_TRANSFORMATIONS } from './definition.js';
import {
	textSession,
	transcriptSession,
	transformationSession,
} from './drafts.test-support.js';
import type { Library } from './library.svelte.js';
import { filesLineOf } from './status.js';
import { TransformationError } from './transformation.js';
import {
	deferred,
	openTestWorkspace,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const RUNS = 'transformation_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;

async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const library = createLibrary(test.workspace);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** A recording with one saved transcript, and the transcript's bytes on disk. */
async function transcribed(library: Library, root: string) {
	await library.startRecording();
	await library.stopRecording();
	const recording = library.entries[0]!;
	await library.transcribe(recording);
	const transcript = library.resultsFor(recording.stem)[0]!;
	const transcriptBytes = await readFile(join(root, transcript.path));
	return {
		recording,
		transcript,
		transcriptBytes,
		transcriptText: new TextDecoder().decode(transcriptBytes),
	};
}

/** Create the cleanup starter and give it a model, as a person would before running it. */
async function cleanupProfile(library: Library) {
	expect(await library.createTransformation(CLEANUP)).toBeUndefined();
	const session = transformationSession(library);
	session.edit((row) => {
		row.fields.model = 'chat-model';
	});
	expect((await session.settled()).status).toBe('saved');
	return session;
}

// ============================================================================
// Transformation files
// ============================================================================

test('opening a folder seeds no transformation; creating one writes an ordinary Markdown row', async () => {
	const { library, root } = await open();
	expect(library.transformations).toHaveLength(0);
	expect(await names(root, 'transformations')).toEqual([]);

	expect(await library.createTransformation(CLEANUP)).toBeUndefined();

	expect(library.transformations).toHaveLength(1);
	const entry = library.transformations[0]!;
	expect(library.selectedTransformationPath).toBe(entry.path);
	const source = await readFile(join(root, entry.path), 'utf8');
	// A new recipe names no model or endpoint: it runs with the text connection.
	expect(entry.row.fields).toEqual({
		title: 'Clean up',
		model: null,
		endpoint: null,
	});
	expect(source).toContain('model: null\nendpoint: null\n');
	expect(entry.row.body).toBe(CLEANUP.prompt);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a new transformation copies no endpoint or model from another one', async () => {
	const { library } = await open();
	const editor = await cleanupProfile(library);
	editor.edit((row) => {
		row.fields.endpoint = 'http://127.0.0.1:11434/v1';
	});
	await editor.settled();
	await library.refresh();

	await library.createTransformation({ title: 'Summarize', prompt: 'Sum.\n' });

	const created = library.selectedTransformation!.entry!;
	expect(created.row.fields).toEqual({
		title: 'Summarize',
		model: null,
		endpoint: null,
	});
});

test('editing a transformation saves the whole row in one form and keeps fields the app does not know', async () => {
	const { library, root } = await open();
	await mkdir(join(root, 'transformations'));
	const source =
		'---\n# a comment\ntitle: Mine\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\ntemperature: 0.2\n---\nOriginal prompt\n';
	const path = join(root, 'transformations', 'mine.md');
	await writeFile(path, source);
	await library.open('transformations/mine.md');
	const editor = transformationSession(library);
	// Opening reads; it writes nothing, and a file in another form is not unsaved.
	expect(editor.state.status).toBe('saved');
	expect(await readFile(path, 'utf8')).toBe(source);

	editor.edit((row) => {
		row.fields.title = 'Renamed';
		row.body = 'A new prompt\n';
	});
	expect((await editor.settled()).status).toBe('saved');

	const written = await readFile(path, 'utf8');
	const row = expectOk(
		await library.folder.tables.transformations.get('mine'),
	)!;
	expect<Record<string, unknown>>(row.row.fields).toEqual({
		title: 'Renamed',
		model: 'chat-model',
		endpoint: 'http://127.0.0.1:18080/v1',
		temperature: 0.2,
	});
	expect(row.row.body).toBe('A new prompt\n');
	// A field the app does not declare is kept; a comment is not part of the row.
	expect(written).toContain('temperature: 0.2');
	expect(written).not.toContain('# a comment');
	expect(await library.rename(editor.path, 'other.md')).toContain(
		'named by its ID',
	);
});

test('a transformation that does not read is named for repair, cannot run, and is repaired as text', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	await mkdir(join(root, 'transformations'));
	const broken = '---\ntitle: *missing\nmood: curious\n---\nStill here\n';
	const path = 'transformations/broken.md';
	await writeFile(join(root, path), broken);
	await library.refreshAll();

	expect(library.transformations).toEqual([]);
	expect(library.transformationRepairs.map((item) => item.path)).toEqual([
		path,
	]);
	await library.open(path);
	const text = textSession(library, path);
	expect(text.draft).toBe(broken);
	expect(await library.transform(transcript.path, path)).toBe(
		'Repair this transformation before running it.',
	);
	expect(transformed).toHaveLength(0);
	expect(await readFile(join(root, path), 'utf8')).toBe(broken);

	text.input(
		'---\ntitle: Repaired\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\nmood: curious\n---\nStill here\n',
	);
	expect((await text.settled()).status).toBe('saved');
	await library.refresh();
	expect(library.transformations.map((item) => item.path)).toEqual([path]);
	expect(await library.transform(transcript.path, path)).toBeUndefined();
	expect(transformed).toHaveLength(1);
	// Repaired, it is edited as fields again, with its unknown field kept.
	expect(await library.useForm(path)).toBeUndefined();
	expect(transformationSession(library).draft.fields).toMatchObject({
		title: 'Repaired',
		mood: 'curious',
	});
});

// ============================================================================
// Applying a transformation
// ============================================================================

test('applying a transformation writes a new result row and leaves the transcript untouched', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript, transcriptBytes } = await transcribed(
		library,
		root,
	);
	const editor = await cleanupProfile(library);
	const profile = library.transformations[0]!;

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	// Prepared for the text connection; the recipe's own model is used.
	expect(transformed).toEqual([
		{
			expectedBaseUrl: 'http://127.0.0.1:18080/v1',
			model: 'chat-model',
			prompt: CLEANUP.prompt,
			input: 'um so a steady tone\n',
		},
	]);
	expect(library.transformationRuns).toHaveLength(0);
	const outputs = library.outputsFor(transcript.stem);
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
	expect(library.outputsOf(profile.stem)).toEqual(outputs);
	// The original transcript is the same bytes, and still the only transcript.
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
	expect(await names(root, 'transcriptions')).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);

	// The result is an ordinary file in ordinary history.
	const committed = await library.commit();
	expect(['committed', 'unchanged']).toContain(committed.status);
	const tree = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], {
		cwd: root,
		encoding: 'utf8',
	});
	expect(tree).toContain(output.path);
	expect(tree).toContain(profile.path);
});

test('what is sent is the saved transformation: a save still running settles first', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	editor.edit((row) => {
		row.body = 'Edited just now.\n';
	});
	expect(editor.state.status).toBe('saving');

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(editor.state.status).toBe('saved');
	expect(transformed[0]!.prompt).toBe('Edited just now.\n');
	expect(await readFile(join(root, editor.path), 'utf8')).toContain(
		'Edited just now.',
	);
	expect(library.outputsFor(transcript.stem)[0]!.row.fields.prompt).toBe(
		'Edited just now.\n',
	);
});

test('a transformation with no instructions, or a transcript with no text, sends nothing', async () => {
	const { library, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(library, root);
	await library.createTransformation({ title: 'Empty', prompt: '' });
	const editor = transformationSession(library);

	expect(await library.transform(transcript.path, editor.path)).toBe(
		'Write instructions to run this.',
	);
	editor.edit((row) => {
		row.body = 'Fix it.\n';
	});
	await writeFile(
		join(root, transcript.path),
		transcriptText.replace(transcript.row.body, ' \n'),
	);
	expect(await library.transform(transcript.path, editor.path)).toContain(
		'no text',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

// ============================================================================
// The folder's current files decide what is sent
// ============================================================================

test('a transcript edited outside is sent as the folder has it now, and is not rewritten', async () => {
	const { library, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// Another program rewrites the transcript and adds a field. No refresh follows.
	await library.refresh();
	const outside = transcriptText
		.replace('---\n', '---\nreviewedBy: someone\n')
		.replace(transcript.row.body, 'A steady tone, corrected by hand.\n');
	await writeFile(join(root, transcript.path), outside);
	expect(
		library.resultsFor(transcript.row.fields.recordingId)[0]!.row.body,
	).toBe('um so a steady tone\n');

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]!.input).toBe('A steady tone, corrected by hand.\n');
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.row.fields.input).toBe('A steady tone, corrected by hand.\n');
	expect(output.row.body).toBe(
		'Transformed: A steady tone, corrected by hand.\n',
	);
	// The transcript is exactly what the other program wrote, unknown field included.
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(outside);
});

test('a transcript deleted or broken outside refuses, and nothing stale is sent', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// Settle the list now, so what it shows below is known to predate the outside changes.
	await library.refresh();

	const broken = '---\nrecordingId: *missing\n---\nStill some text\n';
	await writeFile(join(root, transcript.path), broken);
	expect(await library.transform(transcript.path, editor.path)).toContain(
		'needs repair',
	);
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(broken);

	await rm(join(root, transcript.path));
	// The list still shows the transcript: nothing has refreshed it.
	expect(library.resultsFor(transcript.row.fields.recordingId)).toHaveLength(1);
	expect(await library.transform(transcript.path, editor.path)).toBe(
		'This transcript is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transcript whose recording was deleted outside refuses', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.refresh();
	await rm(join(root, recording.path));
	await rm(join(root, recording.row.fields.audioPath));
	// The list still shows the recording: nothing has refreshed it.
	expect(library.entries).toHaveLength(1);

	expect(await library.transform(transcript.path, editor.path)).toBe(
		'The recording this transcript was made from is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
});

/** The draft Files opens for a transcript's file. */
async function transcriptEditor(library: Library, path: string) {
	await library.open(path);
	return transcriptSession(library, path);
}

test('a save of the transcript’s file still running settles first, then what it saved is sent', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const source = await transcriptEditor(library, transcript.path);
	source.edit((row) => {
		row.body = 'Typed in Files.\n';
	});
	expect(source.state.status).toBe('saving');

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(source.state.status).toBe('saved');
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed in Files.',
	);
	expect(transformed[0]!.input).toBe('Typed in Files.\n');
});

test('a transcript whose save failed refuses, and the edits stay in its editor', async () => {
	const { library, root, transformed } = await open();
	const { transcript, transcriptText } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const source = await transcriptEditor(library, transcript.path);
	chmodSync(join(root, 'transcriptions'), 0o555);
	try {
		source.edit((row) => {
			row.body = 'Mine.\n';
		});
		expect((await source.settled()).status).toBe('error');
	} finally {
		chmodSync(join(root, 'transcriptions'), 0o755);
	}

	expect(await library.transform(transcript.path, editor.path)).toContain(
		'has edits that are not saved',
	);

	expect(transformed).toHaveLength(0);
	expect(source.draft.body).toBe('Mine.\n');
	expect(source.state.status).toBe('error');
	expect(await readFile(join(root, transcript.path), 'utf8')).toBe(
		transcriptText,
	);
});

// ============================================================================
// Deleting a recording while work for it is held
// ============================================================================

test('a recording cannot be deleted while a transformation of it runs, including one started after confirming', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const started = deferred<void>();
	const { library, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	// The person is asked, and agrees, before any request exists.
	const confirmed = expectOk(await library.deletionFor(recording.path));

	const running = library.transform(transcript.path, editor.path);
	await started.promise;
	expect(library.transformationRuns[0]!.state.kind).toBe('running');

	// Asking now refuses, and so does the deletion already confirmed.
	const { error: refusal } = await library.deletionFor(recording.path);
	expect(refusal).toContain('still running');
	expect(await library.remove(confirmed)).toContain('still running');
	expect((await names(root, 'recordings')).sort()).toEqual([
		`${recording.stem}.md`,
		`${recording.stem}.wav`,
	]);

	answer.resolve(Ok({ text: 'arrived' }));
	await running;

	// The result saved since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await names(root, RUNS)).toHaveLength(1);
	const again = expectOk(await library.deletionFor(recording.path));
	expect(again).toMatchObject({ kind: 'recording' });
	expect(await library.remove(again!)).toBeUndefined();
	// The row and the results are gone. The audio is an ordinary file and stays.
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a recording cannot be deleted while a received result for it is unsaved; discarding it allows the deletion', async () => {
	const { library, root } = await open({ failRunWrites: 1 });
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const confirmed = expectOk(await library.deletionFor(recording.path));
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');

	const { error: refusal } = await library.deletionFor(recording.path);
	expect(refusal).toContain('Save it again or discard it');
	expect(await library.remove(confirmed!)).toContain(
		'Save it again or discard it',
	);
	expect(await names(root, 'recordings')).toHaveLength(2);
	// The text is still held, exactly.
	expect(library.transformationRuns[0]!).toEqual(held);

	library.discardTransformationRun(held.id);
	expect(await library.remove(confirmed!)).toBeUndefined();

	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run does not block deletion and is dropped with the recording', async () => {
	const { library, root, transformed } = await open({
		transform: async () =>
			TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
	});
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');

	const deletion = expectOk(await library.deletionFor(recording.path));
	expect(await library.remove(deletion!)).toBeUndefined();

	// Nothing is left that could be retried against the deleted recording.
	expect(library.transformationRuns).toHaveLength(0);
	await library.retryTransformation(failed.id);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run is not sent again once its recording or transcript text is gone from the folder', async () => {
	let refuse = true;
	const { library, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: input }),
	});
	const { recording, transcript, transcriptText } = await transcribed(
		library,
		root,
	);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const failed = library.transformationRuns[0]!;
	refuse = false;

	// The transcript changes outside: the old request is not what the folder holds.
	await writeFile(
		join(root, transcript.path),
		transcriptText.replace(transcript.row.body, 'Different now.\n'),
	);
	await library.retryTransformation(failed.id);
	expect(library.transformationRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('transcript changed'),
	});

	// The recording is deleted outside the app.
	await rm(join(root, recording.path));
	await rm(join(root, recording.row.fields.audioPath));
	await library.retryTransformation(failed.id);
	expect(library.transformationRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('no longer in the folder'),
	});

	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transformation asked for while its recording is being deleted sends nothing', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const deletion = expectOk(await library.deletionFor(recording.path));

	const removing = library.remove(deletion!);
	const problem = await library.transform(transcript.path, editor.path);
	expect(await removing).toBeUndefined();

	expect(problem).toMatch(/being deleted|no longer in the folder/);
	expect(transformed).toHaveLength(0);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a result outlives edits to its transformation and the transformation’s deletion', async () => {
	const { library, root } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const output = library.outputsFor(transcript.stem)[0]!;
	const result = await readFile(join(root, output.path), 'utf8');

	editor.edit((row) => {
		row.fields.title = 'Renamed';
		row.body = 'A different prompt.\n';
	});
	await editor.settled();
	await library.refreshAll();
	expect(await readFile(join(root, output.path), 'utf8')).toBe(result);

	const deletion = expectOk(await library.deletionFor(editor.path));
	expect(deletion).toMatchObject({ kind: 'transformation', results: 1 });
	expect(await library.remove(deletion!)).toBeUndefined();

	expect(library.transformations).toHaveLength(0);
	expect(library.selectedTransformation).toBeUndefined();
	expect(await names(root, 'transformations')).toEqual([]);
	expect(await readFile(join(root, output.path), 'utf8')).toBe(result);
	const kept = library.outputsFor(transcript.stem)[0]!;
	expect(kept.row.fields.transformationTitle).toBe('Clean up');
	expect(kept.row.fields.prompt).toBe(CLEANUP.prompt);
});

test('deleting a recording removes the results made from its transcripts', async () => {
	const { library, root } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	expect(await names(root, RUNS)).toHaveLength(1);

	const deletion = expectOk(await library.deletionFor(recording.path));
	expect(deletion).toMatchObject({ kind: 'recording' });
	expect(await library.remove(deletion!)).toBeUndefined();

	expect(await names(root, RUNS)).toEqual([]);
	expect(await names(root, 'transcriptions')).toEqual([]);
	// The transformation itself is not the recording's.
	expect(library.transformations).toHaveLength(1);
});

// ============================================================================
// Failures
// ============================================================================

test('a refused request ends the run as failed, keeps the transcript, and retries under the same id', async () => {
	let attempts = 0;
	const { library, root, transformed } = await open({
		transform: async ({ input }) => {
			attempts += 1;
			if (attempts === 1)
				return TransformationError.Rejected({
					url: 'http://127.0.0.1:18080/v1/chat/completions',
					status: 429,
					detail: 'slow down',
				});
			return Ok({ text: `Second try: ${input.trim()}` });
		},
	});
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(library.transformationRuns).toHaveLength(1);
	const failed = library.transformationRuns[0]!;
	expect(failed.state).toEqual({
		kind: 'failed',
		message: 'The endpoint answered 429: slow down',
	});
	expect(library.outputsFor(transcript.stem)).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
	// Nothing was received, so nothing is held and nothing blocks closing.
	expect(library.holdsUnsavedWork).toBe(false);

	await library.retryTransformation(failed.id);

	expect(transformed).toHaveLength(2);
	expect(transformed[1]).toEqual(transformed[0]!);
	expect(library.transformationRuns).toHaveLength(0);
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.stem).toBe(failed.id);
	expect(output.row.fields.createdAt).toBe(failed.fields.createdAt);
	expect(output.row.body).toBe('Second try: um so a steady tone\n');
});

test('a transport that throws is a failed run that can be retried, never one left running', async () => {
	let attempts = 0;
	const { library, root } = await open({
		transform: async () => {
			attempts += 1;
			if (attempts === 1) throw new Error('the folder host went away');
			return Ok({ text: 'after the host came back' });
		},
	});
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	await library.transform(transcript.path, editor.path);

	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');
	if (failed.state.kind === 'failed')
		expect(failed.state.message).toContain('the folder host went away');

	await library.retryTransformation(failed.id);

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'after the host came back\n',
	);
});

test('a running transformation is reported as held until it answers', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root } = await open({ transform: () => answer.promise });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	const running = library.transform(transcript.path, editor.path);
	await new Promise((resolve) => setTimeout(resolve, 20));

	expect(library.transformationRuns[0]!.state.kind).toBe('running');
	expect(library.holdsUnsavedWork).toBe(true);

	answer.resolve(Ok({ text: 'done' }));
	await running;

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a result that cannot be saved keeps its text and id; saving again does not call the endpoint', async () => {
	const { library, root, transformed } = await open({ failRunWrites: 2 });
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.commit();
	await library.refreshAll();
	expect(filesLineOf(library).tone).toBe('good');

	await library.transform(transcript.path, editor.path);

	expect(transformed).toHaveLength(1);
	const held = library.transformationRuns[0]!;
	expect(held.state).toMatchObject({
		kind: 'unsaved',
		text: 'Transformed: um so a steady tone',
	});
	expect(library.unsavedTransformations).toBe(1);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(filesLineOf(library)).toMatchObject({
		tone: 'error',
		label: '1 transformation result not saved',
	});
	expect(await names(root, RUNS)).toEqual([]);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);

	// A second failed save changes nothing about what is held.
	await library.retryTransformation(held.id);
	const again = library.transformationRuns[0]!;
	expect(again.id).toBe(held.id);
	expect(again.fields).toEqual(held.fields);
	expect(again.state).toMatchObject({
		kind: 'unsaved',
		text: 'Transformed: um so a steady tone',
	});

	await library.retryTransformation(held.id);

	// One request in total, one file, under the id fixed when the run began.
	expect(transformed).toHaveLength(1);
	expect(library.transformationRuns).toHaveLength(0);
	expect(library.unsavedTransformations).toBe(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(filesLineOf(library).tone).toBe('good');
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	const output = library.outputsFor(transcript.stem)[0]!;
	expect(output.stem).toBe(held.id);
	expect(output.row.fields.createdAt).toBe(held.fields.createdAt);
	expect(output.row.body).toBe('Transformed: um so a steady tone\n');
});

test('a save that landed but was reported failed is recognized, not written twice', async () => {
	const { library, root, transformed } = await open({ loseRunWriteAnswers: 1 });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	await library.transform(transcript.path, editor.path);

	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	const landed = await readFile(join(root, RUNS, `${held.id}.md`), 'utf8');

	await library.retryTransformation(held.id);

	expect(transformed).toHaveLength(1);
	expect(library.transformationRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(await readFile(join(root, RUNS, `${held.id}.md`), 'utf8')).toBe(
		landed,
	);
	expect(library.outputsFor(transcript.stem)).toHaveLength(1);
});

test('another file at the result’s path is never overwritten', async () => {
	const { library, root } = await open({ failRunWrites: 1 });
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	await mkdir(join(root, RUNS), { recursive: true });
	const squatter = '---\ntitle: not a result\n---\nSomeone else wrote this\n';
	await writeFile(join(root, RUNS, `${held.id}.md`), squatter);

	await library.retryTransformation(held.id);

	const still = library.transformationRuns[0]!;
	expect(still.state.kind).toBe('unsaved');
	if (still.state.kind === 'unsaved') {
		expect(still.state.message).toContain('Nothing was overwritten');
		expect(still.state.text).toBe('Transformed: um so a steady tone');
	}
	expect(await readFile(join(root, RUNS, `${held.id}.md`), 'utf8')).toBe(
		squatter,
	);
});

/** A run whose answer arrived and whose row was not written, with the table that can write rows. */
async function heldRun() {
	const opened = await open({ failRunWrites: 1 });
	const { library, root, workspace } = opened;
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	if (held.state.kind !== 'unsaved') throw new Error('expected an unsaved run');
	return {
		...opened,
		held,
		text: held.state.text,
		table: workspace.folder.tables.transformation_runs,
	};
}

// Same path, same body, same time, same transcript: only one snapshot field differs.
for (const [field, value] of [
	['prompt', 'A different prompt.\n'],
	['input', 'a different transcript\n'],
	['model', 'another-model'],
	['endpoint', 'http://127.0.0.1:9/v1'],
	['recordingId', '20200101-000000-zzzz'],
	['transformationId', 'another-transformation'],
	['transformationTitle', 'Another title'],
] as const) {
	test(`a row at the result’s path that differs only in ${field} is not this result and is left alone`, async () => {
		const { library, root, table, held, text, transformed } = await heldRun();
		const other = await table.create(
			{
				fields: { ...held.fields, [field]: value } as typeof held.fields,
				body: `${text}\n`,
			},
			{ stem: held.id },
		);
		expectOk(other);
		const path = join(root, RUNS, `${held.id}.md`);
		const theirs = await readFile(path, 'utf8');

		await library.retryTransformation(held.id);

		const still = library.transformationRuns[0]!;
		expect(still.id).toBe(held.id);
		expect(still.fields).toEqual(held.fields);
		expect(still.state).toMatchObject({
			kind: 'unsaved',
			text,
			message: expect.stringContaining('Nothing was overwritten'),
		});
		expect(await readFile(path, 'utf8')).toBe(theirs);
		expect(library.holdsUnsavedWork).toBe(true);
		expect(transformed).toHaveLength(1);
	});
}

test('this run’s exact row is recognized, and the same row with a field another writer added is not', async () => {
	const { library, root, table, held, text, transformed, workspace } =
		await heldRun();
	const mine = expectOk(
		await table.create(
			{ fields: held.fields, body: `${text}\n` },
			{ stem: held.id },
		),
	);
	const path = join(RUNS, `${held.id}.md`);
	const exact = await readFile(join(root, path), 'utf8');
	// Another program adds a field without touching what the run recorded.
	const annotated = exact.replace('---\n', '---\nreviewedBy: someone\n');
	expectOk(await workspace.folder.files.replace(mine, annotated));

	await library.retryTransformation(held.id);

	const still = library.transformationRuns[0]!;
	expect(still.state).toMatchObject({
		kind: 'unsaved',
		message: expect.stringContaining('Nothing was overwritten'),
	});
	expect(await readFile(join(root, path), 'utf8')).toBe(annotated);

	// The exact row, as an earlier save left it, is this result.
	await writeFile(join(root, path), exact);
	await library.retryTransformation(held.id);

	expect(library.transformationRuns).toHaveLength(0);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(await readFile(join(root, path), 'utf8')).toBe(exact);
});

// ============================================================================
// One run for one ask
// ============================================================================

/**
 * A library whose reads of one table's rows wait while `reads.hold` is set.
 * A run reads its transformation and its transcript before anything is sent,
 * so holding those reads is what puts two asks inside that time together.
 */
async function openHoldingReads(
	held: 'transformations' | 'transcriptions',
	options: TestWorkspaceOptions = {},
) {
	const test = await openTestWorkspace(options);
	const reads: { hold?: Promise<void>; waiting: number } = { waiting: 0 };
	const { tables } = test.workspace.folder;
	const table = tables[held];
	const library = createLibrary({
		...test.workspace,
		folder: {
			...test.workspace.folder,
			tables: {
				...tables,
				[held]: {
					...table,
					async get(stem: string) {
						reads.waiting += 1;
						await reads.hold;
						return table.get(stem);
					},
				},
			},
		} as Library['workspace']['folder'],
	});
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, reads, ...test };
}

test('two asks for the same transcript and transformation at once send one request and save one result; another pair and a later run are separate', async () => {
	const { library, root, transformed, reads } =
		await openHoldingReads('transformations');
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const cleanup = await cleanupProfile(library);
	expect(
		await library.createTransformation(STARTER_TRANSFORMATIONS[1]!),
	).toBeUndefined();
	const summarize = transformationSession(library);
	summarize.edit((row) => {
		row.fields.model = 'chat-model';
	});
	expect((await summarize.settled()).status).toBe('saved');
	const reading = deferred<void>();
	reads.hold = reading.promise;

	const first = library.transform(transcript.path, cleanup.path);
	const second = library.transform(transcript.path, cleanup.path);
	const other = library.transform(transcript.path, summarize.path);

	// The second ask is refused while the first is still reading: nothing has been sent yet.
	expect(await second).toContain('already running on this transcript');
	expect(transformed).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(true);
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
	expect(library.transformationRuns).toEqual([]);

	// Asked again once the first has ended, it runs again and is its own result.
	expect(
		await library.transform(transcript.path, cleanup.path),
	).toBeUndefined();
	expect(transformed).toHaveLength(3);
	expect(await names(root, RUNS)).toHaveLength(3);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
});

test('a failed run retried twice at once is sent once more, not twice', async () => {
	let attempts = 0;
	const { library, root, transformed, reads } = await openHoldingReads(
		'transcriptions',
		{
			transform: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('the folder host went away');
				return Ok({ text: 'after the host came back' });
			},
		},
	);
	const { transcript } = await transcribed(library, root);
	const cleanup = await cleanupProfile(library);
	await library.transform(transcript.path, cleanup.path);
	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');
	const reading = deferred<void>();
	reads.hold = reading.promise;
	reads.waiting = 0;

	const retries = Promise.all([
		library.retryTransformation(failed.id),
		library.retryTransformation(failed.id),
	]);
	await Promise.resolve();
	// One retry is reading the transcript; the other was left to it.
	expect(reads.waiting).toBe(1);
	reads.hold = undefined;
	reading.resolve();
	await retries;

	expect(transformed).toHaveLength(2);
	expect(await names(root, RUNS)).toEqual([`${failed.id}.md`]);
	expect(library.transformationRuns).toEqual([]);
	expect(library.outputsFor(transcript.stem)).toHaveLength(1);
});

test('a received result saved again twice at once is written once and is not left unsaved', async () => {
	const { library, root, transformed } = await open({ failRunWrites: 1 });
	const { transcript } = await transcribed(library, root);
	const cleanup = await cleanupProfile(library);
	await library.transform(transcript.path, cleanup.path);
	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');

	await Promise.all([
		library.retryTransformation(held.id),
		library.retryTransformation(held.id),
	]);

	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(library.transformationRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

// ============================================================================
// A run discarded while it is being saved or retried
// ============================================================================

/**
 * A library whose result-row reads, writes, and listings first run the hook
 * the test sets for them. A hook can hold the call, throw, or, for a listing,
 * answer in its place.
 */
async function openHookedRuns(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const { tables } = test.workspace.folder;
	const runs = tables.transformation_runs;
	type Listed = Awaited<ReturnType<typeof runs.list>>;
	const hooks: {
		get?: () => Promise<void>;
		create?: () => Promise<void>;
		list?: () => Promise<Listed | undefined>;
	} = {};
	const library = createLibrary({
		...test.workspace,
		folder: {
			...test.workspace.folder,
			tables: {
				...tables,
				transformation_runs: {
					...runs,
					async get(stem: string) {
						await hooks.get?.();
						return runs.get(stem);
					},
					async create(...args: Parameters<typeof runs.create>) {
						await hooks.create?.();
						return runs.create(...args);
					},
					async list() {
						return (await hooks.list?.()) ?? runs.list();
					},
				},
			},
		} as Library['workspace']['folder'],
	});
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, hooks, ...test };
}

/** A call held until the test lets it go: `reached` settles once it is waiting. */
function holdCall() {
	const reached = deferred<void>();
	const released = deferred<void>();
	return {
		reached: reached.promise,
		release: () => released.resolve(),
		async wait() {
			reached.resolve();
			await released.promise;
		},
	};
}

/** A received result that was not saved, with a recording and a transformation to go with it. */
async function unsavedRun(options: TestWorkspaceOptions) {
	const opened = await openHookedRuns(options);
	const { library, root } = opened;
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const confirmed = expectOk(await library.deletionFor(recording.path));
	await library.transform(transcript.path, editor.path);
	const held = library.transformationRuns[0]!;
	expect(held.state.kind).toBe('unsaved');
	return { ...opened, recording, confirmed, held };
}

test('a result discarded while its save is under way is not restored when the save throws', async () => {
	const { library, root, hooks, held, transformed } = await unsavedRun({
		failRunWrites: 1,
	});
	const reading = holdCall();
	hooks.create = async () => {
		await reading.wait();
		throw new Error('the folder host went away');
	};

	const saving = library.retryTransformation(held.id);
	await reading.reached;
	library.discardTransformationRun(held.id);
	expect(library.transformationRuns).toEqual([]);
	reading.release();
	await saving;

	// The dropped text stays dropped, and nothing was sent again.
	expect(library.transformationRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a result discarded while its row is being written is not restored when the write fails, and its recording waits for the write', async () => {
	const { library, root, hooks, recording, confirmed, held, transformed } =
		await unsavedRun({ failRunWrites: 2 });
	const writing = holdCall();
	hooks.create = () => writing.wait();

	const saving = library.retryTransformation(held.id);
	await writing.reached;
	library.discardTransformationRun(held.id);
	expect(library.transformationRuns).toEqual([]);
	// The write already begun could still land a row naming the recording.
	const { error: refusal } = await library.deletionFor(recording.path);
	expect(refusal).toContain('still being written');
	expect(await library.remove(confirmed)).toContain('still being written');
	writing.release();
	await saving;

	expect(library.transformationRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(transformed).toHaveLength(1);
	expect(await names(root, RUNS)).toEqual([]);
	// With the write refused nothing names the recording, so it can go.
	expect(await library.remove(confirmed)).toBeUndefined();
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
});

test('a result discarded while its row is being written leaves only the file when the write lands, and a deletion counts it', async () => {
	const { library, root, hooks, recording, confirmed, held, transformed } =
		await unsavedRun({ failRunWrites: 1 });
	const writing = holdCall();
	hooks.create = () => writing.wait();
	// The listing after the write does not see it yet, as when that read fails.
	hooks.list = async () =>
		FileError.Io({
			path: RUNS,
			operation: 'list',
			cause: new Error('the listing could not be read'),
		});

	const saving = library.retryTransformation(held.id);
	await writing.reached;
	library.discardTransformationRun(held.id);
	writing.release();
	await saving;

	// The row landed under the id fixed when the run began; no run came back.
	expect(await names(root, RUNS)).toEqual([`${held.id}.md`]);
	expect(library.transformationRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(transformed).toHaveLength(1);
	hooks.list = undefined;

	// The deletion confirmed before the row existed did not name it, so it is refused.
	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await names(root, 'recordings')).toHaveLength(2);
	// Asked again, the person is told of the row, and it goes with the recording.
	const again = expectOk(await library.deletionFor(recording.path));
	expect(
		again.kind === 'recording' && again.results.map((result) => result.path),
	).toContain(`${RUNS}/${held.id}.md`);
	expect(await library.remove(again)).toBeUndefined();
	expect(await names(root, RUNS)).toEqual([]);
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
});

test('a failed run discarded while its retry reads the transcript sends nothing and is not restored', async () => {
	const { library, root, transformed, reads } = await openHoldingReads(
		'transcriptions',
		{
			transform: async () =>
				TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
		},
	);
	const { transcript } = await transcribed(library, root);
	const cleanup = await cleanupProfile(library);
	await library.transform(transcript.path, cleanup.path);
	const failed = library.transformationRuns[0]!;
	expect(failed.state.kind).toBe('failed');
	const reading = deferred<void>();
	reads.hold = reading.promise;
	reads.waiting = 0;

	const retry = library.retryTransformation(failed.id);
	await Promise.resolve();
	expect(reads.waiting).toBe(1);
	library.discardTransformationRun(failed.id);
	reads.hold = undefined;
	reading.resolve();
	await retry;

	expect(transformed).toHaveLength(1);
	expect(library.transformationRuns).toEqual([]);
	expect(await names(root, RUNS)).toEqual([]);
});
