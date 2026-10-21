/**
 * Capture Window Close Tests
 *
 * The real Capture page, mounted as `page.mounted.test.ts` mounts it, in a
 * desktop window: the stand-in in `tauri-window.test-support`, which runs
 * the close listener as Tauri's API does. The page opens browser storage as
 * it mounts and runs as a window from then on. Another tab of the profile
 * reads what was stored.
 *
 * Key behaviors:
 * - Composition input prompts until saved, then closes without prompting
 * - Text held by Folder prompts; Cancel retains it
 * - A failed save of that text keeps the window and the text; once saving
 *   works, explicit retry saves and the next close destroys
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { captureTables } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../../packages/svelte/src/tauri-window.test-support.js';

mock.module('$app/navigation', () => ({ beforeNavigate() {} }));

const { flushSync, mount, unmount } = await import('svelte');
const { default: PageHost } = await import('./fixtures/PageHost.svelte');

setWide(true);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	nativeWindow.reset();
});

const PATH = 'captures/one.md';
const FILE = '---\ncapturedAt: 2026-10-04T20:49:23Z\n---\n\nBefore\n';
const CONTENTS = 'textarea[aria-label^="Contents of"]';

/** Run `read` as another tab of this profile, outside the window. */
async function asTab<T>(
	read: (folder: Awaited<ReturnType<typeof tab>>) => Promise<T>,
) {
	desktop(false);
	try {
		const folder = await tab();
		try {
			return await read(folder);
		} finally {
			await folder.close();
		}
	} finally {
		desktop(true);
	}
}
const tab = async () => expectOk(await openFolder({ tables: captureTables }));

const storedText = () =>
	asTab(
		async (folder) =>
			(await expectOk(await folder.files.read(PATH))?.content.text()) ?? '',
	);

async function untilStoredText(expected: string) {
	for (let tries = 0; tries < 400; tries++) {
		if (await storedText() === expected) return;
		await Bun.sleep(5);
	}
	throw new Error('Timed out waiting for the text to save');
}

/** Make every IndexedDB write fail the way a full disk does, until restored. */
function fillDisk() {
	const put = IDBObjectStore.prototype.put;
	IDBObjectStore.prototype.put = () => {
		throw new DOMException('Disk is full', 'QuotaExceededError');
	};
	const restore = () => {
		IDBObjectStore.prototype.put = put;
	};
	cleanup.push(restore);
	return restore;
}

async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A fresh profile holding `one.md`, open in a desktop window. */
async function openWindow() {
	globalThis.indexedDB = new IDBFactory();
	{
		const folder = await tab();
		expectOk(await folder.files.write(PATH, null, FILE));
		await folder.close();
	}
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	cleanup.push(async () => {
		await unmount(view);
		target.remove();
	});
	// The page chose browser storage as it mounted; it now runs as a window.
	desktop(true);
	const text = () => target.textContent ?? '';
	await until(() => text().includes('Before'), 'the timeline');
	await untilListening();
	return { target, text };
}

/** Open `one.md` with Edit as text and answer its text box. */
async function editAsText(page: Awaited<ReturnType<typeof openWindow>>) {
	page.target
		.querySelector<HTMLButtonElement>('[aria-label="Timeline captures"] button')
		?.click();
	await until(() => page.text().includes('Edit as text'), 'the capture');
	click(page.target, 'Edit as text');
	await until(() => page.target.querySelector(CONTENTS) !== null, 'the text');
	return () => page.target.querySelector<HTMLTextAreaElement>(CONTENTS);
}

test('composition input prompts while unsaved and closes without prompting once saved', async () => {
	const page = await openWindow();
	click(page.target, 'New capture');
	flushSync();
	await until(() => document.getElementById('new-capture') !== null, 'the composition');
	type(document.getElementById('new-capture'), 'Not added yet');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeDialog.count).toBe(1);
	document.getElementById('new-capture')?.dispatchEvent(new FocusEvent('blur'));
	await until(() => page.target.querySelector('[aria-label="Saving"]')?.textContent === 'Saved', 'the composition to save');
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(1);
});

test('text held by Folder prompts; Cancel retains it', async () => {
	const page = await openWindow();
	const contents = await editAsText(page);
	type(contents(), FILE.replace('Before', 'After'));

	for (const keys of [
		{ key: 'F5' },
		{ key: 'r', ctrlKey: true },
		{ key: 'r', metaKey: true },
	]) {
		expect(window.dispatchEvent(new KeyboardEvent('keydown', {
			...keys, bubbles: true, cancelable: true,
		}))).toBe(true);
	}

	await requestClose();

	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(contents()?.value).toBe(FILE.replace('Before', 'After'));
	contents()?.dispatchEvent(new FocusEvent('blur'));
	await untilStoredText(FILE.replace('Before', 'After'));
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedText()).toBe(FILE.replace('Before', 'After'));
});

test('a failed save keeps the window and the text; explicit retry saves and the next close destroys', async () => {
	const page = await openWindow();
	const contents = await editAsText(page);
	const draft = FILE.replace('Before', 'Typed but not saved');
	type(contents(), draft);
	const restore = fillDisk();
	contents()?.dispatchEvent(new FocusEvent('blur'));
	await until(() => page.text().includes('Not saved'), 'the failed save');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(contents()?.value).toBe(draft);
	expect(nativeDialog.count).toBe(1);
	restore();
	expect(await storedText()).toBe(FILE);

	click(page.target, 'Save again');
	await untilStoredText(draft);
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedText()).toBe(draft);
});
