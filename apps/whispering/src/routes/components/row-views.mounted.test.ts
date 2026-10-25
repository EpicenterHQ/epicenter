/**
 * Row views, mounted.
 *
 * The real whispering over a folder (the Bun opener over a real directory,
 * or memory where a test holds a save), and the real FileView,
 * RecordingDetail, and TransformationDetail components mounted in jsdom
 * inside a fixture that renders them as the recordings and transformations
 * pages do.
 *
 * Key behaviors:
 * - typing in a view saves to the path it shows, through a draft that shows
 *   what was typed until its save answers
 * - a change made elsewhere shows once the folder looks again
 * - a row file whose text is not a valid row opens as its text with its
 *   issues, which follow the text as it is typed, and its fields open once
 *   the text reads
 * - a title and a model save from their own controls, an emptied model as
 *   none, and typed instructions save in LF (ADR-0572)
 * - a file shows by what the folder holds of it: text to edit, bytes that
 *   are not UTF-8, audio to play, a file the folder does not keep, a read
 *   that failed, or no file at all
 *
 * jsdom has no layout, focus, selection, or IME; see svelte-dom.test-support.
 */

// The mounted loader registers its plugin before anything loads a runes module.
import { leave, type } from '../svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SaveError } from '@epicenter/folder/next/testing';
import { Err } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { WhisperingFolder } from '../../lib/folder.js';
import type { Whispering } from '../../lib/whispering.svelte.js';

// Load the services after the mounted loader registered its plugin.
const { closeTestWhispering } = await import(
	'../../lib/whispering.test-support.js'
);
const {
	deferred,
	openMemoryTestFolder,
	openTestFolder,
	openTestServices,
	waitForSaves,
	whisperingDirectory,
	eventually,
} = await import('../../lib/services.test-support.js');
const { flushSync, mount, unmount } = await import('svelte');
const { toneWav } = await import('../../lib/capture.js');
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

/**
 * A whispering over a folder holding `files`, mounted in the fixture with
 * `tab` showing: a real directory, or with `memory`, storage a test can hold.
 */
async function open(
	files: Record<string, string | Uint8Array>,
	tab: 'recordings' | 'transformations' = 'recordings',
	{ memory = false }: { memory?: boolean } = {},
) {
	const root = await whisperingDirectory('whispering-rows-');
	cleanups.push(() => rm(dirname(root), { recursive: true, force: true }));
	for (const [path, data] of Object.entries(files))
		await Bun.write(join(root, path), data);
	const inMemory = memory ? await openMemoryTestFolder(files) : undefined;
	const stubs = await openTestServices({
		folder: inMemory ?? (await openTestFolder(root)),
	});
	const { folder } = stubs;
	const { whispering } = await createTestWhispering(stubs);
	await whispering.start();
	const page = pageState({ shown: true, tab });
	const target = document.createElement('main');
	document.body.append(target);
	const host = mount(Host, { target, props: { whispering, folder, page } });
	cleanups.push(async () => {
		unmount(host);
		closeTestWhispering({ whispering, folder });
		await stubs.remove();
	});
	return {
		whispering,
		folder,
		page,
		target,
		root,
		host: inMemory?.host,
	};
}

/** Select a file and let the views render it. */
async function show(
	whispering: Whispering,
	folder: WhisperingFolder,
	path: string,
) {
	expect(whispering.open(path)).toBe(true);
	flushSync();
	await settle(folder);
}

/** Let writes land and the views follow them. */
async function settle(folder: WhisperingFolder) {
	// Mounted drafts debounce before the folder's saving flag changes.
	await new Promise((resolve) => setTimeout(resolve, 1050));
	await waitForSaves(folder);
	flushSync();
}

/** Look at the folder again, as focus or another program's change does, and let the views follow. */
async function lookAgain(folder: WhisperingFolder, until: () => boolean) {
	folder.refresh();
	await eventually(() => {
		flushSync();
		return until();
	});
}

const field = <T extends Element>(target: ParentNode, selector: string) =>
	target.querySelector<T>(selector);

test('new captures play their sibling without audioPath and conflicting formats disable transcription', async () => {
	const { folder, whispering, target } = await open({});
	await whispering.startRecording();
	await whispering.stopRecording();
	await settle(folder);
	const entry = whispering.entries[0]!;
	await show(whispering, folder, entry.path);
	await eventually(() => {
		flushSync();
		return target.querySelector('[data-testid="audio-player"]') !== null;
	});
	expect(
		field<HTMLButtonElement>(target, '[data-testid="transcribe"]')?.disabled,
	).toBe(false);
	expectOk(
		await folder.write(
			entry.path.replace(/\.md$/, '.webm'),
			new Uint8Array([1, 2]),
		),
	);
	flushSync();
	expect(target.querySelector('[data-testid="audio-player"]')).toBeNull();
	expect(target.textContent).toContain(
		'More than one audio file matches this recording',
	);
	expect(
		field<HTMLButtonElement>(target, '[data-testid="transcribe"]')?.disabled,
	).toBe(true);
});

