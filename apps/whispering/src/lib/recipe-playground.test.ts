/**
 * Recipe and pasted-text playground tests
 *
 * Drives the real product state against a real directory, opened as the
 * folder mirror, with stubbed endpoints that decide the connection as the
 * host does and count every request that would go out. No window, provider,
 * key, or network is involved.
 *
 * Key behaviors:
 * - One resolver decides whether a recipe runs and with what; the Run check,
 *   the post-processing choice, the transcript menu, and the run agree
 * - A new recipe names no model and runs with the text connection; a
 *   recipe's model overrides the connection's
 * - A recipe runs on pasted text with no recordings in the folder; its row is
 *   written to `text_runs/` when it starts, with the exact instructions,
 *   input, model, and endpoint, and filled when the answer arrives, with no
 *   separate Save (ADR-0542)
 * - A run sends the recipe as it is shown, typing included, and its row
 *   records exactly that; edits made while it is out change nothing written
 * - One running ask per recipe on pasted text; a later ask is a new row
 * - Discarding is deleting the row, and an answer that arrives after writes
 *   nothing
 * - A failed run runs again from its row only while the text connection is
 *   still the base URL the row names
 * - A run on pasted text never holds the app open; results on pasted text and
 *   on transcripts are listed apart; a malformed `text_runs/` file never holds
 *   up a recording's deletion
 */
