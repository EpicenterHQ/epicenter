/**
 * Row views, mounted.
 *
 * The real whispering over a real directory (the Bun opener), and the real
 * FileView, RecordingDetail, and TransformationDetail components mounted in
 * jsdom inside a fixture that renders them as the recordings and
 * transformations pages do, under Whispering's query client.
 *
 * Key behaviors:
 * - typing in a view edits the path it shows, and autosaves after a pause
 * - a change made elsewhere shows once the folder reports it
 * - typing over a change made elsewhere merges with it, and the typing wins
 *   where both changed; typing into a recording deleted elsewhere brings it
 *   back, so nothing typed is lost
 * - a row file whose text is not a valid row opens as its text with its
 *   issues, and its fields open once the text reads
 * - a body from a CRLF file shows in LF; a field save leaves its bytes as
 *   they are, and typed instructions save in LF (ADR-0572); a title and a
 *   model save from their own controls, an emptied model as none
 *
 * Failed fields, removals, and body remain copyable when a saved row
 * disappears or becomes binary.
 *
 * jsdom has no layout, focus, selection, or IME; see svelte-dom.test-support.
 */

import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ReadError } from '@epicenter/folder';
import type { WriteFailure } from '@epicenter/svelte/write-failure';
import { expectOk } from 'wellcrafted/testing';
import type { WhisperingContext } from '../../lib/folder.js';
import { quiet } from '../../lib/query.test-support.js';
import type { Whispering } from '../../lib/whispering.svelte.js';
import { closeTestWhispering } from '../../lib/whispering.test-support.js';
import { leave, type } from '../svelte-dom.test-support.js';

// Load the services after the mounted loader registered its plugin.
const { openGatedTestFolder, openTestServices, whisperingDirectory, eventually } =
	await import('../../lib/services.test-support.js');
const { flushSync, mount, unmount } = await import('svelte');
const { createTestWhispering } = await import(
	'../../lib/whispering.test-support.js'
);
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
	`---\ntitle: ${title}\nrecordedAt: 2026-10-01T00:00:00.000Z\ndurationMs: 1000\ncapture: fixture\n---\n${body}`;

test('new captures play their sibling without audioPath and conflicting formats disable transcription', async () => {
	const { context, whispering, target, root } = await open({});
	await whispering.startRecording();
	await whispering.stopRecording();
	await settle(context);
	const entry = whispering.entries[0]!;
	await show(whispering, context, entry.path);
	expect(target.querySelector('[data-testid="audio-player"]')).not.toBeNull();
	expect(
		field<HTMLButtonElement>(target, '[data-testid="transcribe"]')?.disabled,
	).toBe(false);
	await writeFile(
		join(root, entry.path.replace(/\.md$/, '.webm')),
		new Uint8Array([1, 2]),
	);
	await reportChanged(whispering, context);
	flushSync();
	expect(target.querySelector('[data-testid="audio-player"]')).toBeNull();
	expect(target.textContent).toContain(
		'More than one audio file matches this recording',
	);
	expect(
		field<HTMLButtonElement>(target, '[data-testid="transcribe"]')?.disabled,
	).toBe(true);
});

/**
 * A whispering over files on disk, mounted in the fixture with `tab` showing.
 * While `disk.refusing`, the disk refuses every write, whoever saves.
 */
async function open(
	files: Record<string, string>,
	tab: 'recordings' | 'transformations' = 'recordings',
) {
	const root = await whisperingDirectory('whispering-rows-');
	const disk = { refusing: false };
	const stubs = await openTestServices({
		folder: openGatedTestFolder(root, async () =>
			disk.refusing ? new Error('Disk unavailable') : undefined,
		),
	});
	for (const [path, text] of Object.entries(files))
		await Bun.write(join(root, path), text);
	const { whispering, context } = await createTestWhispering(stubs);
	await whispering.start();
	const notices: WriteFailure[] = [];
	whispering.onWriteFailure((notice) => notices.push(notice));
	const page = pageState({ shown: true, tab });
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { whispering, context, page } });
	cleanups.push(async () => {
		unmount(host);
		await closeTestWhispering({ whispering, context });
		await stubs.remove();
		await rm(dirname(root), { recursive: true, force: true });
	});
	return { whispering, context, page, target, notices, root, disk };
}