test('a transcript saves to its own path after switching files', async () => {
	const { folder, whispering, target, root } = await open({
		[A]: transcript('Alpha.\n'),
		'other.txt': 'Another file',
	});
	await show(whispering, folder, A);
	const body = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Contents of a.md"]',
	);
	expect(body?.value).toBe('Alpha.\n');

	type(body, 'Alpha, typed.\n');
	flushSync();
	// What was typed shows at once, before its save answers.
	expect(body?.value).toBe('Alpha, typed.\n');
	leave(body);
	await show(whispering, folder, 'other.txt');
	await settle(folder);

	expect(await readFile(join(root, A), 'utf8')).toEndWith(
		'---\nAlpha, typed.\n',
	);
	expect(await readFile(join(root, 'other.txt'), 'utf8')).toBe('Another file');
	await show(whispering, folder, A);
	expect(
		field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of a.md"]')
			?.value,
	).toBe('Alpha, typed.\n');
});

test('a failed text edit stays visible until Save again succeeds or Discard follows disk', async () => {
	const { folder, whispering, target, host } = await open(
		{ 'note.txt': 'On disk' },
		'recordings',
		{ memory: true },
	);
	await show(whispering, folder, 'note.txt');
	const editor = () => field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of note.txt"]');
	const button = (label: string) =>
		[...target.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
	host!.control.failPut.set('note.txt', SaveError.StorageFailed({ cause: 'disk full' }).error);
	type(editor(), 'First edit');
	await settle(folder);
	expect(editor()?.value).toBe('First edit');
	expect(host!.text('note.txt')).toBe('On disk');
	expect(target.textContent).toContain('Not saved:');
	expect(button('Save again')).toBeDefined();

	host!.control.failPut.delete('note.txt');
	button('Save again')?.click();
	await settle(folder);
	expect(host!.text('note.txt')).toBe('First edit');
	expect(target.textContent).not.toContain('Not saved:');

	host!.control.failPut.set('note.txt', SaveError.StorageFailed({ cause: 'disk full' }).error);
	type(editor(), 'Second edit');
	await settle(folder);
	expect(editor()?.value).toBe('Second edit');
	button('Discard')?.click();
	flushSync();
	expect(editor()?.value).toBe('First edit');
	expect(target.textContent).not.toContain('Not saved:');
});

test('a whole-file text draft recreates a file deleted outside the mirror', async () => {
	const { folder, whispering, target, host } = await open(
		{ 'note.txt': 'Before' },
		'recordings',
		{ memory: true },
	);
	await show(whispering, folder, 'note.txt');
	host!.outside('note.txt', null, { hint: false });
	type(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of note.txt"]'), 'Recreated');
	await settle(folder);
	expect(host!.text('note.txt')).toBe('Recreated');
	expect(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of note.txt"]')?.value).toBe('Recreated');
});

test('switching a recording to Source follows its title when the save lands', async () => {
	const { folder, whispering, target, host } = await open(
		{ [RECORDING]: recording('Before', '') },
		'recordings',
		{ memory: true },
	);
	await show(whispering, folder, RECORDING);
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	type(field<HTMLInputElement>(target, 'input[aria-label="Recording title"]'), 'After');
	type(field<HTMLInputElement>(target, 'input[aria-label="Recording title"]'), 'Latest');
	const sourceTab = [...target.querySelectorAll<HTMLButtonElement>('button')].find(
		(item) => item.textContent?.trim() === 'Source',
	);
	sourceTab?.click();
	flushSync();
	expect(target.querySelector('textarea[aria-label="Markdown source"]')).not.toBeNull();
	host!.control.putGate = undefined;
	release.resolve();
	await eventually(() => {
		flushSync();
		return host!.text(RECORDING)?.includes('title: Latest') === true;
	});
	expect(host!.text(RECORDING)).toContain('title: Latest');
	expect(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Markdown source"]')?.value).toContain('title: Latest');
});

test('a change made elsewhere shows once the folder looks again', async () => {
	const { folder, whispering, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, folder, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);
	expect(body()?.value).toBe('Alpha.\n');

	await writeFile(join(root, A), transcript('Theirs, and longer.\n'));
	await lookAgain(folder, () => body()?.value === 'Theirs, and longer.\n');
});

test('typing over an outside change sets the body over it and keeps its fields', async () => {
	const { folder, whispering, target, root } = await open({
		[A]: transcript('Alpha.\n'),
	});
	await show(whispering, folder, A);
	const body = () =>
		field<HTMLTextAreaElement>(
			target,
			'textarea[aria-label="Contents of a.md"]',
		);

	await writeFile(
		join(root, A),
		transcript('Theirs.\n').replace('model: m', 'model: theirs'),
	);
	type(body(), 'Mine.\n');
	leave(body());
	await settle(folder);
	const saved = await readFile(join(root, A), 'utf8');
	expect(saved).toEndWith('---\nMine.\n');
	expect(saved).toContain('model: theirs');
	expect(body()?.value).toBe('Mine.\n');
});

test('a transformation opens in Source when invalid, and its issues follow the text as it is typed, before it saves', async () => {
	const broken = '---\ntitle: Clean up\n---\nTidy.\n';
	const { folder, host, whispering, target } = await open(
		{ [RECIPE]: broken },
		'transformations',
		{ memory: true },
	);
	await show(whispering, folder, RECIPE);
	const source = () =>
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-source"]');
	const instructions = () =>
		field<HTMLButtonElement>(target, '[data-testid="tab-instructions"]');
	expect(source()?.value).toBe(broken);
	expect(
		target.querySelector('[data-testid="needs-repair"]')?.textContent,
	).toContain('model');
	expect(instructions()?.disabled).toBe(true);

	// The save is held: what shows is the typed text, checked as it is.
	const release = deferred<void>();
	host!.control.putGate = release.promise;
	const repaired = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\n';
	type(source(), repaired);
	flushSync();
	expect(target.querySelector('[data-testid="needs-repair"]')).toBeNull();
	expect(instructions()?.disabled).toBe(false);
	expect(host!.text(RECIPE)).toBe(broken);
	// Broken again as it is typed, the issues come back.
	type(source(), broken);
	flushSync();
	expect(target.querySelector('[data-testid="needs-repair"]')).not.toBeNull();
	type(source(), repaired);
	flushSync();
	instructions()?.click();
	flushSync();
	expect(host!.text(RECIPE)).toBe(broken);
	expect(source()).not.toBeNull();
	host!.control.putGate = undefined;
	release.resolve();
	await eventually(() => {
		flushSync();
		return field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]') !== null;
	});
	expect(host!.text(RECIPE)).toBe(repaired);
	expect(target.querySelector('[data-testid="needs-repair"]')).toBeNull();
	expect(
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]')
			?.value,
	).toBe('Tidy.\n');
});

test('a transformation’s title, model, and instructions save from their own controls; typed instructions save in LF (ADR-0572)', async () => {
	const seed = '---\ntitle: Clean up\nmodel: null\n---\nTidy.\r\n';
	const { folder, whispering, target, root } = await open(
		{ [RECIPE]: seed },
		'transformations',
	);
	await show(whispering, folder, RECIPE);
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
	await settle(folder);
	expect(await readFile(join(root, RECIPE), 'utf8')).toContain(
		'model: chat-model\n',
	);

	// An emptied model is no model: the text connection's is used.
	type(model(), ' ');
	await settle(folder);
	type(title(), 'Tidied');
	await settle(folder);
	type(prompt(), 'Tidy.\nThen check.\n');
	await settle(folder);
	expect(await readFile(join(root, RECIPE), 'utf8')).toBe(
		'---\ntitle: Tidied\nmodel: null\n---\nTidy.\nThen check.\n',
	);
	expect(prompt()?.value).toBe('Tidy.\nThen check.\n');
	expect(model()?.value).toBe('');
}, 10000);

test('a recording whose audio is not in the folder says it is not on this device, and offers no player, transcription, or run again until the audio arrives', async () => {
	const { folder, whispering, target } = await open({
		[RECORDING]: recording('Take', ''),
		// A transcription that never got its answer: running it again needs the audio.
		'transcriptions/unfinished.md':
			'---\nrecordingId: take\ncreatedAt: 2026-10-01T00:00:00.000Z\nmodel: m\nendpoint: http://127.0.0.1:18080/v1\n---\n',
	});
	const runAgain = () =>
		target.querySelector<HTMLButtonElement>('[data-testid="run-again"]');
	await show(whispering, folder, RECORDING);
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
	expectOk(await folder.write('recordings/take.wav', toneWav()));
	flushSync();
	expect(absent()).toBeNull();
	expect(transcribe()?.disabled).toBe(false);
	expect(runAgain()?.disabled).toBe(false);
});

test('a recording just stopped never reads as missing its audio while the folder has not listed it yet', async () => {
	const { folder, whispering, target } = await open({});
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
	await settle(folder);
	look();
	expect(seen).not.toContain('absent');
	expect(seen).not.toContain('shown absent');
	expect(whispering.audioOf(whispering.entries[0]!).kind).toBe('here');
});

test('a Source control stays mounted after an outside repair, and the fields open when asked', async () => {
	const { folder, whispering, target, root } = await open(
		{ [RECIPE]: 'Needs a header' },
		'transformations',
	);
	await show(whispering, folder, RECIPE);
	const source = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Markdown source"]',
	);
	expect(source).not.toBeNull();
	const repaired =
		'---\ntitle: Repaired\nmodel: null\n---\nValid instructions\n';
	await writeFile(join(root, RECIPE), repaired);
	await lookAgain(folder, () => source?.value === repaired);
	expect(target.querySelector('textarea[aria-label="Markdown source"]')).toBe(
		source,
	);
	expect(whispering.useForm(RECIPE, repaired)).toBeUndefined();
	flushSync();
	expect(
		target.querySelector('textarea[aria-label="Markdown source"]'),
	).toBeNull();
	expect(
		field<HTMLTextAreaElement>(target, '[data-testid="transformation-prompt"]')
			?.value,
	).toBe('Valid instructions\n');
});

test('transformation controls share the mounted app state across remounts and isolate another app', async () => {
	const files = { [RECIPE]: '---\ntitle: Clean up\n---\nTidy.\n' };
	const first = await open(files, 'transformations');
	await show(first.whispering, first.folder, RECIPE);
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
	await show(second.whispering, second.folder, RECIPE);
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

// ============================================================================
// What a file shows, by what the folder holds of it
// ============================================================================

/** Whether the file's Rename and Delete controls are shown. */
const offersRenameAndDelete = (target: ParentNode) =>
	['Rename file', 'Delete'].every((text) =>
		[...target.querySelectorAll('button')].some(
			(button) => button.textContent?.trim() === text,
		),
	);

test('a text file the folder keeps opens as editable text, .gitignore included', async () => {
	const { folder, whispering, target, root } = await open({
		'.gitignore': '# mine\n',
	});
	await show(whispering, folder, '.gitignore');
	const text = field<HTMLTextAreaElement>(
		target,
		'textarea[aria-label="Contents of .gitignore"]',
	);
	expect(text?.value).toContain('# mine');
	type(text, `${text!.value}/private/\n`);
	await settle(folder);
	expect(await readFile(join(root, '.gitignore'), 'utf8')).toEndWith(
		'/private/\n',
	);
});

test('a kept file whose bytes are not UTF-8 is listed, not opened', async () => {
	const { folder, whispering, target } = await open({
		'notes/odd.txt': new Uint8Array([0xff, 0xfe, 0x00]),
	});
	await show(whispering, folder, 'notes/odd.txt');
	expect(
		target.querySelector('[data-testid="file-not-text"]')?.textContent,
	).toContain('not UTF-8 text');
	expect(target.querySelector('textarea')).toBeNull();
	expect(offersRenameAndDelete(target)).toBe(true);
});

test('a file the folder does not keep is listed, not opened, and can still be renamed or deleted', async () => {
	const { folder, whispering, target, root } = await open({
		'scripts/run.py': 'print("hi")\n',
	});
	expect(folder.file('scripts/run.py')).toMatchObject({
		data: undefined,
		readError: null,
	});
	await show(whispering, folder, 'scripts/run.py');
	expect(
		target.querySelector('[data-testid="file-not-opened"]')?.textContent,
	).toContain('listed here but not opened');
	expect(target.querySelector('textarea')).toBeNull();
	expect(offersRenameAndDelete(target)).toBe(true);
	expect(await whispering.rename('scripts/run.py', 'start.py')).toBeUndefined();
	expect(await readFile(join(root, 'scripts', 'start.py'), 'utf8')).toBe(
		'print("hi")\n',
	);
});

test('audio the folder does not keep plays from its bytes', async () => {
	const { folder, whispering, target } = await open({
		'clips/loose.wav': toneWav(),
	});
	await show(whispering, folder, 'clips/loose.wav');
	expect(target.querySelector('[data-testid="audio-file-view"]')).not.toBeNull();
	await eventually(() => {
		flushSync();
		return target.querySelector('[data-testid="audio-player"]') !== null;
	});
});

test('a file whose read failed says so and reads again on Try again', async () => {
	const path = 'notes/locked.txt';
	const { folder, host, whispering, target } = await open(
		{ [path]: 'Readable\n' },
		'recordings',
		{ memory: true },
	);
	await show(whispering, folder, path);
	const editor = field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of locked.txt"]');
	expect(editor?.value).toBe('Readable\n');
	// Storage refuses reads of the file, and another program changes it.
	const read = host!.storage.read;
	host!.storage.read = async (paths) => {
		const answer = new Map(await read(paths));
		if (paths.includes(path))
			answer.set(
				path,
				Err({
					name: 'StorageFailed',
					message: 'Repository read failed: read refused',
					cause: new Error('read refused'),
				}),
			);
		return answer;
	};
	host!.outside(path, 'Changed, and now unreadable\n');
	await eventually(() => {
		flushSync();
		return target.querySelector('[role="alert"]')?.textContent?.includes('read refused') === true;
	});
	expect(target.textContent).toContain('read refused');
	expect(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of locked.txt"]')).toBe(editor);
	host!.storage.read = read;
	const tryAgain = [...target.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Try again',
	);
	tryAgain!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
	await eventually(() => {
		flushSync();
		return (
			field<HTMLTextAreaElement>(
				target,
				'textarea[aria-label="Contents of locked.txt"]',
			)?.value === 'Changed, and now unreadable\n'
		);
	});
});

test('saved file text stays editable when a later read fails', async () => {
	const path = 'notes/editable.txt';
	const { folder, host, whispering, target } = await open({ [path]: 'First\n' }, 'recordings', { memory: true });
	await show(whispering, folder, path);
	const editor = field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of editable.txt"]');
	const read = host!.storage.read;
	host!.storage.read = async (paths) => {
		const answer = new Map(await read(paths));
		if (paths.includes(path)) answer.set(path, Err({ name: 'StorageFailed', message: 'Read refused', cause: new Error('read refused') }));
		return answer;
	};
	host!.outside(path, 'Outside\n');
	await eventually(() => {
		flushSync();
		return target.textContent?.includes('Read refused') === true;
	});
	expect(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of editable.txt"]')).toBe(editor);
	type(editor, 'Typed on\n');
	await settle(folder);
	expect(host!.text(path)).toBe('Typed on\n');
	expect(field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of editable.txt"]')).toBe(editor);
});

test('rename writes the mounted editor draft before copying', async () => {
	const path = 'notes/draft.txt';
	const { folder, host, whispering, target } = await open({ [path]: 'Old\n' }, 'recordings', { memory: true });
	await show(whispering, folder, path);
	const editor = field<HTMLTextAreaElement>(target, 'textarea[aria-label="Contents of draft.txt"]');
	type(editor, 'New draft\n');
	const gate = deferred<void>();
	host!.control.putGate = gate.promise;
	const renaming = whispering.rename(path, 'renamed.txt');
	await eventually(() => host!.log.puts.some((put) => put.path === path));
	type(editor, 'Newest draft\n');
	host!.control.putGate = undefined;
	gate.resolve();
	expect(await renaming).toBeUndefined();
	await settle(folder);
	expect(host!.text('notes/renamed.txt')).toBe('Newest draft\n');
	expect(host!.text(path)).toBeUndefined();
});

test('rename writes a transcript draft from the recording card', async () => {
	const { folder, host, whispering, target } = await open({
		[RECORDING]: recording('Take', ''),
		[A]: transcript('Old words\n').replace('recordingId: one', 'recordingId: take'),
	}, 'recordings', { memory: true });
	await show(whispering, folder, RECORDING);
	const editor = field<HTMLTextAreaElement>(target, '[data-testid="transcript-text"]');
	type(editor, 'New words\n');
	expect(await whispering.rename(A, 'renamed.md')).toBeUndefined();
	await settle(folder);
	expect(host!.text('transcriptions/renamed.md')).toContain('New words\n');
	expect(host!.text(A)).toBeUndefined();
});

test('a file that left the folder is no longer shown', async () => {
	const { folder, whispering, target } = await open({
		'notes/gone.txt': 'Here for now\n',
	});
	await show(whispering, folder, 'notes/gone.txt');
	expect(target.querySelector('textarea')).not.toBeNull();
	expectOk(await folder.delete('notes/gone.txt'));
	flushSync();
	// The selection lets a file go once the folder shows it gone.
	expect(whispering.selection).toBeUndefined();
	expect(target.querySelector('textarea')).toBeNull();
	expect(offersRenameAndDelete(target)).toBe(false);
});
