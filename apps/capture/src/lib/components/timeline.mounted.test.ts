/**
 * Mounted Timeline Tests
 *
 * The real `Timeline` and composition views, compiled for the
 * client and mounted in jsdom inside the folder's query client, over the
 * real Capture store and a real local folder on an in-memory IndexedDB.
 *
 * Key behaviors:
 * - Composition text lives in Folder, which outlives the view; detached
 *   text controls and forms accept no late input
 * - A file that is not a valid capture is named with why, and opens as text
 * - Add capture promotes the same file without a second draft buffer
 * - A capture whose save failed is named, with why, and opens from there
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { openCaptures, until } = await import('../local-folder.test-support.js');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');

// A desktop-width window: `min-width` queries match, so the UI kit's modal
// renders as a dialog.
setWide(true);

/** The textarea or input with this id, or `null`. */
const field = (id: string) =>
	document.getElementById(id) as HTMLTextAreaElement | null;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
});

async function setup(files: Record<string, string> = {}) {
	const harness = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures },
	});
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
	};
	cleanup.push(async () => {
		close();
		await harness.close();
	});
	await harness.quiet();
	flushSync();
	return { ...harness, close };
}

/** Create a draft and return the composition's text box. */
async function openNewCapture() {
	click(document, 'New capture');
	flushSync();
	await until(() => field('new-capture') !== null, 'the composition to open');
	flushSync();
	const box = field('new-capture');
	if (box === null) throw new Error('the composition did not open');
	return box;
}

test('the composition text box writes nothing after its view is gone', async () => {
	const t = await setup();
	expect(document.body.textContent).toContain('No captures yet');
	const box = await openNewCapture();
	type(box, 'typed in the dialog');
	const stem = t.captures.opened?.stem;
	if (stem === undefined) throw new Error('Expected an open composition');
	const edit = t.folder.tables.captures.edit(stem);
	expect(edit.getRow()?.body).toBe('typed in the dialog');

	t.close();
	flushSync();
	type(box, 'delivered after the timeline went');
	expect(edit.getRow()?.body).toBe('typed in the dialog');
	expect(t.captures.fenced).toBe(false);
});

test('a file that is not a valid capture is named with why, and Edit as text opens it', async () => {
	const t = await setup({
		'captures/broken.md': '---\ncapturedAt: nope\n---\n\nBroken\n',
	});
	expect(document.body.textContent).toContain('captures/broken.md');
	expect(document.body.textContent).toContain('capturedAt');
	click(document, 'Edit as text');
	await t.quiet();
	flushSync();
	expect(t.captures.opened).toEqual({ stem: 'broken', mode: 'text' });
	expect(document.body.textContent).toContain('Needs repair');
});

test('Add capture promotes the same file and opens its thoughts', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'Written in the dialog');
	flushSync();
	click(document, 'Add capture');
	await until(() => field('new-thought') !== null, 'the capture thoughts to open');
	await t.quiet();
	flushSync();
	const stem = t.captures.opened?.stem;
	expect(t.cached(stem ?? '')?.fields.draft).toBeUndefined();
	expect(await t.text(`captures/${stem}.md`)).toContain(
		'\nWritten in the dialog\n\n## Thoughts\n',
	);
});

test('a capture whose save failed is named, with why, and opens from there', async () => {
	const t = await setup({
		'captures/one.md': '---\ncapturedAt: 2026-10-04T20:49:23Z\n---\n\nText\n',
	});
	const restore = t.failSaves();
	// Typed in the capture's form, as its detail types.
	const form = t.captures.formOf('one');
	form.inputText('Edited');
	await form.flush();
	restore();
	flushSync();

	const notice = document.querySelector('[aria-label="Not saved"]');
	expect(notice?.textContent).toContain('captures/one.md');
	expect(notice?.textContent).toContain('the disk is full');
	// The failed edit stays held, so nothing settles: wait for the capture to open.
	click(document, 'Open');
	await until(() => t.captures.opened !== undefined, 'the capture to open');
	expect(t.captures.opened).toEqual({ stem: 'one', mode: 'capture' });
});

test('a failed promotion keeps the raw composer visible and retry adds it once', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'My original writing');
	await t.quiet();
	const stem = t.captures.opened?.stem;
	const restore = t.failSaves();
	click(document, 'Add capture');
	await until(() => document.body.textContent?.includes('The capture was not added') ?? false, 'the Add failure');
	expect(field('new-capture')?.value).toBe('My original writing');
	expect(document.body.textContent).toContain('Your draft is still here');
	restore();
	click(document, 'Add capture');
	await until(() => field('new-thought') !== null, 'the completed capture');
	await t.quiet();
	expect((await t.text(`captures/${stem}.md`))?.match(/^## Thoughts$/gm)).toHaveLength(1);
});