/** Select a file and let the views render it, with any text they read. */
async function show(
	whispering: Whispering,
	context: WhisperingContext,
	path: string,
) {
	expect(whispering.open(path)).toBe(true);
	flushSync();
	await quiet(context);
	flushSync();
}

/** Let writes and the views settle. */
async function settle(context: WhisperingContext) {
	await eventually(() => context.folder.getStatus().unsaved.every((path) => {
		const pending = context.folder.files.edit(path).getPending();
		return pending === undefined || (!pending.saving && pending.error !== undefined);
	}));
	await quiet(context);
	flushSync();
}

/**
 * Read the folder again, as a change the folder reports makes it read: this
 * process's directory opener has no watcher of other programs' edits.
 */
async function reportChanged(
	whispering: Whispering,
	context: WhisperingContext,
) {
	await whispering.readAgain();
	await settle(context);
}

const field = <T extends Element>(target: ParentNode, selector: string) =>
	target.querySelector<T>(selector);

/** What the write status line says: Saving… or Saved. */
const writeStatus = (target: ParentNode) =>
	target.querySelector('[data-testid="write-status"]')?.textContent?.trim();

test('saved file text stays shown when the reread fails, and typing on keeps it', async () => {
	const path = 'draft.txt';
	const { context, whispering, target, root } = await open({
		[path]: 'Original text',
	});
	await show(whispering, context, path);
	const input = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of draft.txt"]',
		);
	// The edit's asynchronous read can finish after the file query does.
	for (let tries = 0; tries < 500 && input() === null; tries++) {
		await Bun.sleep(2);
		flushSync();
	}
	expect(input()?.value).toBe('Original text');
	const read = context.folder.files.read;
	context.folder.files.read = async (file) =>
		file === path
			? ReadError.StorageFailed({ cause: new Error('read refused') })
			: read(file);
	cleanups.push(() => {
		context.folder.files.read = read;
	});
	type(input(), 'Committed words');
	flushSync();
	await whispering.edit(path).save();
	await reportChanged(whispering, context);
	expect(await readFile(join(root, path), 'utf8')).toBe('Committed words');
	expect(input()?.value).toBe('Committed words');

	type(input(), 'Committed words, and more');
	flushSync();
	await whispering.edit(path).save();
	await reportChanged(whispering, context);
	expect(await readFile(join(root, path), 'utf8')).toBe(
		'Committed words, and more',
	);
	expect(input()?.value).toBe('Committed words, and more');
});

test('a saved transcript stays shown when the reread fails, and typing on keeps it', async () => {
	const { context, whispering, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, context, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);
	expect(body()?.value).toBe('Alpha.\n');
	const list = context.folder.tables.transcriptions.list;
	context.folder.tables.transcriptions.list = async () =>
		ReadError.StorageFailed({ cause: new Error('read refused') });
	cleanups.push(() => {
		context.folder.tables.transcriptions.list = list;
	});
	type(body(), 'Alpha, saved.\n');
	flushSync();
	await whispering.edit(A).save();
	await reportChanged(whispering, context);
	expect(await readFile(join(root, A), 'utf8')).toBe(
		transcript('Alpha, saved.\n'),
	);
	expect(body()?.value).toBe('Alpha, saved.\n');

	type(body(), 'Alpha, saved.\nMore.\n');
	flushSync();
	await whispering.edit(A).save();
	expect(await readFile(join(root, A), 'utf8')).toBe(
		transcript('Alpha, saved.\nMore.\n'),
	);
});

