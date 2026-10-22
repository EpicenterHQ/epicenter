/**
 * Todos Window Close Tests
 *
 * The real Todos page, mounted as `TodosApp.mounted.test.ts` mounts it, in
 * a desktop window: the stand-in in `tauri-window.test-support`, which runs
 * the close listener as Tauri's API does. The page opens browser storage as
 * it mounts and runs as a window from then on. Another tab of the profile
 * reads what was stored.
 *
 * Key behaviors:
 * - A pending Folder edit prompts; Cancel retains it, and saving allows close
 * - Confirm closes with pending input without waiting for a save
 * - A failed save prompts without retrying; explicit retry saves the typing
 * - A new todo title not added closes without a prompt
 *
 * Run with `bun run test:mounted`; the server-runtime tests exclude this file.
 */
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../../packages/svelte/src/tauri-window.test-support.js';
import { todosTables } from '../../lib/definition.js';

const { flushSync, mount, unmount } = await import('svelte');
const state = await import('../../lib/app-state.test-support.svelte.ts');
const navigation = await import('../../lib/app-navigation.test-support.ts');
mock.module('$app/state', () => state);
mock.module('$app/navigation', () => navigation);
const { resetUrl } = navigation;
const { default: PageHost } = await import('./fixtures/PageHost.svelte');

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	document.body.replaceChildren();
	resetUrl();
	nativeWindow.reset();
});

const TITLE = 'section[aria-label="Todo"] input[aria-label="Title"]';
const NEW_TITLE = '[aria-label="New todo title"]';

/** The title of `milk` as another tab of this profile reads it. */
async function storedTitle() {
	desktop(false);
	try {
		const folder = expectOk(await openFolder({ tables: todosTables }));
		try {
			return expectOk(await folder.tables.todos.get('milk'))?.fields?.title;
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
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/** A fresh profile holding `milk`, open in a desktop window. */
async function windowOnMilk() {
	globalThis.indexedDB = new IDBFactory();
	{
		const folder = expectOk(await openFolder({ tables: todosTables }));
		expectOk(
			await folder.tables.todos.write('milk', {
				fields: { title: 'Milk', done: false },
				body: '',
			}),
		);
		await folder.close();
	}
	resetUrl('http://localhost/?todo=milk');
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
	await until(() => get(TITLE)?.value === 'Milk', 'milk to open');
	await untilListening();
	return { get };
}

const said = (text: string) =>
	document.body.textContent?.includes(text) ?? false;

test('a pending edit prompts; Cancel keeps it and a saved edit closes without another prompt', async () => {
	const page = await windowOnMilk();
	type(page.get(TITLE), 'Oat milk');

	await requestClose();

	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(page.get(TITLE)?.value).toBe('Oat milk');
	expect(await storedTitle()).toBe('Milk');

	blur(page.get(TITLE));
	await until(
		() => said('Saved on this device') && !said('Saving…'),
		'the save',
	);
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(1);
	expect(await storedTitle()).toBe('Oat milk');
});

test('confirming close destroys the window without starting a pending save', async () => {
	const page = await windowOnMilk();
	type(page.get(TITLE), 'Oat milk');
	nativeDialog.answer = true;

	await requestClose();

	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle()).toBe('Milk');
});

test('a failed save prompts without retrying; explicit retry saves and allows close', async () => {
	const page = await windowOnMilk();
	type(page.get(TITLE), 'Oat milk');
	const restore = fillDisk();
	blur(page.get(TITLE));
	await until(() => said('Not saved:'), 'the failed save');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(page.get(TITLE)?.value).toBe('Oat milk');
	expect(nativeDialog.count).toBe(1);
	restore();
	expect(await storedTitle()).toBe('Milk');

	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeDialog.count).toBe(2);
	expect(await storedTitle()).toBe('Milk');
	const retry = [
		...document.querySelectorAll<HTMLButtonElement>(
			'section[aria-label="Todo"] button',
		),
	].find((button) => button.textContent?.trim() === 'Try again');
	if (retry === undefined) throw new Error('The failed edit offers Try again');
	retry.click();
	await until(
		() => said('Saved on this device') && !said('Not saved:'),
		'the explicit retry',
	);
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle()).toBe('Oat milk');
});

test('a new todo title not added closes without prompting', async () => {
	const page = await windowOnMilk();
	type(page.get(NEW_TITLE), 'Buy bread');

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(0);
	expect(page.get(NEW_TITLE)?.value).toBe('Buy bread');
});
