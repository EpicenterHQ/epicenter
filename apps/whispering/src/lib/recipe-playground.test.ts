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
 * - A recipe runs on pasted text with no recordings in the folder; the answer
 *   is held, with the exact instructions, input, model, and endpoint fixed
 *   before the request, until it is saved into `text_runs/` or discarded
 * - Edits made while a run is out do not change what is saved
 * - One held or running result per recipe: a second ask sends nothing
 * - Saving again after a failed or lost save never calls the endpoint,
 *   recognizes this result's own row, and never overwrites another file
 * - A result discarded while its row is being written is not restored
 * - A failed run is retried from its snapshot only while the text connection
 *   is still the base URL it was prepared for
 * - Held results keep the app open; results on pasted text and on
 *   transcripts are listed apart; a malformed `text_runs/` file never holds
 *   up a recording's deletion; a failed listing is reported, not shown empty
 */
import './svelte-modules.test-support.js';
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
import { transformationSession } from './drafts.test-support.js';
import type { Library } from './library.svelte.js';
import { resolvePostProcessing } from './post-processing.js';
import { resolveRecipe } from './recipe.js';
import { filesLineOf } from './status.js';
import { TransformationError } from './transformation.js';
import {
	deferred,
	openTestWorkspace,
	TEST_BASE_URL,
	type TestWorkspaceOptions,
} from './workspace.test-support.js';

const { createLibrary } = await import('./library.svelte.ts');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEXT_RUNS = 'text_runs';
const CLEANUP = STARTER_TRANSFORMATIONS[0]!;
const PASTED = 'so um this is pasted text\n';

type Hooks = {
	create?: () => Promise<void>;
	list?: () => Promise<
		| Awaited<ReturnType<Library['folder']['tables']['text_runs']['list']>>
		| undefined
	>;
};