test('a transcript card shows valid unsaved Source input and keeps it when returning to its body', async () => {
	const { context, whispering, target, root, disk } = await open({
		'recordings/one.md': recording('One', ''),
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, context, 'recordings/one.md');
	expect(
		target.querySelector('[data-testid="transcript-text"]'),
	).not.toBeNull();
	expect(await whispering.editSource(A)).toBeUndefined();
	whispering.edit(A).replaceText(transcript('Typed in Source.\n'));
	flushSync();
	expect(
		target.querySelector('[data-testid="transcript-text-readonly"]')
			?.textContent,
	).toBe('Typed in Source.\n');

	disk.refusing = true;
	await whispering.edit(A).save();
	flushSync();
	expect(
		target.querySelector('[data-testid="transcript-text-readonly"]')
			?.textContent,
	).toBe('Typed in Source.\n');
	expect(await whispering.useForm(A)).toBeUndefined();
	flushSync();
	expect(
		target.querySelector<HTMLTextAreaElement>('[data-testid="transcript-text"]')
			?.value,
	).toBe('Typed in Source.\n');
	expect(context.folder.files.edit(A).getPending()?.error).toBeDefined();
	expect(await readFile(join(root, A), 'utf8')).toBe(transcript('Alpha.\n'));
});

test('a transcript autosaves to its own path after switching files', async () => {
	const { context, whispering, target, notices, root } = await open({
		[A]: transcript('Alpha.\n'),
		'other.txt': 'Another file',
	});
	await show(whispering, context, A);
	const body = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Contents of a.md"]',
	);
	expect(body?.value).toBe('Alpha.\n');

	type(body, 'Alpha, typed.\n');
	flushSync();
	expect(writeStatus(target)).toBe('Saving…');
	leave(body);
	expect(context.folder.files.edit(A).getPending()?.saving).toBe(false);
	await show(whispering, context, 'other.txt');
	expect(context.folder.files.edit(A).getPending()?.saving).toBe(false);
	await settle(context);

	expect(notices).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith(
		'---\nAlpha, typed.\n',
	);
	expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('Another file');
	await show(whispering, context, A);
	expect(writeStatus(target)).toBe('Saved');
});

test('a change made elsewhere shows once the folder reports it', async () => {
	const { context, whispering, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, context, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);

	await writeFile(join(root, A), transcript('Theirs.\n'));
	// Nothing reads it until the folder says it changed.
	await settle(context);
	expect(body()?.value).toBe('Alpha.\n');
	await reportChanged(whispering, context);
	expect(body()?.value).toBe('Theirs.\n');
});

test('typing over a change made elsewhere merges with it, and the typing wins where both changed, with no notice', async () => {
	const { context, whispering, target, notices, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, context, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);

	await writeFile(join(root, A), transcript('Theirs.\n'));
	type(body(), 'Mine.\n');
	leave(body());
	await settle(context);
	expect(notices).toEqual([]);
	expect(await readFile(join(root, A), 'utf8')).toEndWith('---\nMine.\n');
	expect(body()?.value).toBe('Mine.\n');
});

test('typing into a recording deleted elsewhere brings it back with the typing: nothing typed is lost', async () => {
	const { context, whispering, target, notices, root } = await open({
		[RECORDING]: recording('Take', 'Notes.\n'),
	});
	await show(whispering, context, RECORDING);
	await rm(join(root, RECORDING));
	const notes = field(target, 'textarea[aria-label="Notes"]');
	type(notes, 'Mine.\n');
	leave(notes);
	await settle(context);

	expect(notices).toEqual([]);
	expect(await readFile(join(root, RECORDING), 'utf8')).toEndWith(
		'---\nMine.\n',
	);
	expect(whispering.selection?.path).toBe(RECORDING);
	expect(
		target.querySelector('[data-testid="recording-detail"]'),
	).not.toBeNull();
});

