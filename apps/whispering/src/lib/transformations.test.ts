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
 * - A run's result row is written with every field and an empty body before
 *   the request goes out, and its body is filled when the answer arrives
 *   (ADR-0542)
 * - A request that fails leaves its row unfinished, keeps the transcript, and
 *   runs again from the row's own fields into the same row
 * - An answer whose write fails is written again while the page lives; a row
 *   filled or deleted meanwhile is not written
 * - A body someone fills between an answer's read and its write stays beside
 *   the answer; the same text is in the body once
 * - What is sent is read from the folder when asked: an outside edit is sent,
 *   a deleted or malformed transcript or a deleted recording refuses
 * - A recording cannot be deleted while a request for it runs, including work
 *   that began after the deletion was confirmed
 * - A transformation is edited in its own draft: a save writes the whole row
 *   and keeps unknown fields; a row that does not read is named for repair
 *   and repaired as text
 * - Two asks for the same transcript and transformation at once are one
 *   request and one result, while another pair and a later run stay separate;
 *   a row run again twice at once is sent once
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import type { Library, WriteNotice } from './library.svelte.js';
import { createQueryClient } from './query.test-support.js';
import { filesLine } from './status.js';
import { TransformationError } from './transformation.js';
import {
	deferred,
	eventually,
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
	const library = createLibrary(test.workspace, createQueryClient());
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
	const session = transformationEditor(library);
	session.edit((row) => {
		row.fields.model = 'chat-model';
	});
	await settle(library);
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
	await settle(library);

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
	await settle(library);
	await library.open('transformations/mine.md');
	const editor = transformationEditor(library);
	// Opening reads; it writes nothing.
	expect(library.isSaving(editor.path)).toBe(false);
	expect(await readFile(path, 'utf8')).toBe(source);

	editor.edit((row) => {
		row.fields.title = 'Renamed';
		row.body = 'A new prompt\n';
	});
	await settle(library);

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
	await settle(library);

	expect(library.transformations).toEqual([]);
	expect(library.transformationRepairs.map((item) => item.path)).toEqual([
		path,
	]);
	await library.open(path);
	expect(library.showsText(path)).toBe(true);
	const text = await openText(library, path);
	expect(text.draft).toBe(broken);
	expect(await library.transform(transcript.path, path)).toBe(
		'Repair this transformation before running it.',
	);
	expect(transformed).toHaveLength(0);
	expect(await readFile(join(root, path), 'utf8')).toBe(broken);

	text.input(
		'---\ntitle: Repaired\nmodel: chat-model\nendpoint: http://127.0.0.1:18080/v1\nmood: curious\n---\nStill here\n',
	);
	await settle(library);
	expect(library.transformations.map((item) => item.path)).toEqual([path]);
	expect(await library.transform(transcript.path, path)).toBeUndefined();
	expect(transformed).toHaveLength(1);
	// Repaired, it is edited as fields again, with its unknown field kept.
	expect(await library.useForm(path)).toBeUndefined();
	expect(transformationEditor(library).draft.fields).toMatchObject({
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
	expect(library.recipeRuns).toHaveLength(0);
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
	const committed = await library.saveVersion();
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
	expect(library.isSaving(editor.path)).toBe(true);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(library.isSaving(editor.path)).toBe(false);
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
	const editor = transformationEditor(library);

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
	expect(library.recipeRuns).toHaveLength(0);
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
	await settle(library);
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
	await settle(library);

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
	expect(library.recipeRuns).toHaveLength(0);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a transcript whose recording was deleted outside refuses', async () => {
	const { library, root, transformed } = await open();
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await settle(library);
	await rm(join(root, recording.path));
	await rm(join(root, recording.row.fields.audioPath));
	// The list still shows the recording: nothing has refreshed it.
	expect(library.entries).toHaveLength(1);

	expect(await library.transform(transcript.path, editor.path)).toBe(
		'The recording this transcript was made from is no longer in the folder.',
	);

	expect(transformed).toHaveLength(0);
	expect(library.recipeRuns).toHaveLength(0);
});

/** A transcript's file opened from Files, as its view edits it. */
async function openedTranscript(library: Library, path: string) {
	await library.open(path);
	return transcriptEditor(library, path);
}

test('a save of the transcript’s file still running settles first, then what it saved is sent', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const source = await openedTranscript(library, transcript.path);
	source.edit((row) => {
		row.body = 'Typed in Files.\n';
	});
	expect(library.isSaving(source.path)).toBe(true);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(library.isSaving(source.path)).toBe(false);
	expect(await readFile(join(root, transcript.path), 'utf8')).toContain(
		'Typed in Files.',
	);
	expect(transformed[0]!.input).toBe('Typed in Files.\n');
});

