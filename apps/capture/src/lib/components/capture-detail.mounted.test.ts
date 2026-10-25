/**
 * Mounted Capture Detail Tests
 *
 * Verifies the real capture and text editors against the folder mirror:
 * visible typed text, thought composition, mode settling, and live repair.
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
const AT = '2026-10-04T20:49:23.041Z';
const PATH = 'captures/one.md';
const FILE = `---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
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
async function setup(files: Record<string, string>, mode: 'capture' | 'text') {
	const harness = await openCaptures(files);
	await harness.captures.open('one', mode);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures, folder: harness.folder },
	});
	cleanup.push(async () => {
		await unmount(view);
		await harness.close();
	});
	flushSync();
	return { ...harness, target };
}
async function settle(h: Awaited<ReturnType<typeof setup>>) {
	await h.quiet();
	flushSync();
}

test('typing capture text then adding a thought keeps both edits', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await settle(h);
	expect(h.text(PATH)).toContain('Edited');
	expect(h.text(PATH)).toContain('- second');
	expect(field('new-thought')?.value).toBe('');
});

test('mode switch waits for the save and opens the saved source', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	type(field('capture-text'), 'Pending');
	const edit = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Edit as text',
	);
	edit?.click();
	await until(() => {
		flushSync();
		return (
			document.querySelector('textarea[aria-label^="Contents of"]') !== null
		);
	});
	const file = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
	expect(file?.value).toContain('Pending');
	expect(h.text(PATH)).toContain('Pending');
});

test('an outside change appears when idle and typing stays visible until its save answers', async () => {
	const h = await setup({ [PATH]: FILE }, 'capture');
	h.writeElsewhere(PATH, FILE.replace('Text', 'Elsewhere'));
	await until(() => {
		flushSync();
		return field('capture-text')?.value === 'Elsewhere';
	});
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	type(field('capture-text'), 'Mine');
	flushSync();
	expect(field('capture-text')?.value).toBe('Mine');
	await until(() => h.host.log.puts.length > 0);
	expect(field('capture-text')?.value).toBe('Mine');
	release();
	await settle(h);
	expect(field('capture-text')?.value).toBe('Mine');
	expect(h.text(PATH)).toContain('Mine');
});

test('Needs repair responds to typing before the save answers', async () => {
	const h = await setup(
		{ [PATH]: '---\ncapturedAt: nope\n---\nBody\n' },
		'text',
	);
	const file = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
	expect(h.target.textContent).toContain('Needs repair');
	type(file, `---\ncapturedAt: ${AT}\n---\nBody\n`);
	flushSync();
	expect(h.target.textContent).not.toContain('Needs repair');
	const open = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Open as capture',
	);
	expect(open?.disabled).toBe(false);
});

test('a text editor is read-only while Add finishes a saved draft', async () => {
	const h = await setup(
		{ [PATH]: `---\ncapturedAt: ${AT}\ndraft: true\n---\nWriting` },
		'text',
	);
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const add = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === 'Add capture',
	);
	add?.click();
	flushSync();
	const file = document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
	expect(file?.readOnly).toBe(true);
	release();
	await until(() => {
		flushSync();
		return h.captures.opened?.mode === 'capture';
	});
});
