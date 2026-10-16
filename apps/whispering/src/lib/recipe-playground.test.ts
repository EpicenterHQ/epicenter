/**
 * Recipe and pasted-text playground tests
 *
 * Drives the real product state against a real directory and Git repository,
 * with stubbed endpoints that decide the connection as the host does and
 * count every request that would go out. No window, provider, key, or network
 * is involved.
 *
 * Key behaviors:
 * - One resolver decides whether a recipe runs and with what; the Run check,
 *   the post-processing choice, the transcript menu, and the run agree
 * - A new recipe names no endpoint or model and runs with the text
 *   connection; a recipe's model overrides the connection's; an endpoint an
 *   earlier build wrote is a constraint that must match the connection
 *   exactly, never a destination, and removing it lets the recipe run
 * - A recipe runs on pasted text with no recordings in the folder; its row is
 *   written to `text_runs/` when it starts, with the exact instructions,
 *   input, model, and endpoint, and filled when the answer arrives, with no
 *   separate Save (ADR-0542)
 * - Edits made while a run is out do not change what is written
 * - One running ask per recipe on pasted text; a later ask is a new row
 * - Discarding is deleting the row, and an answer that arrives after writes
 *   nothing
 * - A failed run runs again from its row only while the text connection is
 *   still the base URL the row names
 * - A run on pasted text never holds the app open; results on pasted text and
 *   on transcripts are listed apart; a malformed `text_runs/` file never holds
 *   up a recording's deletion; a failed listing is reported, not shown empty
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileError } from '@epicenter/folder/bun';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { ConnectionInfo } from './connections.js';
import {
	STARTER_TRANSFORMATIONS,
	type TransformationFields,
} from './definition.js';
import { settle, transformationEditor } from './edits.test-support.js';
import type { Library } from './library.svelte.js';
import { createQueryClient } from './query.test-support.js';
import { resolveRecipe } from './recipe.js';
import { TransformationError } from './transformation.js';
import {
	deferred,
	eventually,
	openTestWorkspace,
	TEST_BASE_URL,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { createSession } = await import('./session.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEXT_RUNS = 'text_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;
const PASTED = 'so um this is pasted text\n';

type Hooks = {
	list?: () => Promise<
		| Awaited<ReturnType<Library['folder']['tables']['text_runs']['list']>>
		| undefined
	>;
};

/** A session over a test workspace whose `text_runs/` listings run `hooks` first. */
async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const hooks: Hooks = {};
	const { tables } = test.workspace.folder;
	const textRuns = tables.text_runs;
	const session = await createSession(
		{
			...test.workspace,
			folder: {
				...test.workspace.folder,
				tables: {
					...tables,
					text_runs: {
						...textRuns,
						async list() {
							return (await hooks.list?.()) ?? textRuns.list();
						},
					},
				},
			} as Library['workspace']['folder'],
		},
		createQueryClient(),
	);
	cleanups.push(async () => {
		await session.close();
		await test.remove();
	});
	return { session, library: session.library, hooks, ...test };
}

const names = (root: string, directory: string) =>
	readdir(join(root, directory)).catch(() => [] as string[]);

/** Create a recipe from a starter, as a person would, and return its path. */
async function recipe(library: Library, starter = CLEANUP) {
	expect(await library.createTransformation(starter)).toBeUndefined();
	return library.selectedTransformation!.path;
}

/** The stem of the selected recipe's file. */
const selectedStem = (library: Library) =>
	library.selectedTransformation!.path.slice('transformations/'.length, -3);

/** Write a recipe file as an earlier build left it. */
async function earlierRecipe(
	root: string,
	stem: string,
	{ model, endpoint }: { model: string; endpoint: string },
) {
	await mkdir(join(root, 'transformations'), { recursive: true });
	await writeFile(
		join(root, 'transformations', `${stem}.md`),
		`---\ntitle: Earlier\nmodel: ${model}\nendpoint: ${endpoint}\n---\nFix it.\n`,
	);
	return `transformations/${stem}.md`;
}

