/**
 * Mounted Timeline Tests
 *
 * The real `Timeline` component and its New capture dialog, compiled for the
 * client and mounted in jsdom over the real Capture store and a real browser
 * folder.
 *
 * Key behaviors:
 * - The New capture text lives in the collection, which outlives the view:
 *   its text box writes to it while it is shown, and nothing once the
 *   timeline is gone, though the collection is still there
 * - A file that is not a valid capture is named with why, and opens as text
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
import { afterEach, expect, test } from 'bun:test';
import { flushSync, mount, tick, unmount } from 'svelte';
import { button, click, field, type } from '../svelte-dom.test-support.js';

const { openCaptures, openText } = await import(
	'../browser-folder.test-support.js'
);
const { default: Timeline } = await import('./Timeline.svelte');

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
});

async function setup(files: Record<string, string> = {}) {
	const harness = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(Timeline, {
		target,
		props: { captures: harness.captures, onCreated() {}, onRecover() {} },
	});
	flushSync();
	cleanup.push(() => harness.close());
	return { ...harness, view };
}

/** Open the New capture dialog and return its text box. */
async function openNewCapture() {
	click(button('New capture'));
	flushSync();
	await tick();
	const box = field('new-capture');
	if (box === null) throw new Error('the New capture dialog did not open');
	return box;
}

test('the New capture text box writes nothing once the timeline is gone, though the collection is still there', async () => {
	const t = await setup();
	const box = await openNewCapture();
	type(box, 'typed in the dialog');
	expect(t.captures.newCapture).toBe('typed in the dialog');

	unmount(t.view);
	flushSync();
	type(box, 'delivered after the timeline went');
	expect(t.captures.newCapture).toBe('typed in the dialog');
	expect(t.captures.locked).toBe(false);
});

test('a file that is not a valid capture is named with why, and Edit as text opens it', async () => {
	const t = await setup({
		'captures/broken.md': '---\ncapturedAt: nope\n---\n\nBroken\n',
	});
	flushSync();
	expect(t.view).toBeDefined();
	expect(document.body.textContent).toContain('captures/broken.md');
	expect(document.body.textContent).toContain('capturedAt');
	click(button('Edit as text'));
	await Bun.sleep(20);
	expect(openText(t.captures).path).toBe('captures/broken.md');
	unmount(t.view);
});