test('a transformation opens in Source when invalid and clears repaired diagnostics before saving', async () => {
	const broken = '---\ntitle: Clean up\n---\nTidy.\n';
	const { context, whispering, target, root } = await open(
		{ [RECIPE]: broken },
		'transformations',
	);
	await show(whispering, context, RECIPE);
	const source = () =>
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-source"]');
	const instructions = () =>
		field<HTMLButtonElement>(target, '[data-testid="tab-instructions"]');
	expect(source()?.value).toBe(broken);
	expect(
		target.querySelector('[data-testid="needs-repair"]')?.textContent,
	).toContain('model');
	expect(instructions()?.disabled).toBe(true);

	type(source(), '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n');
	flushSync();
	expect(target.querySelector('[data-testid="needs-repair"]')).toBeNull();
	expect(instructions()?.disabled).toBe(false);
	expect(context.folder.files.edit(RECIPE).getPending()).toBeDefined();
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(broken);
	leave(source());
	await settle(context);
	flushSync();
	expect(target.querySelector('[data-testid="needs-repair"]')).toBeNull();
	expect(instructions()?.disabled).toBe(false);
	expect(await whispering.useForm(RECIPE)).toBeUndefined();
	flushSync();
	expect(
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]')
			?.value,
	).toBe('Tidy.\n');
	expect(await readFile(join(root, RECIPE), 'utf8')).toContain('model: null');
});

test('a transformation’s title, model, and instructions save from their own controls; a field leaves a CRLF body as it is, and typed instructions save in LF (ADR-0572)', async () => {
	const seed = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\r\n';
	const { context, whispering, target, root } = await open(
		{ [RECIPE]: seed },
		'transformations',
	);
	await show(whispering, context, RECIPE);
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
	await settle(context);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Clean up\nmodel: chat-model\n---\nTidy.\r\n',
	);

	// An emptied model is no model: the text connection's is used.
	type(model(), ' ');
	leave(model());
	type(title(), 'Tidied');
	leave(title());
	type(prompt(), 'Tidy.\nThen check.\n');
	leave(prompt());
	await settle(context);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Tidied\nmodel: null\n---\nTidy.\nThen check.\n',
	);
	expect(prompt()?.value).toBe('Tidy.\nThen check.\n');
	expect(model()?.value).toBe('');
});

test('a recording whose audio is not in the folder says it is not on this device, and offers no player, transcription, or run again until the audio arrives', async () => {
	const { context, whispering, target, root } = await open({
		[RECORDING]: recording('Take', ''),
		// A transcription that never got its answer: running it again needs the audio.
		'transcriptions/unfinished.md':
			'---\nrecordingId: take\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\n',
	});
	const runAgain = () =>
		target.querySelector<HTMLButtonElement>('[data-testid="run-again"]');
	await show(whispering, context, RECORDING);
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
	await Bun.write(join(root, 'recordings/take.wav'), 'RIFF');
	await reportChanged(whispering, context);
	expect(absent()).toBeNull();
	expect(transcribe()?.disabled).toBe(false);
	expect(runAgain()?.disabled).toBe(false);
});

test('a recording just stopped never reads as missing its audio while the folder has not listed it yet', async () => {
	const { context, whispering, target } = await open({});
	const seen: string[] = [];
	const look = () => {
		flushSync();
		const entry = whispering.entries[0];
		if (entry !== undefined) seen.push(whispering.audioOf(entry).kind);
		if (target.querySelector('[data-testid="audio-absent"]') !== null)
			seen.push('shown absent');
	};
	await whispering.startRecording();
	look();
	const stopping = whispering.stopRecording();
	look();
	await stopping;
	look();
	await settle(context);
	look();
	expect(seen).not.toContain('absent');
	expect(seen).not.toContain('shown absent');
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
});

