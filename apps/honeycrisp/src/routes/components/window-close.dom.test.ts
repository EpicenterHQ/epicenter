/**
 * Honeycrisp Window Close Tests
 *
 * The real Honeycrisp page, mounted as `page.dom.test.ts` mounts it, in a
 * desktop window: the stand-in in `tauri-window.test-support`, which runs
 * the close listener as Tauri's API does. The page opens browser storage as
 * it mounts and runs as a window from then on. Another tab of the profile
 * reads what was stored.
 *
 * Key behaviors:
 * - A title typed and closed at once, before its pause, is saved before the
 *   window goes
 * - A failed save keeps the window and the title; once saving works, the
 *   next close saves and destroys
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { type } from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../../packages/svelte/src/tauri-window.test-support.js';
import { honeycrispTables } from '../../lib/data.js';

// jsdom has no layout; ProseMirror measures the cursor and gets no boxes.
Range.prototype.getClientRects ??= () =>
	[] as unknown as ReturnType<Range['getClientRects']>;
Range.prototype.getBoundingClientRect ??= () =>
	({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) as DOMRect;

mock.module('$app/navigation', () => ({ beforeNavigate() {} }));

const { flushSync, mount, unmount } = await import('svelte');
const { default: PageHost } = await import(
	'../../lib/page-host.test-support.svelte'
);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	nativeWindow.reset();
});

const NOTE = 'section[aria-label="Note"]';
const TITLE = `${NOTE} input[aria-label="Title"]`;
const STATUS = '[data-testid="write-status"]';

/** Every note's title as another tab of this profile reads it. */
async function storedTitles() {
	desktop(false);
	try {
		const folder = expectOk(await openFolder({ tables: honeycrispTables }));
		try {
			return expectOk(await folder.tables.notes.list()).map(
				(row) => row.fields.title,
			);
		} finally {
			await folder.close();
		}
	} finally {
		desktop(true);
	}
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
	for (let tries = 0; tries < 600; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A fresh profile in a desktop window, with one new note open and saved. */
async function windowOnNewNote() {
	globalThis.indexedDB = new IDBFactory();
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(PageHost, { target });
	cleanup.push(async () => {
		await unmount(view);
		target.remove();
	});
	// The page chose browser storage as it mounted; it now runs as a window.
	desktop(true);
	const get = (selector: string) =>
		target.querySelector<HTMLInputElement>(selector);
	await until(
		() => get('button[aria-label="New note"]') !== null,
		'the note list',
	);
	await untilListening();
	get('button[aria-label="New note"]')?.dispatchEvent(
		new MouseEvent('click', { bubbles: true }),
	);
	await until(() => get(TITLE) !== null, 'the new note');
	await until(
		() => /Saved to/.test(target.querySelector(STATUS)?.textContent ?? ''),
		'the new note to save',
	);
	return { get };
}

const said = (text: string) =>
	document.body.textContent?.includes(text) ?? false;

test('a title typed and closed at once is saved before the window goes', async () => {
	const page = await windowOnNewNote();
	type(page.get(TITLE), 'Groceries');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitles()).toEqual(['Groceries']);
});

test('a failed save keeps the window and the title; the next close saves and destroys', async () => {
	const page = await windowOnNewNote();
	type(page.get(TITLE), 'Groceries');
	const restore = fillDisk();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(page.get(TITLE)?.value).toBe('Groceries');
	await until(() => said('A change did not save.'), 'the notice');
	restore();
	expect(await storedTitles()).not.toContain('Groceries');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitles()).toEqual(['Groceries']);
});