test('a failed composition autosave exposes retry and keeps its writing', async () => {
	const t = await setup();
	const box = await openNewCapture();
	const restore = t.failSaves();
	type(box, '```ts\nstill writing');
	await until(() => document.body.textContent?.includes('Your draft is not saved') ?? false, 'the autosave failure');
	expect(field('new-capture')?.value).toBe('```ts\nstill writing');
	restore();
	click(document, 'Save again');
	await t.quiet();
	expect(document.body.textContent).not.toContain('Your draft is not saved');
	expect(await t.text(`captures/${t.captures.opened?.stem}.md`)).toContain('```ts\nstill writing');
});

test('stale composer events after Add cannot replace the completed capture', async () => {
	const t = await setup();
	const box = await openNewCapture();
	const form = box.form;
	type(box, 'Final writing');
	flushSync();
	click(document, 'Add capture');
	await until(() => field('new-thought') !== null, 'the completed capture');
	const path = `captures/${t.captures.opened?.stem}.md`;
	const before = await t.text(path);
	expect(before).toContain('\nFinal writing\n\n## Thoughts\n');
	type(box, 'Late raw writing');
	form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await t.quiet();
	expect(await t.text(path)).toBe(before);
});

test('an external promotion refuses raw input before the composer has unmounted', async () => {
	const t = await setup();
	const box = await openNewCapture();
	const stem = t.captures.opened?.stem;
	if (stem === undefined) throw new Error('Expected a draft');
	type(box, 'Final writing');
	await t.quiet();
	const edit = t.folder.tables.captures.edit(stem);
	let attemptedWhileMounted = false;
	const stop = edit.subscribe(() => {
		const row = edit.getRow();
		if (attemptedWhileMounted || edit.isLocked() || row?.issues !== null || row.fields.draft === true) return;
		attemptedWhileMounted = box.isConnected;
		type(box, 'Late raw input');
	});
	try {
		const path = `captures/${stem}.md`;
		const completed = '---\ncapturedAt: 2026-10-21T10:00:00Z\n---\n\nFinal writing\n\n## Thoughts\n';
		await t.writeElsewhere(path, completed);
		await edit.read();
		await until(() => field('new-thought') !== null, 'the external promotion');
		expect(attemptedWhileMounted).toBe(true);
		expect(edit.getPending()).toBeUndefined();
		expect(await t.text(path)).toBe(completed);
	} finally {
		stop();
	}
});

test('repairing draft frontmatter opens its raw composition despite an ambiguous Thoughts body', async () => {
	const raw = '## Thoughts\n\n- original\n\n```';
	const t = await setup({ 'captures/broken.md': `---\ncapturedAt: nope\ndraft: true\n---\n${raw}` });
	click(document, 'Edit as text');
	await until(() => document.querySelector('textarea[aria-label^="Contents of"]') !== null, 'the repair editor');
	type(document.querySelector('textarea[aria-label^="Contents of"]'), `---\ncapturedAt: 2026-10-01T10:30:00Z\ndraft: true\n---\n${raw}`);
	flushSync();
	click(document, 'Open as capture');
	await until(() => field('new-capture') !== null, 'the repaired composition');
	expect(field('new-capture')?.value).toBe(raw);
	expect(document.body.textContent).not.toContain('Needs repair');
	await t.quiet();
});

test('refused composition input explains why the previous text remains', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'Before');
	flushSync();
	type(box, 'Pasted\u0000after');
	flushSync();
	await tick();
	expect(field('new-capture')?.value).toBe('Before');
	expect(document.body.textContent).toContain('Your previous text is kept.');
	expect(field('new-capture')?.getAttribute('aria-invalid')).toBe('true');
	type(box, 'Accepted again');
	flushSync();
	expect(document.body.textContent).not.toContain('Your previous text is kept.');
	await t.quiet();
});

test('copying held composition input after another tab deletes its file preserves leading blank lines', async () => {
	const t = await setup();
	const box = await openNewCapture();
	const stem = t.captures.opened?.stem;
	if (stem === undefined) throw new Error('Expected a draft');
	const raw = '\n\nRaw writing\n';
	const restore = t.failSaves();
	type(box, raw);
	await until(() => document.body.textContent?.includes('Your draft is not saved') ?? false, 'the autosave failure');
	restore();
	await t.deleteElsewhere(stem);
	await until(() => document.body.textContent?.includes('This capture was deleted') ?? false, 'the deleted-file recovery');
	let copied: string | undefined;
	const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
	try {
		click(document, 'Copy your text');
		await until(() => copied !== undefined, 'the copied text');
		expect(copied).toBe(raw);
	} finally {
		if (original) Object.defineProperty(navigator, 'clipboard', original);
		else Reflect.deleteProperty(navigator, 'clipboard');
	}
});