test('failed file text stays visible when polling finds a binary replacement', async () => {
	const path = 'draft.txt';
	const { context, whispering, target, root, disk } = await open({
		[path]: 'Original text',
	});
	await show(whispering, context, path);
	const input = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of draft.txt"]',
		);
	expect(input()?.value).toBe('Original text');
	type(input(), 'Keep this unsaved text');
	flushSync();
	disk.refusing = true;
	await whispering.edit(path).save();
	flushSync();
	disk.refusing = false;
	await writeFile(join(root, path), new Uint8Array([0, 1, 2]));
	await reportChanged(whispering, context);
	flushSync();
	expect(input()?.value).toBe('Keep this unsaved text');
	expect(whispering.isUnsaved(path)).toBe(true);
	expect(writeStatus(target)).toContain('Not saved');
});

for (const item of [
	{
		path: RECORDING,
		text: recording('Take', 'Notes.\n'),
		tab: 'recordings' as const,
	},
	{
		path: RECIPE,
		text: '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n',
		tab: 'transformations' as const,
	},
]) {
	for (const replacement of ['binary', 'missing', 'unreadable'] as const) {
		test(`failed ${item.tab} source remains visible after a ${replacement} reread`, async () => {
			const { context, whispering, target, root, disk } = await open(
				{ [item.path]: item.text },
				item.tab,
			);
			await show(whispering, context, item.path);
			expect(await whispering.editSource(item.path)).toBeUndefined();
			await settle(context);
			flushSync();
			const source = () =>
				field<HTMLTextAreaElement>(
					target,
					'textarea[aria-label="Markdown source"]',
				);
			expect(source()?.value).toBe(item.text);
			type(source(), 'Keep this failed source');
			flushSync();
			disk.refusing = true;
			await whispering.edit(item.path).save();
			disk.refusing = false;
			flushSync();
			const read = context.folder.files.read;
			if (replacement === 'binary')
				await writeFile(join(root, item.path), new Uint8Array([0, 1, 2]));
			if (replacement === 'missing') await rm(join(root, item.path));
			if (replacement === 'unreadable')
				context.folder.files.read = async (path) =>
					path === item.path
						? Promise.reject(new Error('Read unavailable'))
						: read(path);
			await reportChanged(whispering, context);
			flushSync();
			expect(source()?.value).toBe('Keep this failed source');
			expect(whispering.isUnsaved(item.path)).toBe(true);
			context.folder.files.read = read;
		});
	}
}

test('a slow audio read joins polling, keeps unchanged playback, and detects same-length replacements', async () => {
	const path = 'recordings/take.wav';
	const { context, whispering, target, root } = await open({
		[path]: 'First audio',
	});
	const read = context.folder.files.read;
	const gate = Promise.withResolvers<void>();
	let started = 0,
		active = 0,
		maximum = 0;
	context.folder.files.read = async (...args) => {
		if (args[0] !== path) return read(...args);
		started++;
		active++;
		maximum = Math.max(maximum, active);
		try {
			await gate.promise;
			return await read(...args);
		} finally {
			active--;
		}
	};
	cleanups.push(() => {
		context.folder.files.read = read;
		gate.resolve();
	});
	whispering.open(path);
	flushSync();
	for (let n = 0; n < 100 && started === 0; n++) {
		await Bun.sleep(5);
		flushSync();
	}
	expect(started).toBe(1);
	await Bun.sleep(2_300);
	flushSync();
	expect(started).toBe(1);
	expect(maximum).toBe(1);
	gate.resolve();
	await settle(context);
	flushSync();
	const player = () => target.querySelector<HTMLAudioElement>('audio');
	expect(player()).not.toBeNull();
	const url = player()!.src;
	await context.refresh([path]);
	flushSync();
	expect(player()!.src).toBe(url);
	const playing = player();
	context.folder.files.read = async (file) =>
		file === path
			? Promise.reject(new Error('Audio temporarily unreadable'))
			: read(file);
	await context.refresh([path]);
	flushSync();
	expect(player()).toBe(playing);
	expect(player()!.src).toBe(url);
	expect(target.textContent).toContain('Audio temporarily unreadable');
	context.folder.files.read = read;
	await writeFile(join(root, path), 'Other audio');
	await context.refresh([path]);
	flushSync();
	expect(player()!.src).not.toBe(url);
	expect(maximum).toBe(1);
}, 8_000);