test('a transcript whose save failed keeps the edit, and a run saves it before it sends', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const notices: WriteNotice[] = [];
	library.onWriteNotice((notice) => notices.push(notice));
	const source = await openedTranscript(library, transcript.path);
	chmodSync(join(root, 'transcriptions'), 0o555);
	try {
		source.edit((row) => {
			row.body = 'Mine.\n';
		});
		await settle(library);
	} finally {
		chmodSync(join(root, 'transcriptions'), 0o755);
	}
	expect(notices).toMatchObject([
		{ kind: 'failed', path: transcript.path, lost: undefined },
	]);
	expect(source.draft.body).toBe('Mine.\n');

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	expect(transformed).toHaveLength(1);
	expect(transformed[0]?.input).toBe('Mine.\n');
	expect(await readFile(join(root, transcript.path), 'utf8')).toEndWith(
		'---\nMine.\n',
	);
});

// ============================================================================
// Deleting a recording while work for it runs
// ============================================================================

/** The state of the newest result made from `transcriptionId`. */
function newestResult(library: Library, transcriptionId: string) {
	const output = library.outputsFor(transcriptionId)[0]!;
	return {
		output,
		state: library.resultState(output.path, output.row.body),
	};
}

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
	expect(newestResult(library, transcript.stem).state.kind).toBe('running');

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

	// The result written since was never named to the person, so they are asked again.
	expect(await library.remove(confirmed)).toContain('after you were asked');
	expect(await names(root, RUNS)).toHaveLength(1);
	const again = expectOk(await library.deletionFor(recording.path));
	expect(again).toMatchObject({ kind: 'recording' });
	expect(await library.remove(again!)).toBeUndefined();
	// The row and the results are gone. The audio is an ordinary file and stays.
	expect(await names(root, 'recordings')).toEqual([`${recording.stem}.wav`]);
	expect(await names(root, RUNS)).toEqual([]);
});

test('a failed run does not block deletion, and its row goes with the recording', async () => {
	const { library, root, transformed } = await open({
		transform: async () =>
			TransformationError.Unreachable({ url: 'http://x', reason: 'down' }),
	});
	const { recording, transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const { output, state } = newestResult(library, transcript.stem);
	expect(state.kind).toBe('failed');

	const deletion = expectOk(await library.deletionFor(recording.path));
	expect(await library.remove(deletion!)).toBeUndefined();

	// Nothing is left that could be run again against the deleted recording.
	expect(await library.runAgain(output.path)).toContain(
		'no longer in the folder',
	);
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
	expect(library.recipeRuns).toEqual([]);
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
	await settle(library);
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
// A run's row, from its start
// ============================================================================

test('a run’s row is in the folder from its start with every field and no body, and holds nothing in the window', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const started = deferred<void>();
	const { library, root } = await open({
		transform: () => {
			started.resolve();
			return answer.promise;
		},
	});
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	const running = library.transform(transcript.path, editor.path);
	await started.promise;

	const { output, state } = newestResult(library, transcript.stem);
	expect(state.kind).toBe('running');
	expect(output.row.body).toBe('');
	expect(output.row.fields).toMatchObject({
		transcriptionId: transcript.stem,
		prompt: CLEANUP.prompt,
		input: 'um so a steady tone\n',
	});
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(library.recipeRuns).toHaveLength(1);

	answer.resolve(Ok({ text: 'done' }));
	await running;

	expect(library.recipeRuns).toEqual([]);
	expect(newestResult(library, transcript.stem).state.kind).toBe('answered');
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe('done\n');
});

test('a refused request leaves its row unfinished; running it again sends the same request into the same row', async () => {
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
			if (attempts === 2) throw new Error('the folder host went away');
			return Ok({ text: `Third try: ${input.trim()}` });
		},
	});
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	expect(await library.transform(transcript.path, editor.path)).toBeUndefined();

	const { output, state } = newestResult(library, transcript.stem);
	expect(state).toEqual({
		kind: 'failed',
		message: 'The endpoint answered 429: slow down',
	});
	expect(output.row.body).toBe('');
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);

	// A transport that throws is a failure too, never a run left running.
	expect(await library.runAgain(output.path)).toBeUndefined();
	expect(newestResult(library, transcript.stem).state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining('the folder host went away'),
	});

	expect(await library.runAgain(output.path)).toBeUndefined();

	expect(transformed).toHaveLength(3);
	expect(transformed[2]).toEqual(transformed[0]!);
	const filled = library.outputsFor(transcript.stem);
	expect(filled.map((item) => item.stem)).toEqual([output.stem]);
	expect(filled[0]!.row.fields).toEqual(output.row.fields);
	expect(filled[0]!.row.body).toBe('Third try: um so a steady tone\n');
});

