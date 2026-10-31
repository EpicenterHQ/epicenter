/**
 * Mounted Timeline Tests
 *
 * The real timeline over real device clients: New capture, the files it
 * lists, and another writer's change.
 *
 * Key behaviors:
 * - New capture writes nothing until Add, then opens Add a thought
 * - A failed Add keeps its form text
 * - A file that does not read is listed to repair, not as a capture
 * - Another writer's change shows without a reload
 * - An Add whose text makes the Thoughts ambiguous opens as text
 */
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openCaptures, until } = await import(
	'../capture-device.test-support.js'
);
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
async function setup(...args: Parameters<typeof openCaptures>) {
	const h = await openCaptures(...args);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, { target, props: { captures: h.captures } });
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
	expect(h.list.items).toEqual([]);
	submit(field('new-capture')?.form);
	await until(() => field('new-thought') !== null);
	expect(h.captures.timeline.rows[0]?.preview).toContain('Fresh writing');
	const id = h.captures.opened?.id;
	expect(await h.text(`captures/${id}.md`)).toContain('Fresh writing');
});

test('failed Add keeps its form text and leaves the timeline empty', async () => {
	const h = await setup();
	h.failWrites();
	type(field('new-capture'), 'Keep this');
	submit(field('new-capture')?.form);
	await until(
		() => document.body.textContent?.includes('Could not add capture') === true,
	);
	expect(field('new-capture')?.value).toBe('Keep this');
	expect(h.captures.timeline.rows).toEqual([]);
});

test('a file that does not read as a capture is listed for repair, not as a capture', async () => {
	const h = await setup({
		'captures/broken.md': '---\ncapturedAt: nope\n---\nBody\n',
	});
	await until(
		() =>
			h.target.textContent?.includes('1 file does not read as a capture') ===
			true,
	);
	expect(h.target.textContent).toContain('captures/broken.md');
	expect(h.captures.timeline.rows).toEqual([]);
});

test('another writer’s change shows without a reload', async () => {
	const h = await setup();
	await h.writeElsewhere(PATH, `---\ncapturedAt: ${AT}\n---\nOutside\n`);
	await until(() => h.target.textContent?.includes('Outside') === true);
	expect(h.captures.timeline.rows[0]?.id).toBe('one');
});

test('an ambiguous Add opens the saved file as text', async () => {
	const h = await setup();
	type(field('new-capture'), '## Thoughts\n\n## Thoughts');
	submit(field('new-capture')?.form);
	await until(() => h.captures.opened !== undefined);
	expect(h.captures.opened?.mode).toBe('text');
	await until(
		() =>
			document
				.querySelector<HTMLTextAreaElement>(
					'textarea[aria-label^="Contents of"]',
				)
				?.value.includes('## Thoughts') === true,
	);
	expect(h.target.textContent).toContain('Needs repair');
});