for (const item of [
	{
		path: RECORDING,
		text: recording('Take', 'Notes.\n'),
		tab: 'recordings' as const,
		table: 'recordings' as const,
		id: 'take',
		remove: 'durationMs',
		label: 'Unsaved recording changes',
	},
	{
		path: RECIPE,
		text: '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n',
		tab: 'transformations' as const,
		table: 'transformations' as const,
		id: 'clean',
		remove: 'model',
		label: 'Unsaved transformation changes',
	},
]) {
	for (const replacement of ['missing', 'binary'] as const) {
		test(`failed ${item.tab} fields remain reachable after a ${replacement} reread`, async () => {
			const { context, whispering, target, root, disk } = await open(
				{ [item.path]: item.text },
				item.tab,
			);
			await show(whispering, context, item.path);
			disk.refusing = true;
			const view = whispering.edit(item.table, item.path);
			expect(view.markdown).toBeDefined();
			expectOk(
				view.change({
					fields: { title: 'Keep my title', [item.remove]: undefined },
					body: 'Keep my notes',
				}),
			);
			await view.save();
			await settle(context);
			disk.refusing = false;
			expect(whispering.isUnsaved(item.path)).toBe(true);
			if (replacement === 'missing') await rm(join(root, item.path));
			else await writeFile(join(root, item.path), new Uint8Array([0, 1, 2]));
			await reportChanged(whispering, context);
			if (replacement === 'binary')
				await context.folder.files.edit(item.path).read();
			flushSync();
			const retained = target.querySelector<HTMLTextAreaElement>(
				`textarea[aria-label="${item.label}"]`,
			);
			expect(JSON.parse(retained!.value)).toEqual({
				set: { title: 'Keep my title' },
				remove: [item.remove],
				body: 'Keep my notes',
			});
			expect(writeStatus(target)).toContain('Not saved');
		});
	}
}

for (const item of [
	{
		path: RECORDING,
		repaired: recording('Repaired', 'Notes.\n'),
		tab: 'recordings' as const,
	},
	{
		path: RECIPE,
		repaired: '---\ntitle: Repaired\nmodel: null\n---\nTidy.\n',
		tab: 'transformations' as const,
	},
]) {
	for (const replacement of ['missing', 'repaired'] as const) {
		test(`automatically opened ${item.tab} source keeps its failed draft after a ${replacement} reread`, async () => {
			const { context, whispering, target, root, disk } = await open(
				{ [item.path]: 'Malformed row\n' },
				item.tab,
			);
			await show(whispering, context, item.path);
			const source = () =>
				field<HTMLTextAreaElement>(
					target,
					'textarea[aria-label="Markdown source"]',
				);
			expect(source()?.value).toBe('Malformed row\n');
			type(source(), 'Keep my automatic Source draft');
			flushSync();
			disk.refusing = true;
			await whispering.edit(item.path).save();
			disk.refusing = false;
			if (replacement === 'missing') await rm(join(root, item.path));
			else await writeFile(join(root, item.path), item.repaired);
			await reportChanged(whispering, context);
			expect(source()?.value).toBe('Keep my automatic Source draft');
			expect(whispering.isUnsaved(item.path)).toBe(true);
		});
	}
}