import {
	closeTestWhispering,
	openTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { ConnectionInfo } from './connections.js';
import {
	STARTER_TRANSFORMATIONS,
	type TransformationFields,
} from './definition.js';
import type { WhisperingFolder } from './folder.js';
import { type RecipeRow, resolveRecipe } from './recipe.js';
import {
	deferred,
	eventually,
	openTestServices,
	settled,
	TEST_BASE_URL,
	type TestServicesOptions,
} from './services.test-support.js';
import { TransformationError } from './transformation.js';
import type { Whispering } from './whispering.svelte.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEXT_RUNS = 'text_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;
const PASTED = 'so um this is pasted text\n';

type Answer = Awaited<ReturnType<Whispering['services']['transform']>>;

/** Product state over a test services. */
async function open(options: TestServicesOptions = {}) {
	const test = await openTestServices(options);
	const { whispering } = await openTestWhispering(test);
	cleanups.push(async () => {
		closeTestWhispering({ whispering, folder: test.folder });
		await test.remove();
	});
	return { whispering, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** Create a recipe from a starter, as a person would, and return its path. */
async function recipe(whispering: Whispering, starter = CLEANUP) {
	expect(await whispering.createTransformation(starter)).toBeUndefined();
	return whispering.selectedTransformation!.path;
}

/** The stem of the selected recipe's file. */
const selectedStem = (whispering: Whispering) =>
	whispering.selectedTransformation!.path.slice('transformations/'.length, -3);

/** Write a recipe file with this model and these instructions. */
async function recipeFile(
	folder: WhisperingFolder,
	stem: string,
	{ model, body = 'Fix it.\n' }: { model: string; body?: string },
) {
	const path = `transformations/${stem}.md`;
	expectOk(
		await folder.write(path, `---\ntitle: Earlier\nmodel: ${model}\n---\n${body}`),
	);
	return path;
}

/** The recipe as its page shows it: the row's title, model, and instructions in their fields. */
function shownRecipe(
	folder: WhisperingFolder,
	path: string,
	change: Partial<{ title: string; model: string; body: string }> = {},
): RecipeRow {
	const row = folder.tables.transformations.row(path.slice(16, -3));
	if (row?.issues !== null) throw new Error(`${path} does not read`);
	const model = change.model ?? row.fields.model ?? '';
	return {
		fields: {
			title: change.title ?? row.fields.title,
			model: model.trim() || null,
		},
		body: change.body ?? row.body,
	};
}

/** A recording with one saved transcript. */
async function transcribed(whispering: Whispering, folder: WhisperingFolder) {
	await whispering.startRecording();
	await whispering.stopRecording();
	await settled(folder);
	const recording = whispering.entries[0]!;
	await whispering.transcribe(recording);
	await settled(folder);
	return { recording, transcript: whispering.resultsFor(recording.stem)[0]! };
}

// ============================================================================
// One decision about a recipe
// ============================================================================

const TEXT: ConnectionInfo = {
	baseUrl: TEST_BASE_URL,
	model: 'connection-model',
	keyPresent: false,
	readOnlyReason: undefined,
};
const reading = (fields: Record<string, unknown>, body = 'Fix it.\n') => ({
	// SAFETY: each case supplies the recipe fields it resolves.
	fields: fields as TransformationFields,
	body,
});

test('the resolver uses the text connection and lets a recipe name its model', () => {
	expect(resolveRecipe(reading({ title: 'New', model: null }), TEXT)).toEqual({
		kind: 'ready',
		title: 'New',
		prompt: 'Fix it.\n',
		model: 'connection-model',
		endpoint: TEST_BASE_URL,
	});
	// Blank is the same as null.
	expect(
		resolveRecipe(reading({ title: 'Old', model: ' ' }), TEXT),
	).toMatchObject({ kind: 'ready', model: 'connection-model' });
	expect(
		resolveRecipe(reading({ title: 'Own', model: 'gpt-4o-mini' }), TEXT),
	).toMatchObject({
		kind: 'ready',
		model: 'gpt-4o-mini',
		endpoint: TEST_BASE_URL,
	});
	expect(
		resolveRecipe(reading({ title: 'New', model: null }), undefined),
	).toEqual({
		kind: 'blocked',
		fix: 'connection',
		reason: 'Set up the text connection in Settings to run this.',
	});
	expect(
		resolveRecipe(
			reading({ title: 'New', model: null }),
			undefined,
			'disk refused',
		),
	).toMatchObject({
		kind: 'blocked',
		reason: expect.stringContaining('disk refused'),
	});
	expect(
		resolveRecipe(reading({ title: 'New', model: null }, ' \n'), TEXT),
	).toMatchObject({ reason: 'Write instructions to run this.' });
	expect(resolveRecipe(undefined, TEXT)).toMatchObject({
		reason: 'Repair this transformation before running it.',
	});
});

test('the Run check, the post-processing choice, the menu, and the run agree about every recipe', async () => {
	const { whispering, folder, transformed } = await open();
	const { transcript } = await transcribed(whispering, folder);
	const fresh = await recipe(whispering);
	const own = await recipeFile(folder, 'own', { model: 'old-model' });
	const blank = await recipeFile(folder, 'blank', {
		model: 'old-model',
		body: ' \n',
	});

	for (const path of [fresh, own, blank]) {
		const entry = whispering.transformations.find(
			(item) => item.path === path,
		)!;
		const listed = whispering.resolve(entry.row);
		// The recipe's page resolves what its fields show with the same resolver.
		const shown = whispering.resolve(shownRecipe(folder, path));
		whispering.view.postProcessing = path;
		const chosen = whispering.postProcessing;
		const before = transformed.length;
		const problem = await whispering.transform(transcript.path, path);

		expect(shown).toEqual(listed);
		expect(chosen.kind).toBe(listed.kind === 'ready' ? 'ready' : 'repair');
		if (listed.kind === 'ready') {
			expect(problem).toBeUndefined();
			expect(transformed.slice(before)).toEqual([
				{
					expectedBaseUrl: listed.endpoint,
					model: listed.model,
					prompt: listed.prompt,
					input: transcript.row.body,
				},
			]);
		} else {
			expect(problem).toBe(listed.reason);
			expect(transformed).toHaveLength(before);
		}
	}
	expect(transformed.map((request) => request.model)).toEqual([
		'connection-model',
		'old-model',
	]);
});

test('a result file and a recipe written by an earlier build still read and list', async () => {
	const { whispering, folder } = await open();
	const path = await recipeFile(folder, 'old', { model: 'old-model' });
	const old =
		'---\nrecordingId: 20250101-000000-abcd\ntranscriptionId: 20250101-000001-abcd\ntransformationId: old\ntransformationTitle: Earlier\ncreatedAt: 2025-01-01T00:00:02.000Z\nmodel: old-model\nendpoint: https://api.openai.com/v1\nprompt: Fix it.\ninput: some text\n---\nFixed text.\n';
	expectOk(await folder.write('transformation_runs/earlier.md', old));

	expect(whispering.transformations.map((item) => item.path)).toEqual([path]);
	expect(whispering.outputsOf('old').map((output) => output.row.body)).toEqual([
		'Fixed text.\n',
	]);
	expect(whispering.textOutputsOf('old')).toEqual([]);
});

// ============================================================================
// Pasted text
// ============================================================================

/**
 * The newest result on pasted text of the recipe `stem`, and what it shows,
 * once the saves under way have landed.
 */
async function newestText(
	whispering: Whispering,
	folder: WhisperingFolder,
	stem: string,
) {
	await settled(folder);
	const output = whispering.textOutputsOf(stem)[0]!;
	return {
		output,
		state: whispering.resultState(output.path, output.row.body),
	};
}

test('a recipe runs on pasted text with no recordings; its row is written to text_runs/ when it starts and filled when the answer arrives, with no Save', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, root, transformed } = await open({
		transform: () => answer.promise,
	});
	expect(whispering.entries).toEqual([]);
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);

	const running = whispering.transformText(path, PASTED);
	await eventually(() => transformed.length === 1);

	expect(transformed).toEqual([
		{
			expectedBaseUrl: TEST_BASE_URL,
			model: 'connection-model',
			prompt: CLEANUP.prompt,
			input: PASTED,
		},
	]);
	const { output, state } = await newestText(whispering, folder, stem);
	expect(state.kind).toBe('running');
	expect({ fields: output.row.fields, body: output.row.body }).toEqual({
		fields: {
			transformationId: stem,
			transformationTitle: 'Clean up',
			createdAt: expect.any(String),
			model: 'connection-model',
			endpoint: TEST_BASE_URL,
			prompt: CLEANUP.prompt,
			input: PASTED,
		},
		body: '',
	});
	expect(await names(root, TEXT_RUNS)).toEqual([`${output.stem}.md`]);

	answer.resolve(Ok({ text: 'Transformed: so um this is pasted text' }));
	expect(await running).toBeUndefined();

	const saved = whispering.textOutputsOf(stem);
	expect(saved.map((item) => item.stem)).toEqual([output.stem]);
	expect(saved[0]!.row.fields).toEqual(output.row.fields);
	expect(saved[0]!.row.body).toBe('Transformed: so um this is pasted text\n');
	// Results on pasted text are not transcript results, and name no recording.
	expect(whispering.outputsOf(stem)).toEqual([]);
	expect(whispering.transformationResults).toEqual([]);
	expect(Object.keys(saved[0]!.row.fields)).not.toContain('recordingId');
	expect(transformed).toHaveLength(1);

	// It is an ordinary file: deleting it works like any other result.
	expect(
		await whispering.delete(
			expectOk(await whispering.deletionFor(saved[0]!.path)),
		),
	).toBeUndefined();
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(whispering.textOutputsOf(stem)).toEqual([]);
});