/** A recording with one saved transcript. */
async function transcribed(library: Library) {
	await library.startRecording();
	await library.stopRecording();
	const recording = library.entries[0]!;
	await library.transcribe(recording);
	return { recording, transcript: library.resultsFor(recording.stem)[0]! };
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
	fields: fields as TransformationFields,
	body,
});

test('the resolver uses the text connection, lets a recipe name its model, and takes an earlier endpoint only as an exact constraint', () => {
	expect(
		resolveRecipe(reading({ title: 'New', model: null, endpoint: null }), TEXT),
	).toEqual({
		kind: 'ready',
		title: 'New',
		prompt: 'Fix it.\n',
		model: 'connection-model',
		endpoint: TEST_BASE_URL,
	});
	// Blank is the same as null: an earlier build wrote '' for "no model yet".
	expect(
		resolveRecipe(reading({ title: 'Old', model: ' ', endpoint: '' }), TEXT),
	).toMatchObject({ kind: 'ready', model: 'connection-model' });
	expect(
		resolveRecipe(
			reading({
				title: 'Own',
				model: 'gpt-4o-mini',
				endpoint: `${TEST_BASE_URL}/`,
			}),
			TEXT,
		),
	).toMatchObject({
		kind: 'ready',
		model: 'gpt-4o-mini',
		endpoint: TEST_BASE_URL,
	});

	for (const endpoint of [
		'https://api.openai.com/v1',
		'http://127.0.0.1:18080/other/v1',
		'http://127.0.0.1:18080',
	])
		expect(
			resolveRecipe(
				reading({ title: 'Elsewhere', model: null, endpoint }),
				TEXT,
			),
		).toMatchObject({
			kind: 'blocked',
			fix: 'recipe',
			reason: expect.stringContaining(`runs only at ${endpoint}`),
		});
	expect(
		resolveRecipe(
			reading({ title: 'Bad', model: null, endpoint: 'nope' }),
			TEXT,
		),
	).toMatchObject({
		kind: 'blocked',
		reason: expect.stringContaining('not a base URL'),
	});
	expect(
		resolveRecipe(
			reading({ title: 'New', model: null, endpoint: null }),
			undefined,
		),
	).toEqual({
		kind: 'blocked',
		fix: 'connection',
		reason: 'Set up the text connection in Settings to run this.',
	});
	expect(
		resolveRecipe(
			reading({ title: 'New', model: null, endpoint: null }),
			undefined,
			'disk refused',
		),
	).toMatchObject({
		kind: 'blocked',
		reason: expect.stringContaining('disk refused'),
	});
	expect(
		resolveRecipe(
			reading({ title: 'New', model: null, endpoint: null }, ' \n'),
			TEXT,
		),
	).toMatchObject({ reason: 'Write instructions to run this.' });
	expect(resolveRecipe(undefined, TEXT)).toMatchObject({
		reason: 'Repair this transformation before running it.',
	});
});

