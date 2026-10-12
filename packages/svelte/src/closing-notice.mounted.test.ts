/**
 * Closing Notice Mounted Tests
 *
 * Mounts the real `ClosingNotice` in jsdom over a real `createClosing`, as a
 * desktop page renders it, and drives one close request.
 *
 * Key behaviors:
 * - Nothing shows before the threshold
 * - After it, "Still saving…" shows with "Close anyway", which ends the wait
 *
 * Run with `bun run test:mounted`.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { click } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { createClosing } = await import('./closing.svelte.ts');
const { default: ClosingNotice } = await import('./closing-notice.svelte');

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
});

test('the notice appears only after the threshold, and Close anyway ends the wait', async () => {
	const closing = createClosing({
		close: () => new Promise(() => {}),
		slowAfter: 30,
	});
	const target = document.createElement('div');
	document.body.append(target);
	const notice = mount(ClosingNotice, { target, props: { closing } });
	cleanups.push(() => void unmount(notice));

	let ended = false;
	const handled = closing.request({ preventDefault() {} }).then(() => {
		ended = true;
	});
	await Bun.sleep(5);
	flushSync();
	expect(target.textContent).not.toContain('Still saving');

	await Bun.sleep(50);
	flushSync();
	expect(target.textContent).toContain('Still saving…');
	expect(ended).toBe(false);

	click(target, 'Close anyway');
	await handled;
	flushSync();
	expect(ended).toBe(true);
	expect(target.textContent).not.toContain('Still saving');
});
