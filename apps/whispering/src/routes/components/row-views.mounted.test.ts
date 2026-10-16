/**
 * Row views, mounted.
 *
 * The real library over a real directory (the Bun opener), and the real
 * FileView, RecordingDetail, and TransformationDetail components mounted in
 * jsdom inside a fixture that renders them as the recordings and
 * transformations pages do, under the library's query client.
 *
 * Key behaviors:
 * - typing in a view edits the path it shows, and writes it once the person
 *   leaves the field
 * - a change made elsewhere shows once the folder reports it
 * - typing over a change made elsewhere merges with it, and the typing wins
 *   where both changed and says so; a recording deleted elsewhere stays
 *   deleted, the lost text is reported, and its view closes
 * - a row file whose text is not a valid row opens as its text with its
 *   issues, and its fields open once the text reads
 * - a body from a CRLF file shows in LF, and any save writes the file in LF
 *   (ADR-0572); a title and a model save from their own controls, an emptied
 *   model as none
 *
 * jsdom has no layout, focus, selection, or IME; see svelte-dom.test-support.
 */

import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { folderOptions } from '@epicenter/folder/query';
import type { Library, WriteNotice } from '../../lib/library.svelte.js';
import { createQueryClient, quiet } from '../../lib/query.test-support.js';
import { leave, type } from '../svelte-dom.test-support.js';

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
	`---\ntitle: ${title}\nrecordedAt: 2026-10-01T00:00:00.000Z\ndurationMs: 1000\ncapture: fixture\naudioPath: audio/take.wav\n---\n${body}`;

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
	const notices: WriteNotice[] = [];
	library.onWriteNotice((notice) => notices.push(notice));
	const page = pageState({ shown: true, tab });
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { library, page } });
	cleanups.push(async () => {
		unmount(host);
		await library.close();
		await stubs.remove();
	});
	return { library, page, target, notices, root: stubs.root };
}

/** Select a file and let the views render it, with any text they read. */
async function show(library: Library, path: string) {
	expect(await library.open(path)).toBeUndefined();
	flushSync();
	await quiet(library.queryClient);
	flushSync();
}

/** Let writes and the views settle. */
async function settle(library: Library) {
	await quiet(library.queryClient);
	flushSync();
}

/** Report that `path` changed, as the folder's change channel does, and let the views read it. */
async function reportChanged(library: Library, path: string) {
	await library.queryClient.invalidateQueries(
		folderOptions(library.folder).pathFilter([path]),
	);
	await settle(library);
}

const field = <T extends Element>(target: ParentNode, selector: string) =>
	target.querySelector<T>(selector);

/** What the write status line says: Saving… or Saved. */
const writeStatus = (target: ParentNode) =>
	target.querySelector('[data-testid="write-status"]')?.textContent?.trim();

test('typing in a transcript’s view edits the path it shows, and writes it', async () => {
	const { library, target, notices, root } = await open({
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
	leave(body);
	await settle(library);

	expect(notices).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith(
		'---\nAlpha, typed.\n',
	);
	expect(writeStatus(target)).toBe('Saved');
});

test('a change made elsewhere shows once the folder reports it', async () => {
	const { library, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(library, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);

	await writeFile(join(root, A), transcript('Theirs.\n'));
	// Nothing reads it until the folder says it changed.
	await settle(library);
	expect(body()?.value).toBe('Alpha.\n');
	await reportChanged(library, A);
	expect(body()?.value).toBe('Theirs.\n');
});

test('typing over a change made elsewhere merges with it, and the typing wins where both changed, with no notice', async () => {
	const { library, target, notices, root } = await open({
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
	leave(body());
	await settle(library);
	expect(notices).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith('---\nMine.\n');
	expect(body()?.value).toBe('Mine.\n');
});

test('a recording deleted elsewhere stays deleted: typing in it is refused, reported, and its view closes', async () => {
	const { library, target, notices, root } = await open({
		[RECORDING]: recording('Take', 'Notes.\n'),
	});
	await show(library, RECORDING);
	await rm(join(root, RECORDING));
	const notes = field(target, 'textarea[aria-label="Notes"]');
	type(notes, 'Mine.\n');
	leave(notes);
	await settle(library);

	expect(notices).toHaveLength(1);
	expect(notices[0]?.kind === 'failed' && notices[0].lost).toContain('Mine.');
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
	leave(source());
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

test('a transformation’s title, model, and instructions save from their own controls, and a CRLF file is written in LF (ADR-0572)', async () => {
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
	leave(model());
	await settle(library);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Clean up\nmodel: chat-model\nendpoint: null\n---\nTidy.\n',
	);

	// An emptied model is no model: the text connection's is used.
	type(model(), ' ');
	leave(model());
	type(title(), 'Tidied');
	leave(title());
	type(prompt(), 'Tidy.\nThen check.\n');
	leave(prompt());
	await settle(library);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Tidied\nmodel: null\nendpoint: null\n---\nTidy.\nThen check.\n',
	);
	expect(prompt()?.value).toBe('Tidy.\nThen check.\n');
	expect(model()?.value).toBe('');
});

test('a recording whose audio is not in the folder says it is not on this device, and offers no player, transcription, or run again until the audio arrives', async () => {
	const { library, target, root } = await open({
		[RECORDING]: recording('Take', ''),
		// A transcription that never got its answer: running it again needs the audio.
		'transcriptions/unfinished.md':
			'---\nrecordingId: take\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\n',
	});
	const runAgain = () =>
		target.querySelector<HTMLButtonElement>('[data-testid="run-again"]');
	await show(library, RECORDING);
	const absent = () => target.querySelector('[data-testid="audio-absent"]');
	const transcribe = () =>
		target.querySelector<HTMLButtonElement>('[data-testid="transcribe"]');
	expect(absent()?.textContent).toContain(
		'This recording’s audio isn’t on this device.',
	);
	expect(target.querySelector('[data-testid="audio-player"]')).toBeNull();
	expect(transcribe()?.disabled).toBe(true);
	expect(runAgain()?.disabled).toBe(true);

	// The audio is copied in: it is this device's to play and transcribe now.
	await Bun.write(join(root, 'audio/take.wav'), 'RIFF');
	await reportChanged(library, 'audio/take.wav');
	expect(absent()).toBeNull();
	expect(transcribe()?.disabled).toBe(false);
	expect(runAgain()?.disabled).toBe(false);
});

test('a recording just stopped never reads as missing its audio while the folder has not listed it yet', async () => {
	const { library, target } = await open({});
	const seen: string[] = [];
	const look = () => {
		flushSync();
		const entry = library.entries[0];
		if (entry !== undefined) seen.push(library.audioOf(entry).kind);
		if (target.querySelector('[data-testid="audio-absent"]') !== null)
			seen.push('shown absent');
	};
	await library.startRecording();
	look();
	const stopping = library.stopRecording();
	look();
	await stopping;
	look();
	await settle(library);
	look();
	expect(seen).not.toContain('absent');
	expect(seen).not.toContain('shown absent');
	expect(library.audioOf(library.entries[0]!).kind).toBe('here');
});