/** A library over a test workspace whose `text_runs/` writes and listings run `hooks` first. */
async function open(options: TestWorkspaceOptions = {}) {
	const test = await openTestWorkspace(options);
	const hooks: Hooks = {};
	const { tables } = test.workspace.folder;
	const textRuns = tables.text_runs;
	const library = createLibrary({
		...test.workspace,
		folder: {
			...test.workspace.folder,
			tables: {
				...tables,
				text_runs: {
					...textRuns,
					async create(...args: Parameters<typeof textRuns.create>) {
						await hooks.create?.();
						return textRuns.create(...args);
					},
					async list() {
						return (await hooks.list?.()) ?? textRuns.list();
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
	const { library, root, transformed } = await open();
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
	await library.refreshAll();

	for (const path of [fresh, matching, elsewhere]) {
		const entry = library.transformations.find((item) => item.path === path)!;
		const listed = library.resolve(entry.row);
		// The draft on the recipe's page is read by the same resolver.
		await library.open(path);
		const shown = library.resolve(transformationSession(library).draft);
		const chosen = resolvePostProcessing(
			path,
			library.transformations,
			library.resolve,
		);
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
	await library.open(path);
	const editor = transformationSession(library);
	expect(await library.transform(transcript.path, path)).toContain(
		'runs only at https://api.openai.com/v1',
	);

	editor.edit((row) => {
		row.fields.endpoint = null;
	});
	expect(editor.draft.fields.endpoint).toBeNull();
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
	await library.refreshAll();

	expect(library.transformations.map((item) => item.path)).toEqual([path]);
	expect(library.outputsOf('old').map((output) => output.row.body)).toEqual([
		'Fixed text.\n',
	]);
	expect(library.textOutputsOf('old')).toEqual([]);
});

// ============================================================================
// Pasted text
// ============================================================================

test('a recipe runs on pasted text with no recordings; the answer is held until Save writes it to text_runs/', async () => {
	const { library, root, transformed } = await open();
	expect(library.entries).toEqual([]);
	const path = await recipe(library);
	const stem = selectedStem(library);

	expect(await library.transformText(path, PASTED)).toBeUndefined();

	expect(transformed).toEqual([
		{
			expectedBaseUrl: TEST_BASE_URL,
			model: 'connection-model',
			prompt: CLEANUP.prompt,
			input: PASTED,
		},
	]);
	const held = library.textRuns[0]!;
	expect(held).toMatchObject({
		destination: 'text',
		fields: {
			transformationId: stem,
			transformationTitle: 'Clean up',
			model: 'connection-model',
			endpoint: TEST_BASE_URL,
			prompt: CLEANUP.prompt,
			input: PASTED,
		},
		state: {
			kind: 'unsaved',
			message: undefined,
			text: 'Transformed: so um this is pasted text',
		},
	});
	// Nothing is written until the person saves, and leaving warns.
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(library.transformationRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(true);
	await library.flush();
	expect(library.holdsUnsavedWork).toBe(true);
	expect(filesLineOf(library).label).toBe('1 result on pasted text not saved');

	await library.saveTextRun(held.id);

	expect(library.textRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
	expect(await names(root, TEXT_RUNS)).toEqual([`${held.id}.md`]);
	const saved = library.textOutputsOf(stem);
	expect(saved).toHaveLength(1);
	expect(saved[0]!.row.fields).toEqual(held.fields);
	expect(saved[0]!.row.body).toBe('Transformed: so um this is pasted text\n');
	// Results on pasted text are not transcript results, and name no recording.
	expect(library.outputsOf(stem)).toEqual([]);
	expect(library.transformationResults).toEqual([]);
	expect(Object.keys(saved[0]!.row.fields)).not.toContain('recordingId');
	expect(transformed).toHaveLength(1);

	// It is an ordinary file: deleting it from history works like any other result.
	expect(await library.deleteTextResult(saved[0]!)).toBeUndefined();
	expect(await names(root, TEXT_RUNS)).toEqual([]);
	expect(library.textOutputsOf(stem)).toEqual([]);
});

test('what is saved is what was sent: edits to the recipe or the connection while it runs change nothing', async () => {
	const answer =
		deferred<Awaited<ReturnType<Library['workspace']['transform']>>>();
	const { library, transformed } = await open({
		transform: () => answer.promise,
	});
	const path = await recipe(library);
	const editor = transformationSession(library);
	const stem = selectedStem(library);
	editor.edit((row) => {
		row.body = 'Draft instructions.\n';
	});

	const running = library.transformText(path, PASTED);
	await new Promise((resolve) => setTimeout(resolve, 20));
	// Its save settled first, and the saved file is what went out.
	expect(transformed[0]!.prompt).toBe('Draft instructions.\n');
	const id = library.textRuns[0]!.id;
	editor.edit((row) => {
		row.body = 'Edited while running.\n';
		row.fields.model = 'other';
	});
	expect((await editor.settled()).status).toBe('saved');
	expect(
		await library.saveConnection('text', {
			baseUrl: TEST_BASE_URL,
			model: 'changed-default',
			key: { action: 'keep' },
		}),
	).toBeUndefined();
	answer.resolve(Ok({ text: 'answer' }));
	expect(await running).toBeUndefined();

	await library.saveTextRun(id);
	const saved = library.textOutputsOf(stem)[0]!;
	expect(saved.stem).toBe(id);
	expect(saved.row.fields).toMatchObject({
		prompt: 'Draft instructions.\n',
		model: 'connection-model',
		endpoint: TEST_BASE_URL,
		input: PASTED,
	});
	expect(saved.row.body).toBe('answer\n');
	expect(transformed).toHaveLength(1);
});

test('one recipe holds one result on pasted text: a second ask while one runs or waits sends nothing', async () => {
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
	// Another recipe is its own run.
	const second = library.transformText(other, PASTED);
	answer.resolve(Ok({ text: 'answer' }));
	expect(await first).toBeUndefined();
	expect(await second).toBeUndefined();
	expect(transformed).toHaveLength(2);

	// A received answer is never replaced by a new run.
	expect(await library.transformText(path, PASTED)).toContain(
		'Save or discard it first',
	);
	expect(transformed).toHaveLength(2);
	expect(library.textRuns.map((run) => run.state.kind)).toEqual([
		'unsaved',
		'unsaved',
	]);
	// Saving twice at once writes once.
	const held = library.textRuns[0]!;
	await Promise.all([
		library.saveTextRun(held.id),
		library.saveTextRun(held.id),
	]);
	expect(library.textRuns).toHaveLength(1);
	expect(await names(root, TEXT_RUNS)).toEqual([`${held.id}.md`]);
	expect(transformed).toHaveLength(2);
});

test('a save that fails, or lands with its answer lost, is saved again without calling the endpoint, under the same name', async () => {
	const { library, root, transformed } = await open({
		failTextRunWrites: 1,
		loseTextRunWriteAnswers: 1,
	});
	const path = await recipe(library);
	await library.transformText(path, PASTED);
	const held = library.textRuns[0]!;

	// Refused before writing: still held, with why.
	await library.saveTextRun(held.id);
	expect(library.textRuns[0]!.state).toMatchObject({
		kind: 'unsaved',
		message: expect.stringContaining('disk refused the result'),
	});
	expect(await names(root, TEXT_RUNS)).toEqual([]);

	// Landed, answer lost: still held, and the file is there.
	await library.saveTextRun(held.id);
	expect(library.textRuns[0]!.state.kind).toBe('unsaved');
	expect(await names(root, TEXT_RUNS)).toEqual([`${held.id}.md`]);
	const landed = await readFile(join(root, TEXT_RUNS, `${held.id}.md`), 'utf8');

	// The row there is this result's own: recognized, not written twice.
	await library.saveTextRun(held.id);
	expect(library.textRuns).toEqual([]);
	expect(await readFile(join(root, TEXT_RUNS, `${held.id}.md`), 'utf8')).toBe(
		landed,
	);
	expect(transformed).toHaveLength(1);
});

test('another file at the result’s name is never overwritten, and the text stays held', async () => {
	const { library, root, transformed } = await open({ failTextRunWrites: 1 });
	const path = await recipe(library);
	await library.transformText(path, PASTED);
	const held = library.textRuns[0]!;
	await library.saveTextRun(held.id);
	await mkdir(join(root, TEXT_RUNS), { recursive: true });
	const squatter = '---\ntitle: not a result\n---\nSomeone else wrote this\n';
	await writeFile(join(root, TEXT_RUNS, `${held.id}.md`), squatter);

	await library.saveTextRun(held.id);

	expect(library.textRuns[0]!.state).toMatchObject({
		kind: 'unsaved',
		message: expect.stringContaining('Nothing was overwritten'),
		text: 'Transformed: so um this is pasted text',
	});
	expect(await readFile(join(root, TEXT_RUNS, `${held.id}.md`), 'utf8')).toBe(
		squatter,
	);
	expect(library.holdsUnsavedWork).toBe(true);
	expect(transformed).toHaveLength(1);
});

test('a result discarded while its row is being written may land, and is not restored', async () => {
	const { library, root, hooks } = await open();
	const path = await recipe(library);
	await library.transformText(path, PASTED);
	const held = library.textRuns[0]!;
	const reached = deferred<void>();
	const release = deferred<void>();
	hooks.create = async () => {
		reached.resolve();
		await release.promise;
	};

	const saving = library.saveTextRun(held.id);
	await reached.promise;
	library.discardTransformationRun(held.id);
	expect(library.textRuns).toEqual([]);
	release.resolve();
	await saving;

	expect(await names(root, TEXT_RUNS)).toEqual([`${held.id}.md`]);
	expect(library.textRuns).toEqual([]);
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a failed run is retried from its snapshot only while the text connection is still the one it was prepared for', async () => {
	let refuse = true;
	const { library, transformed } = await open({
		transform: async ({ input }) =>
			refuse
				? TransformationError.Unreachable({ url: 'http://x', reason: 'down' })
				: Ok({ text: `Again: ${input.trim()}` }),
	});
	const path = await recipe(library);
	await library.transformText(path, PASTED);
	const failed = library.textRuns[0]!;
	expect(failed.state.kind).toBe('failed');
	// Nothing was received, so leaving does not warn.
	expect(library.holdsUnsavedWork).toBe(false);
	refuse = false;

	expect(
		await library.saveConnection('text', {
			baseUrl: 'http://127.0.0.1:11434/v1',
			model: 'connection-model',
			key: { action: 'remove' },
		}),
	).toBeUndefined();
	await library.retryTransformation(failed.id);
	expect(library.textRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining(
			'text connection is now http://127.0.0.1:11434/v1',
		),
	});
	expect(transformed).toHaveLength(1);

	// Back at the endpoint it was prepared for, it is sent again as it was.
	await library.saveConnection('text', {
		baseUrl: TEST_BASE_URL,
		model: 'connection-model',
		key: { action: 'remove' },
	});
	await library.retryTransformation(failed.id);
	expect(transformed).toHaveLength(2);
	expect(transformed[1]).toEqual(transformed[0]!);
	expect(library.textRuns[0]).toMatchObject({
		id: failed.id,
		state: { kind: 'unsaved', text: 'Again: so um this is pasted text' },
	});
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
	const failed = library.transformationRuns[0]!;
	refuse = false;
	await library.saveConnection('text', {
		baseUrl: 'http://127.0.0.1:18080/other/v1',
		model: 'connection-model',
		key: { action: 'remove' },
	});

	await library.retryTransformation(failed.id);

	expect(library.transformationRuns[0]!.state).toMatchObject({
		kind: 'failed',
		message: expect.stringContaining(
			'was prepared for http://127.0.0.1:18080/v1',
		),
	});
	expect(transformed).toHaveLength(1);
});

test('the pasted text and a held result stay with the session, and the result keeps the app open', async () => {
	const { open: openWorkspace, remove } = await openTestWorkspace();
	const { openSession } = await import('./session.svelte.ts');
	const session = expectOk(await openSession(openWorkspace));
	cleanups.push(async () => {
		await session.close();
		await remove();
	});
	const { library, view } = session;
	const path = await recipe(library);
	view.applySource = 'pasted';
	view.pastedText = PASTED;

	expect(await library.transformText(path, view.pastedText)).toBeUndefined();
	// Choosing another recipe, or another page, builds nothing new: both stay.
	await library.open(await recipe(library, STARTER_TRANSFORMATIONS[1]!));
	expect(view.pastedText).toBe(PASTED);
	expect(library.textRuns).toHaveLength(1);
	expect(session.blocksNavigation({ willUnload: true })).toBe(true);
	expect(session.blocksNavigation({ willUnload: false })).toBe(false);
	await library.flush();
	expect(library.holdsUnsavedWork).toBe(true);

	library.discardTransformationRun(library.textRuns[0]!.id);
	await library.flush();
	expect(library.holdsUnsavedWork).toBe(false);
});

test('a text_runs/ file that does not read never holds up a recording’s deletion, and a failed listing is reported, not shown empty', async () => {
	const { library, root, hooks } = await open();
	const { recording } = await transcribed(library);
	const path = await recipe(library);
	const stem = selectedStem(library);
	await library.transformText(path, PASTED);
	await library.saveTextRun(library.textRuns[0]!.id);
	expect(library.textOutputsOf(stem)).toHaveLength(1);
	await writeFile(
		join(root, TEXT_RUNS, 'broken.md'),
		'---\ntransformationId: *x\n---\n',
	);
	await writeFile(
		join(root, TEXT_RUNS, 'binary.md'),
		new Uint8Array([0xff, 0xfe, 0x00]),
	);
	await library.refreshAll();
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
	await library.refreshAll();
	expect(library.textResultsError).toContain('the listing could not be read');
	expect(library.textOutputsOf(stem)).toHaveLength(1);

	// Deleting the recipe keeps its results, and the confirmation counts them.
	hooks.list = undefined;
	await library.refreshAll();
	expect(expectOk(await library.deletionFor(path))).toMatchObject({
		kind: 'transformation',
		results: 1,
	});
});

test('without a text connection, nothing is sent and the reason says to set one up', async () => {
	const { library, transformed } = await open({ connections: {} });
	const path = await recipe(library);

	expect(await library.transformText(path, PASTED)).toBe(
		'Set up the text connection in Settings to run this.',
	);
	expect(transformed).toEqual([]);
	expect(library.textRuns).toEqual([]);
	expect(await library.transformText(path, ' \n')).toBe(
		'Paste some text to run this on.',
	);
});
