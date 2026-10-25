/**
 * Mounted Timeline Tests
 *
 * Checks New Capture's unsaved form, mirror timeline, draft opening, and
 * repair actions through the real mounted view.
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openCaptures, until } = await import('../local-folder.test-support.js');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');
setWide(true);
const AT = '2026-10-04T20:49:23Z';
const PATH = 'captures/one.md';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
	document.body.replaceChildren();
});
const field = (id: string) => {
	const element = document.getElementById(id);
	return element instanceof HTMLTextAreaElement ? element : null;
};
function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) throw new Error('Expected a form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}
async function setup(files: Record<string, string> = {}) {
	const h = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, {
		target,
		props: { captures: h.captures, folder: h.folder },
	});
	cleanup.push(async () => {
		await unmount(view);
		await h.close();
	});
	flushSync();
	return { ...h, target };
}

test('New capture writes nothing until Add and then opens Add a thought', async () => {
	const h = await setup();
	type(field('new-capture'), 'Fresh writing');
	flushSync();
	expect(h.host.log.puts).toEqual([]);
	submit(field('new-capture')?.form);
	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	});
	expect(h.captures.timeline.rows[0]?.preview).toContain('Fresh writing');
	expect(h.host.log.puts.length).toBe(1);
});

test('failed Add keeps its form text and leaves the timeline empty', async () => {
	const h = await setup();
	h.host.control.beforePut = (path) =>
		h.host.control.failPut.set(
			path,
			// SAFETY: this test installs a failure on every attempted create.
			h.host.control.failPut.get(PATH)!,
		);
	h.failSaves(PATH);
	type(field('new-capture'), 'Keep this');
	submit(field('new-capture')?.form);
	await h.quiet();
	flushSync();
	expect(field('new-capture')?.value).toBe('Keep this');
	expect(h.captures.timeline.rows).toEqual([]);
	expect(h.failures.length).toBe(1);
});

test('saved draft opens as text and repair opens its file', async () => {
	const h = await setup({
		'captures/draft.md': `---\ncapturedAt: ${AT}\ndraft: true\n---\nWriting`,
		'captures/broken.md': '---\ncapturedAt: nope\n---\nBody\n',
	});
	expect(h.target.textContent).toContain('Drafts');
	expect(h.target.textContent).toContain('1 file does not read as a capture');
	const draft = h.target.querySelector<HTMLButtonElement>(
		'[aria-label="Draft captures"] button',
	);
	draft?.click();
	await until(() => {
		flushSync();
		return h.captures.opened?.stem === 'draft';
	});
	expect(h.captures.opened?.mode).toBe('text');
});

test('another writer updates the timeline without a query refetch', async () => {
	const h = await setup();
	h.writeElsewhere(PATH, `---\ncapturedAt: ${AT}\n---\nOutside\n`);
	await until(() => {
		flushSync();
		return h.target.textContent?.includes('Outside') === true;
	});
	expect(h.captures.timeline.rows[0]?.stem).toBe('one');
});

test('an ambiguous Add opens the saved file as text', async () => {
	const h = await setup();
	type(field('new-capture'), '## Thoughts\n\n## Thoughts');
	submit(field('new-capture')?.form);
	await until(() => {
		flushSync();
		return h.captures.opened !== undefined;
	});
	expect(h.captures.opened?.mode).toBe('text');
	expect(
		document.querySelector<HTMLTextAreaElement>(
			'textarea[aria-label^="Contents of"]',
		)?.value,
	).toContain('## Thoughts');
});