test('running again sends what the row holds, not what the transcript holds now', async () => {
	let refuse = true;
	const { library, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: input }),
	});
	const { transcript, transcriptText } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.transform(transcript.path, editor.path);
	const { output } = newestResult(library, transcript.stem);
	refuse = false;
	await writeFile(
		join(root, transcript.path),
		transcriptText.replace(transcript.row.body, 'Different now.\n'),
	);

	expect(await library.runAgain(output.path)).toBeUndefined();

	expect(transformed.map((request) => request.input)).toEqual([
		'um so a steady tone\n',
		'um so a steady tone\n',
	]);
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'um so a steady tone\n',
	);
});

test('an answer whose write fails is written again while the page lives', async () => {
	const { library, root, transformed, failures } = await open();
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	await library.saveVersion();
	await settle(library);
	failures.answers = 2;

	await library.transform(transcript.path, editor.path);

	expect(newestResult(library, transcript.stem).state).toMatchObject({
		kind: 'writing',
		text: 'Transformed: um so a steady tone',
		message: expect.stringContaining('disk refused the result'),
	});
	expect(filesLine(library).label).toBe('1 answer not written yet');

	await eventually(() => library.unwrittenAnswers === 0);
	await settle(library);

	expect(transformed).toHaveLength(1);
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'Transformed: um so a steady tone\n',
	);
	expect(filesLine(library).tone).toBe('good');
});

test('an answer for a row someone filled meanwhile stands after their text, and one for a row deleted meanwhile writes nothing', async () => {
	const answers = [
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>(),
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>(),
	];
	const { library, root, transformed } = await open({
		transform: () => answers[transformed.length - 1]!.promise,
	});
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);

	const first = library.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = newestResult(library, transcript.stem);
	const path = join(root, output.path);
	await writeFile(
		path,
		(await readFile(path, 'utf8')).replace(/---\n$/, '---\nTyped by hand.\n'),
	);
	answers[0]!.resolve(Ok({ text: 'from the endpoint' }));
	await first;
	const filled = await readFile(path, 'utf8');
	expect(filled).toContain('---\nTyped by hand.\n');
	expect(filled.indexOf('from the endpoint')).toBeGreaterThan(
		filled.indexOf('Typed by hand.'),
	);

	const second = library.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 2);
	await settle(library);
	const discarded = library
		.outputsFor(transcript.stem)
		.find((item) => item.stem !== output.stem)!;
	expect(await library.deleteTransformationResult(discarded)).toBeUndefined();
	answers[1]!.resolve(Ok({ text: 'too late' }));
	await second;

	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(library.unwrittenAnswers).toBe(0);
});