test('the Run check, the post-processing choice, the menu, and the run agree about every recipe', async () => {
	const { session, library, root, transformed } = await open();
	const { transcript } = await transcribed(library);
	const fresh = await recipe(library);
	const matching = await earlierRecipe(root, 'matching', {
		model: 'old-model',
		endpoint: 'HTTP://127.0.0.1:18080/v1/',
	});
	const elsewhere = await earlierRecipe(root, 'elsewhere', {
		model: 'old-model',
		endpoint: 'http://127.0.0.1:18080/other/v1',
	});
	await settle(library);

	for (const path of [fresh, matching, elsewhere]) {
		const entry = library.transformations.find((item) => item.path === path)!;
		const listed = library.resolve(entry.row);
		// The draft on the recipe's page is read by the same resolver.
		await library.open(path);
		const shown = library.resolve(transformationEditor(library).draft);
		session.view.postProcessing = path;
		const chosen = session.postProcessing;
		const before = transformed.length;
		const problem = await library.transform(transcript.path, path);

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

test('removing an earlier endpoint from a recipe lets it run with the text connection, and its other fields are kept', async () => {
	const { library, root, transformed } = await open();
	const { transcript } = await transcribed(library);
	const path = await earlierRecipe(root, 'old', {
		model: 'old-model',
		endpoint: 'https://api.openai.com/v1',
	});
	await settle(library);
	await library.open(path);
	const editor = transformationEditor(library);
	expect(await library.transform(transcript.path, path)).toContain(
		'runs only at https://api.openai.com/v1',
	);

	editor.edit((row) => {
		row.fields.endpoint = null;
	});
	expect(await library.transform(transcript.path, path)).toBeUndefined();

	expect(transformed).toEqual([
		expect.objectContaining({
			expectedBaseUrl: TEST_BASE_URL,
			model: 'old-model',
		}),
	]);
	// The whole row is saved, with the other fields as they were.
	expect(await readFile(join(root, path), 'utf8')).toBe(
		'---\ntitle: Earlier\nmodel: old-model\nendpoint: null\n---\nFix it.\n',
	);
});

test('a result file and a recipe written by an earlier build still read and list', async () => {
	const { library, root } = await open();
	const path = await earlierRecipe(root, 'old', {
		model: 'old-model',
		endpoint: 'https://api.openai.com/v1',
	});
	await mkdir(join(root, 'transformation_runs'));
	const old =
		'---\nrecordingId: 20250101-000000-abcd\ntranscriptionId: 20250101-000001-abcd\ntransformationId: old\ntransformationTitle: Earlier\ncreatedAt: 2025-01-01T00:00:02.000Z\nmodel: old-model\nendpoint: https://api.openai.com/v1\nprompt: Fix it.\ninput: some text\n---\nFixed text.\n';
	await writeFile(join(root, 'transformation_runs', 'earlier.md'), old);
	await settle(library);

	expect(library.transformations.map((item) => item.path)).toEqual([path]);
	expect(library.outputsOf('old').map((output) => output.row.body)).toEqual([
		'Fixed text.\n',
	]);
	expect(library.textOutputsOf('old')).toEqual([]);
});

// ============================================================================
// Pasted text
// ============================================================================

/** The newest result on pasted text of the recipe `stem`, and what it shows. */
function newestText(library: Library, stem: string) {
	const output = library.textOutputsOf(stem)[0]!;
	return {
		output,
		state: library.resultState(output.path, output.row.body),
	};
}

test('a recipe runs on pasted text with no recordings; its row is written to text_runs/ when it starts and filled when the answer arrives, with no Save', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root, transformed } = await open({
		transform: () => answer.promise,
	});
	expect(library.entries).toEqual([]);
	const path = await recipe(library);
	const stem = selectedStem(library);

	const running = library.transformText(path, PASTED);
	await eventually(() => transformed.length === 1);

	expect(transformed).toEqual([
		{
			expectedBaseUrl: TEST_BASE_URL,
			model: 'connection-model',
			prompt: CLEANUP.prompt,
			input: PASTED,
		},
	]);
	const { output, state } = newestText(library, stem);
	expect(state.kind).toBe('running');
	expect(output.row).toEqual({
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

	const saved = library.textOutputsOf(stem);
	expect(saved.map((item) => item.stem)).toEqual([output.stem]);
	expect(saved[0]!.row.fields).toEqual(output.row.fields);
	expect(saved[0]!.row.body).toBe('Transformed: so um this is pasted text\n');
	// Results on pasted text are not transcript results, and name no recording.
	expect(library.outputsOf(stem)).toEqual([]);
	expect(library.transformationResults).toEqual([]);
	expect(Object.keys(saved[0]!.row.fields)).not.toContain('recordingId');
	expect(transformed).toHaveLength(1);

	// It is an ordinary file: deleting it works like any other result.
	expect(await library.deleteTextResult(saved[0]!)).toBeUndefined();
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(library.textOutputsOf(stem)).toEqual([]);
});

test('what is written is what was sent: edits to the recipe or the connection while it runs change nothing', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(library);
	const editor = transformationEditor(library);
	const stem = selectedStem(library);
	editor.edit((row) => {
		row.body = 'Draft instructions.\n';
	});

	const running = library.transformText(path, PASTED);
	await eventually(() => transformed.length === 1);
	// Its save settled first, and the saved file is what went out.
	expect(transformed[0]!.prompt).toBe('Draft instructions.\n');
	editor.edit((row) => {
		row.body = 'Edited while running.\n';
		row.fields.model = 'other';
	});
	await settle(library);
	expect(
		await library.saveConnection('text', {
			baseUrl: TEST_BASE_URL,
			model: 'changed-default',
			key: { action: 'keep' },
		}),
	).toBeUndefined();
	answer.resolve(Ok({ text: 'answer' }));
	expect(await running).toBeUndefined();

	const saved = library.textOutputsOf(stem)[0]!;
	expect(saved.row.fields).toMatchObject({
		prompt: 'Draft instructions.\n',
		model: 'connection-model',
		endpoint: TEST_BASE_URL,
		input: PASTED,
	});
	expect(saved.row.body).toBe('answer\n');
	expect(transformed).toHaveLength(1);
});

test('a second ask on pasted text while one runs sends nothing; another recipe, and a later ask, are each their own row', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(library);
	const other = await recipe(library, STARTER_TRANSFORMATIONS[1]!);

	const first = library.transformText(path, PASTED);
	expect(await library.transformText(path, 'something else')).toContain(
		'already running on pasted text',
	);
	const second = library.transformText(other, PASTED);
	answer.resolve(Ok({ text: 'answer' }));
	expect(await first).toBeUndefined();
	expect(await second).toBeUndefined();
	expect(transformed).toHaveLength(2);

	// A result already written is never replaced: a new run is a new row.
	expect(await library.transformText(path, PASTED)).toBeUndefined();
	expect(transformed).toHaveLength(3);
	expect(await names(root, TEXT_RUNS)).toHaveLength(3);
});

test('discarding a result on pasted text deletes its row, even while its request runs; the late answer writes nothing', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, root, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(library);
	const stem = selectedStem(library);
	const running = library.transformText(path, PASTED);
	await eventually(() => transformed.length === 1);

	const { output } = newestText(library, stem);
	expect(await library.deleteTextResult(output)).toBeUndefined();
	answer.resolve(Ok({ text: 'too late' }));
	expect(await running).toBeUndefined();

	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(library.textOutputsOf(stem)).toEqual([]);
	expect(library.unwrittenAnswers).toBe(0);
});

