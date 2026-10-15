/**
 * Row views, mounted.
 *
 * The real library over a real directory (the Bun opener), and the real
 * FileView, RecordingDetail, and TransformationDetail components mounted in
 * jsdom inside a fixture that renders them as the recordings and
 * transformations pages do, under the library's query client.
 *
 * Key behaviors:
 * - typing in a view edits the cache of the path it shows, and writes it
 * - typing over a change made elsewhere merges with it, and the typing wins
 *   where both changed; a recording deleted elsewhere stays deleted, the
 *   lost text is reported, and its view closes
 * - a row file whose text is not a valid row opens as its text with its
 *   issues, and its fields open once the text reads
 * - bodies show in LF and save in the file's line endings; a title and a
 *   model save from their own controls, an emptied model as none
 *
 * jsdom has no layout, focus, selection, or IME; see svelte-dom.test-support.
 */

import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Library, WriteFailure } from '../../lib/library.svelte.js';
import { createQueryClient, quiet } from '../../lib/query.test-support.js';
import { type } from '../svelte-dom.test-support.js';

// Load the workspace after the mounted loader registered its plugin.
const { openTestWorkspace } = await import(
	'../../lib/workspace.test-support.js'
);
const { flushSync, mount, unmount } = await import('svelte');
const { createLibrary } = await import('../../lib/library.svelte.js');
const { pageState } = await import('../page-state.test-support.svelte.js');
const Host = (await import('./test-fixtures/SelectionHost.svelte')).default;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	document.body.replaceChildren();
});

const transcript = (body: string) =>
	`---\nrecordingId: one\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\n${body}`;
const A = 'transcriptions/a.md';
const RECIPE = 'transformations/clean.md';
const RECORDING = 'recordings/take.md';
const recording = (title: string, body: string) =>
	`---\ntitle: ${title}\nrecordedAt: 2026-10-01T00:00:00.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: recordings/take.wav\n---\n${body}`;

/** A library over files on disk, mounted in the fixture with `tab` showing. */
async function open(
	files: Record<string, string>,
	tab: 'recordings' | 'transformations' = 'recordings',
) {
	const stubs = await openTestWorkspace();
	for (const [path, text] of Object.entries(files))
		await Bun.write(join(stubs.root, path), text);
	const library = createLibrary(stubs.workspace, createQueryClient());
	await library.start();
	const failures: WriteFailure[] = [];
	library.onWriteFailed((failure) => failures.push(failure));
	const page = pageState({ shown: true, tab });
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { library, page } });
	cleanups.push(async () => {
		unmount(host);
		await library.close();
		await stubs.remove();
	});
	return { library, page, target, failures, root: stubs.root };
}

/** Select a file and let the views render it, with any text they read. */
async function show(library: Library, path: string) {
	expect(await library.open(path)).toBeUndefined();
	flushSync();
	await quiet(library.queryClient);
	flushSync();
}

/** Let writes, the reads after them, and the views settle. */
async function settle(library: Library) {
	await quiet(library.queryClient);
	await library.check();
	await quiet(library.queryClient);
	flushSync();
}

const field = <T extends Element>(target: ParentNode, selector: string) =>
	target.querySelector<T>(selector);

/** What the write status line says: Saving… or Saved. */
const writeStatus = (target: ParentNode) =>
	target.querySelector('[data-testid="write-status"]')?.textContent?.trim();

test('typing in a transcript’s view edits the cache of the path it shows, and writes it', async () => {
	const { library, target, failures, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(library, A);
	const body = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Contents of a.md"]',
	);
	expect(body?.value).toBe('Alpha.\n');

	type(body, 'Alpha, typed.\n');
	flushSync();
	expect(writeStatus(target)).toBe('Saving…');
	await settle(library);

	expect(failures).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith(
		'---\nAlpha, typed.\n',
	);
	expect(writeStatus(target)).toBe('Saved');
});

test('typing over a change made elsewhere merges with it, and the typing wins where both changed', async () => {
	const { library, target, failures, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(library, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);

	await writeFile(join(root, A), transcript('Theirs.\n'));
	type(body(), 'Mine.\n');
	await settle(library);
	expect(failures).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith('---\nMine.\n');
	expect(body()?.value).toBe('Mine.\n');
});

test('a recording deleted elsewhere stays deleted: typing in it is refused, reported, and its view closes', async () => {
	const { library, target, failures, root } = await open({
		[RECORDING]: recording('Take', 'Notes.\n'),
	});
	await show(library, RECORDING);
	await rm(join(root, RECORDING));
	type(field(target, 'input[aria-label="Recording title"]'), 'Mine');
	await settle(library);

	expect(failures).toHaveLength(1);
	expect(failures[0]?.lost).toContain('title: Mine');
	expect(library.selection).toBeUndefined();
	expect(target.querySelector('[data-testid="recording-detail"]')).toBeNull();
	expect(await Bun.file(join(root, RECORDING)).exists()).toBe(false);
});

test('a transformation that does not read opens as its text with its issues, and Instructions opens once it reads', async () => {
	const broken = '---\ntitle: Clean up\n---\nTidy.\n';
	const { library, target, root } = await open(
		{ [RECIPE]: broken },
		'transformations',
	);
	await show(library, RECIPE);
	const source = () =>
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-source"]');
	const instructions = () =>
		field<HTMLButtonElement>(target, '[data-testid="tab-instructions"]');
	expect(source()?.value).toBe(broken);
	expect(
		target.querySelector('[data-testid="needs-repair"]')?.textContent,
	).toContain('model');
	expect(instructions()?.disabled).toBe(true);

	type(
		source(),
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\n',
	);
	await settle(library);
	flushSync();
	expect(target.querySelector('[data-testid="needs-repair"]')).toBeNull();
	expect(instructions()?.disabled).toBe(false);
	expect(await library.useForm(RECIPE)).toBeUndefined();
	flushSync();
	expect(
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]')
			?.value,
	).toBe('Tidy.\n');
	expect(await readFile(join(root, RECIPE), 'utf8')).toContain('model: null');
});

test('a transformation’s title, model, and instructions save from their own controls, in the file’s line endings', async () => {
	const seed =
		'---\ntitle: Clean up\nmodel: null\nendpoint: null\n---\nTidy.\r\n';
	const { library, target, root } = await open(
		{ [RECIPE]: seed },
		'transformations',
	);
	await show(library, RECIPE);
	const title = () =>
		field<HTMLInputElement>(target, '[data-testid="transformation-title"]');
	const prompt = () =>
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]');
	const model = () =>
		field<HTMLInputElement>(target, '[data-testid="transformation-model"]');
	expect(prompt()?.value).toBe('Tidy.\n');

	target
		.querySelector('[data-testid="transformation-notes"]')
		?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	flushSync();
	expect(model()?.value).toBe('');
	type(model(), 'chat-model');
	await settle(library);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Clean up\nmodel: chat-model\nendpoint: null\n---\nTidy.\r\n',
	);

	// An emptied model is no model: the text connection's is used.
	type(model(), ' ');
	type(title(), 'Tidied');
	type(prompt(), 'Tidy.\nThen check.\n');
	await settle(library);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Tidied\nmodel: null\nendpoint: null\n---\nTidy.\r\nThen check.\r\n',
	);
	expect(prompt()?.value).toBe('Tidy.\nThen check.\n');
	expect(model()?.value).toBe('');
});
