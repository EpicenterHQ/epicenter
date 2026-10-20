/**
 * Mounted Timeline Tests
 *
 * The real `Timeline` component and its New capture dialog, compiled for the
 * client and mounted in jsdom inside the folder's query client, over the
 * real Capture store and a real local folder on an in-memory IndexedDB.
 *
 * Key behaviors:
 * - The New capture text lives in the store, which outlives the view: its
 *   text box writes to it while it is shown, and nothing once the timeline
 *   is gone
 * - A file that is not a valid capture is named with why, and opens as text
 * - Add capture saves the file, opens it, and clears the New capture text
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
const { createRowEdit } = await import('@epicenter/svelte/edits');

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

/** Open the New capture dialog and return its text box. */
async function openNewCapture() {
	click(document, 'New capture');
	flushSync();
	await tick();
	const box = field('new-capture');
	if (box === null) throw new Error('the New capture dialog did not open');
	return box;
}

test('the New capture text box writes nothing once the timeline is gone, though the store is still there', async () => {
	const t = await setup();
	expect(document.body.textContent).toContain('No captures yet');
	const box = await openNewCapture();
	type(box, 'typed in the dialog');
	expect(t.captures.newCapture).toBe('typed in the dialog');

	t.close();
	flushSync();
	type(box, 'delivered after the timeline went');
	expect(t.captures.newCapture).toBe('typed in the dialog');
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

test('Add capture saves the file, opens it, and clears the New capture text', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'Written in the dialog');
	click(document, 'Add capture');
	await until(() => t.captures.opened !== undefined, 'the new capture to open');
	await t.quiet();
	flushSync();
	const stem = t.captures.opened?.stem;
	expect(t.captures.newCapture).toBe('');
	expect(await t.text(`captures/${stem}.md`)).toContain(
		'\nWritten in the dialog\n\n## Thoughts\n',
	);
});

test('a capture whose save failed is named, with why, and opens from there', async () => {
	const t = await setup({
		'captures/one.md': '---\ncapturedAt: 2026-10-04T20:49:23Z\n---\n\nText\n',
	});
	const restore = t.failSaves();
	// Typed in a view of the capture, as its detail types.
	const view = createRowEdit(t.folder.tables.captures.edit('one'), () => {
		const row = t.cached('one');
		return row?.issues === null ? row : undefined;
	});
	const form = t.captures.formOf('one').in(view);
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