test('a run sends the recipe as shown and records exactly that; edits to the recipe or the connection while it runs change nothing', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);
	// Typed into the page, and not saved yet.
	const shown = shownRecipe(folder, path, {
		title: 'Typed title',
		body: 'Draft instructions.\n',
	});

	const running = whispering.transformText(path, PASTED, { recipe: shown });
	await eventually(() => transformed.length === 1);
	expect(transformed[0]!.prompt).toBe('Draft instructions.\n');
	expect(folder.tables.transformations.row(stem)?.body).toBe(CLEANUP.prompt);
	expectOk(
		await folder.tables.transformations.update(stem, {
			fields: { model: 'other' },
			body: 'Edited while running.\n',
		}),
	);
	expect(
		await whispering.saveConnection('text', {
			baseUrl: TEST_BASE_URL,
			model: 'changed-default',
			key: { action: 'keep' },
		}),
	).toBeUndefined();
	answer.resolve(Ok({ text: 'answer' }));
	expect(await running).toBeUndefined();

	const saved = whispering.textOutputsOf(stem)[0]!;
	expect(saved.row.fields).toMatchObject({
		transformationTitle: 'Typed title',
		prompt: 'Draft instructions.\n',
		model: 'connection-model',
		endpoint: TEST_BASE_URL,
		input: PASTED,
	});
	expect(saved.row.body).toBe('answer\n');
	expect(transformed).toHaveLength(1);
});

test('a second ask on pasted text while one runs sends nothing; another recipe, and a later ask, are each their own row', async () => {
	const answer = deferred<Answer>();
	const { whispering, root, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(whispering);
	const other = await recipe(whispering, STARTER_TRANSFORMATIONS[1]!);

	const first = whispering.transformText(path, PASTED);
	expect(await whispering.transformText(path, 'something else')).toContain(
		'already running on pasted text',
	);
	const second = whispering.transformText(other, PASTED);
	answer.resolve(Ok({ text: 'answer' }));
	expect(await first).toBeUndefined();
	expect(await second).toBeUndefined();
	expect(transformed).toHaveLength(2);

	// A result already written is never replaced: a new run is a new row.
	expect(await whispering.transformText(path, PASTED)).toBeUndefined();
	expect(transformed).toHaveLength(3);
	expect(await names(root, TEXT_RUNS)).toHaveLength(3);
});

test('discarding a result on pasted text deletes its row, even while its request runs; the late answer writes nothing', async () => {
	const answer = deferred<Answer>();
	const { whispering, folder, root, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);
	const running = whispering.transformText(path, PASTED);
	await eventually(() => transformed.length === 1);

	const { output } = await newestText(whispering, folder, stem);
	expect(
		await whispering.delete(
			expectOk(await whispering.deletionFor(output.path)),
		),
	).toBeUndefined();
	answer.resolve(Ok({ text: 'too late' }));
	expect(await running).toBeUndefined();

	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(whispering.textOutputsOf(stem)).toEqual([]);
	expect(whispering.unwrittenAnswers).toBe(0);
});

test('a failed run runs again from its row only while the text connection is still the one the row names', async () => {
	let refuse = true;
	const { whispering, folder, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: `Again: ${input.trim()}` }),
	});
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);
	await whispering.transformText(path, PASTED);
	const { output, state } = await newestText(whispering, folder, stem);
	expect(state.kind).toBe('failed');
	refuse = false;

	expect(
		await whispering.saveConnection('text', {
			baseUrl: 'http://127.0.0.1:11434/v1',
			model: 'connection-model',
			key: { action: 'remove' },
		}),
	).toBeUndefined();
	expect(await whispering.runAgain(output.path)).toContain(
		'text connection is now http://127.0.0.1:11434/v1',
	);
	expect(transformed).toHaveLength(1);

	// Back at the endpoint the row names, it is sent again as it was.
	await whispering.saveConnection('text', {
		baseUrl: TEST_BASE_URL,
		model: 'connection-model',
		key: { action: 'remove' },
	});
	expect(await whispering.runAgain(output.path)).toBeUndefined();
	expect(transformed).toHaveLength(2);
	expect(transformed[1]).toEqual(transformed[0]!);
	expect(await names(root, TEXT_RUNS)).toEqual([`${output.stem}.md`]);
	expect(whispering.textOutputsOf(stem)[0]!.row.body).toBe(
		'Again: so um this is pasted text\n',
	);
});