/**
 * Run a transformation whose result row someone fills by hand with `typed`
 * right after the fill reads it empty. Answers the file afterwards.
 */
async function fillRace(typed: string) {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root, workspace, transformed } = await open({
		transform: () => answer.promise,
	});
	const { transcript } = await transcribed(library, root);
	const editor = await cleanupProfile(library);
	const running = library.transform(transcript.path, editor.path);
	await eventually(() => transformed.length === 1);
	const { output } = newestResult(library, transcript.stem);
	const path = join(root, output.path);
	const table = workspace.folder.tables.transformation_runs;
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
	await settle(library);

	expect(filled).toBe(true);
	expect(library.unwrittenAnswers).toBe(0);
	return {
		text: await readFile(path, 'utf8'),
		shown: library.outputsFor(transcript.stem)[0]?.row.body,
	};
}

test('an answer and a different body someone filled between its read and its write both stay', async () => {
	const { text, shown } = await fillRace('Typed by hand.\n');
	expect(text).toContain('Typed by hand.\n');
	expect(text).toContain('from the endpoint\n');
	expect(shown).toContain('Typed by hand.\n');
	expect(shown).toContain('from the endpoint\n');
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
 * A library whose reads of one table's rows wait while `reads.hold` is set.
 * A run reads its transformation and its transcript before anything is sent,
 * so holding those reads is what puts two asks inside that time together.
 */
async function openHoldingReads(
	held: 'transformations' | 'transformation_runs',
	options: TestWorkspaceOptions = {},
) {
	const test = await openTestWorkspace(options);
	const reads: { hold?: Promise<void>; waiting: number } = { waiting: 0 };
	const { tables } = test.workspace.folder;
	const table = tables[held];
	const library = createLibrary(
		{
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
		},
		createQueryClient(),
	);
	cleanups.push(async () => {
		await library.close();
		await test.remove();
	});
	await library.start();
	return { library, reads, ...test };
}

test('two asks for the same transcript and transformation at once send one request and write one result; another pair and a later run are separate', async () => {
	const { library, root, transformed, reads } =
		await openHoldingReads('transformations');
	const { transcript, transcriptBytes } = await transcribed(library, root);
	const cleanup = await cleanupProfile(library);
	expect(
		await library.createTransformation(STARTER_TRANSFORMATIONS[1]!),
	).toBeUndefined();
	const summarize = transformationEditor(library);
	summarize.edit((row) => {
		row.fields.model = 'chat-model';
	});
	await settle(library);
	const reading = deferred<void>();
	reads.hold = reading.promise;

	const first = library.transform(transcript.path, cleanup.path);
	const second = library.transform(transcript.path, cleanup.path);
	const other = library.transform(transcript.path, summarize.path);

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
	expect(library.recipeRuns).toEqual([]);

	// Asked again once the first has ended, it runs again and is its own result.
	expect(
		await library.transform(transcript.path, cleanup.path),
	).toBeUndefined();
	expect(transformed).toHaveLength(3);
	expect(await names(root, RUNS)).toHaveLength(3);
	expect(await readFile(join(root, transcript.path))).toEqual(transcriptBytes);
});

test('a failed run run again twice at once is sent once more, not twice', async () => {
	let attempts = 0;
	const { library, root, transformed, reads } = await openHoldingReads(
		'transformation_runs',
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
	const { output, state } = newestResult(library, transcript.stem);
	expect(state.kind).toBe('failed');
	const reading = deferred<void>();
	reads.hold = reading.promise;
	reads.waiting = 0;

	const again = Promise.all([
		library.runAgain(output.path),
		library.runAgain(output.path),
	]);
	await until(() => reads.waiting > 0);
	reads.hold = undefined;
	reading.resolve();
	const answers = await again;

	// One run again read the row; the other was refused while it did.
	expect(answers).toContain('This is already running.');
	expect(transformed).toHaveLength(2);
	expect(await names(root, RUNS)).toEqual([`${output.stem}.md`]);
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe(
		'after the host came back\n',
	);
});