test('a failed run runs again from its row only while the text connection is still the one the row names', async () => {
	let refuse = true;
	const { library, root, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: `Again: ${input.trim()}` }),
	});
	const path = await recipe(library);
	const stem = selectedStem(library);
	await library.transformText(path, PASTED);
	const { output, state } = newestText(library, stem);
	expect(state.kind).toBe('failed');
	refuse = false;

	expect(
		await library.saveConnection('text', {
			baseUrl: 'http://127.0.0.1:11434/v1',
			model: 'connection-model',
			key: { action: 'remove' },
		}),
	).toBeUndefined();
	expect(await library.runAgain(output.path)).toContain(
		'text connection is now http://127.0.0.1:11434/v1',
	);
	expect(transformed).toHaveLength(1);

	// Back at the endpoint the row names, it is sent again as it was.
	await library.saveConnection('text', {
		baseUrl: TEST_BASE_URL,
		model: 'connection-model',
		key: { action: 'remove' },
	});
	expect(await library.runAgain(output.path)).toBeUndefined();
	expect(transformed).toHaveLength(2);
	expect(transformed[1]).toEqual(transformed[0]!);
	expect(await names(root, TEXT_RUNS)).toEqual([`${output.stem}.md`]);
	expect(library.textOutputsOf(stem)[0]!.row.body).toBe(
		'Again: so um this is pasted text\n',
	);
});