test('a transcript’s failed run is not sent again over a connection that moved', async () => {
	let refuse = true;
	const { whispering, folder, transformed } = await open({
		transform: async () =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: 'ok' }),
	});
	const { transcript } = await transcribed(whispering, folder);
	const path = await recipe(whispering);
	await whispering.transform(transcript.path, path);
	const failed = whispering.outputsFor(transcript.stem)[0]!;
	refuse = false;
	await whispering.saveConnection('text', {
		baseUrl: 'http://127.0.0.1:18080/other/v1',
		model: 'connection-model',
		key: { action: 'remove' },
	});

	expect(await whispering.runAgain(failed.path)).toContain(
		'was run with http://127.0.0.1:18080/v1',
	);
	expect(transformed).toHaveLength(1);
	expect(whispering.outputsFor(transcript.stem)[0]!.row.body).toBe('');
});

test('pasted text stays across pages without holding departure', async () => {
	const { whispering } = await open();
	const { view } = whispering;
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);
	view.applySource = 'pasted';
	view.pastedText = PASTED;

	expect(await whispering.transformText(path, view.pastedText)).toBeUndefined();
	// Choosing another recipe, or another page, builds nothing new: both stay.
	whispering.open(await recipe(whispering, STARTER_TRANSFORMATIONS[1]!));
	expect(view.pastedText).toBe(PASTED);
	expect(whispering.textOutputsOf(stem)).toHaveLength(1);
	view.pastedText = '';
});

test('a text_runs/ file that does not read never holds up a recording’s deletion', async () => {
	const { whispering, folder, root } = await open();
	const { recording } = await transcribed(whispering, folder);
	const path = await recipe(whispering);
	const stem = selectedStem(whispering);
	await whispering.transformText(path, PASTED);
	expect(whispering.textOutputsOf(stem)).toHaveLength(1);
	expectOk(
		await folder.write(
			`${TEXT_RUNS}/broken.md`,
			'---\ntransformationId: *x\n---\n',
		),
	);
	expectOk(
		await folder.write(
			`${TEXT_RUNS}/binary.md`,
			new Uint8Array([0xff, 0xfe, 0x00]),
		),
	);
	expect(whispering.textRepairs.map((item) => item.path)).toEqual([
		'text_runs/binary.md',
		'text_runs/broken.md',
	]);

	const deletion = expectOk(await whispering.deletionFor(recording.path));
	expect(await whispering.delete(deletion)).toBeUndefined();
	expect(whispering.entries).toEqual([]);
	expect(await names(root, TEXT_RUNS)).toHaveLength(3);
	expect(whispering.textOutputsOf(stem)).toHaveLength(1);

	// Deleting the recipe keeps its results, and the confirmation counts them.
	expect(expectOk(await whispering.deletionFor(path))).toMatchObject({
		kind: 'transformation',
		results: 1,
	});
});

test('without a text connection, nothing is sent and the reason says to set one up', async () => {
	const { whispering, root, transformed } = await open({ connections: {} });
	const path = await recipe(whispering);

	expect(await whispering.transformText(path, PASTED)).toBe(
		'Set up the text connection in Settings to run this.',
	);
	expect(transformed).toEqual([]);
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(await whispering.transformText(path, ' \n')).toBe(
		'Paste some text to run this on.',
	);
});