for (const replacement of ['missing', 'binary'] as const) {
	test(`failed transcript body remains copyable after a ${replacement} reread`, async () => {
		const { context, whispering, target, root, disk } = await open({
			[A]: transcript('Alpha.\n'),
		});
		await show(whispering, context, A);
		disk.refusing = true;
		type(
			field<HTMLTextAreaElement>(
				target,
				'textarea[aria-label="Contents of a.md"]',
			),
			'Keep my transcript',
		);
		flushSync();
		await whispering.edit(A).save();
		disk.refusing = false;
		if (replacement === 'missing') await rm(join(root, A));
		else await writeFile(join(root, A), new Uint8Array([0, 1, 2]));
		await reportChanged(whispering, context);
		if (replacement === 'binary') await context.folder.files.edit(A).read();
		flushSync();
		expect(
			field<HTMLTextAreaElement>(
				target,
				'textarea[aria-label="Unsaved file changes"]',
			)?.value,
		).toContain('Keep my transcript');
		expect(writeStatus(target)).toContain('Not saved');
	});
}

test('a Source control remains mounted after external repair and keeps failed input until explicitly returning to fields', async () => {
	const { whispering, context, target, root, disk } = await open(
		{ [RECIPE]: 'Needs a header' },
		'transformations',
	);
	await show(whispering, context, RECIPE);
	const source = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Markdown source"]',
	);
	expect(source).not.toBeNull();
	await writeFile(
		join(root, RECIPE),
		'---\ntitle: Repaired\nmodel: null\n---\nValid instructions\n',
	);
	await reportChanged(whispering, context);
	flushSync();
	expect(target.querySelector('textarea[aria-label="Markdown source"]')).toBe(
		source,
	);
	disk.refusing = true;
	type(source, '---\ntitle: Typed\nmodel: null\n---\nFailed instructions\n');
	await whispering.edit(RECIPE).save();
	flushSync();
	expect(target.querySelector('textarea[aria-label="Markdown source"]')).toBe(
		source,
	);
	expect(source?.value).toContain('Failed instructions');
	expect(whispering.isUnsaved(RECIPE)).toBe(true);
	expect(whispering.useForm(RECIPE)).toBeUndefined();
	flushSync();
	expect(
		target.querySelector('textarea[aria-label="Markdown source"]'),
	).toBeNull();
	expect(
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]')
			?.value,
	).toContain('Failed instructions');
	disk.refusing = false;
});

test('transformation controls share the mounted app state across remounts and isolate another app', async () => {
	const files = { [RECIPE]: '---\ntitle: Clean up\n---\nTidy.\n' };
	const first = await open(files, 'transformations');
	await show(first.whispering, first.context, RECIPE);
	const { view } = first.whispering;
	view.applyTo = 'transcriptions/a.md';
	view.applySource = 'pasted';
	field<HTMLButtonElement>(first.target, '[data-testid="tab-try"]')!.click();
	flushSync();
	type(
		field<HTMLTextAreaElement>(first.target, '[data-testid="pasted-text"]'),
		'Keep this input',
	);
	flushSync();
	expect(view.pastedText).toBe('Keep this input');
	first.page.shown = false;
	flushSync();
	view.pastedText += ' while hidden';
	first.page.shown = true;
	flushSync();
	field<HTMLButtonElement>(first.target, '[data-testid="tab-try"]')!.click();
	flushSync();
	expect(
		field<HTMLTextAreaElement>(first.target, '[data-testid="pasted-text"]')!
			.value,
	).toBe('Keep this input while hidden');
	expect(view.applyTo).toBe('transcriptions/a.md');
	expect(view.applySource).toBe('pasted');

	const second = await open(files, 'transformations');
	await show(second.whispering, second.context, RECIPE);
	field<HTMLButtonElement>(second.target, '[data-testid="tab-try"]')!.click();
	flushSync();
	field<HTMLButtonElement>(
		second.target,
		'[data-testid="apply-pasted"]',
	)!.click();
	flushSync();
	type(
		field<HTMLTextAreaElement>(second.target, '[data-testid="pasted-text"]'),
		'Another app',
	);
	flushSync();
	expect(second.whispering.view.pastedText).toBe('Another app');
	expect(second.whispering.view.applyTo).toBeUndefined();
	expect(view.pastedText).toBe('Keep this input while hidden');
});