test('a transcript’s failed run is not sent again over a connection that moved', async () => {
	let refuse = true;
	const { library, transformed } = await open({
		transform: async () =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: 'ok' }),
	});
	const { transcript } = await transcribed(library);
	const path = await recipe(library);
	await library.transform(transcript.path, path);
	const failed = library.outputsFor(transcript.stem)[0]!;
	refuse = false;
	await library.saveConnection('text', {
		baseUrl: 'http://127.0.0.1:18080/other/v1',
		model: 'connection-model',
		key: { action: 'remove' },
	});

	expect(await library.runAgain(failed.path)).toContain(
		'was run with http://127.0.0.1:18080/v1',
	);
	expect(transformed).toHaveLength(1);
	expect(library.outputsFor(transcript.stem)[0]!.row.body).toBe('');
});

test('the pasted text stays with the session, and a result on it never holds the app open', async () => {
	const { open: openWorkspace, remove } = await openTestWorkspace();
	const { openSession } = await import('./session.svelte.ts');
	const session = expectOk(
		await openSession(createQueryClient(), openWorkspace),
	);
	cleanups.push(async () => {
		await session.close();
		await remove();
	});
	const { library, view } = session;
	const path = await recipe(library);
	const stem = selectedStem(library);
	view.applySource = 'pasted';
	view.pastedText = PASTED;

	expect(await library.transformText(path, view.pastedText)).toBeUndefined();
	// Choosing another recipe, or another page, builds nothing new: both stay.
	await library.open(await recipe(library, STARTER_TRANSFORMATIONS[1]!));
	expect(view.pastedText).toBe(PASTED);
	expect(library.textOutputsOf(stem)).toHaveLength(1);
	expect(session.blocksNavigation({ willUnload: true })).toBe(false);
});

test('a text_runs/ file that does not read never holds up a recording’s deletion, and a failed listing is reported, not shown empty', async () => {
	const { library, root, hooks } = await open();
	const { recording } = await transcribed(library);
	const path = await recipe(library);
	const stem = selectedStem(library);
	await library.transformText(path, PASTED);
	expect(library.textOutputsOf(stem)).toHaveLength(1);
	await writeFile(
		join(root, TEXT_RUNS, 'broken.md'),
		'---\ntransformationId: *x\n---\n',
	);
	await writeFile(
		join(root, TEXT_RUNS, 'binary.md'),
		new Uint8Array([0xff, 0xfe, 0x00]),
	);
	await settle(library);
	expect(library.textRepairs.map((item) => item.path)).toEqual([
		'text_runs/binary.md',
		'text_runs/broken.md',
	]);

	const deletion = expectOk(await library.deletionFor(recording.path));
	expect(await library.remove(deletion)).toBeUndefined();
	expect(library.entries).toEqual([]);
	expect(await names(root, TEXT_RUNS)).toHaveLength(3);

	hooks.list = async () =>
		FileError.Io({
			path: TEXT_RUNS,
			operation: 'list',
			cause: new Error('the listing could not be read'),
		});
	await settle(library);
	expect(library.textResultsError).toContain('the listing could not be read');
	expect(library.textOutputsOf(stem)).toHaveLength(1);

	// Deleting the recipe keeps its results, and the confirmation counts them.
	hooks.list = undefined;
	await settle(library);
	expect(expectOk(await library.deletionFor(path))).toMatchObject({
		kind: 'transformation',
		results: 1,
	});
});

test('without a text connection, nothing is sent and the reason says to set one up', async () => {
	const { library, root, transformed } = await open({ connections: {} });
	const path = await recipe(library);

	expect(await library.transformText(path, PASTED)).toBe(
		'Set up the text connection in Settings to run this.',
	);
	expect(transformed).toEqual([]);
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(await library.transformText(path, ' \n')).toBe(
		'Paste some text to run this on.',
	);
});
