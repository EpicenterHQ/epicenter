/**
 * Window Close Tests
 *
 * A desktop window's close, as `createFolderContext(...).guardWindowClose()`
 * and `<FolderApp>` answer it, over a real local folder on an in-memory
 * IndexedDB. Tauri's window is the stand-in in `tauri-window.test-support`,
 * which runs a close listener as the installed API does. Drafts wait a
 * minute for their pause, so only the close can send them.
 *
 * Key behaviors:
 * - A close sends typing still waiting for its pause, then destroys the window
 * - A failed save keeps the window and the typing; once saving works, the
 *   next close saves and destroys
 * - Registered unsent input keeps the window until it is gone
 * - Two close requests at once destroy the window once
 * - A window that may not destroy itself keeps its guard for the next close
 * - A browser tab registers nothing; closing the context stops listening
 * - `<FolderApp>` guards the window it opened its folder in
 */
import 'fake-indexeddb/auto';
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { Type } from 'typebox';
import { expectOk } from 'wellcrafted/testing';
import type { FolderContext } from './folder-context.js';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from './tauri-window.test-support.js';

const { createFolderContext } = await import('./folder-context.js');
const { flushSync, mount, unmount } = await import('svelte');
const { default: FolderAppHost } = await import(
	'./fixtures/FolderAppHost.svelte'
);

const notes = Type.Object({ title: Type.String(), done: Type.Boolean() });
const MINUTE = 60_000;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	nativeWindow.reset();
});

/** A fresh profile holding `milk`, opened as a browser tab opens it. */
async function freshFolder() {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables: { notes } }));
	expectOk(
		await folder.tables.notes.set('milk', null, {
			fields: { title: 'Milk', done: false },
			body: '',
		}),
	);
	return folder;
}

/** The context over a fresh folder, guarding the desktop window it runs in. */
async function guarded() {
	const folder = await freshFolder();
	const context = createFolderContext(folder, { saveAfterMs: MINUTE });
	cleanup.push(() => context.close());
	desktop(true);
	await context.guardWindowClose();
	return { context, milk: context.edits.row('notes', 'milk') };
}

type Notes = FolderContext<{ notes: typeof notes }>;

/** The title of `milk` as storage holds it. */
async function storedTitle({ folder }: Notes) {
	return expectOk(await folder.tables.notes.get('milk'))?.fields.title;
}

/** Type `title` into `milk` over the row as stored. */
async function typeTitle({ folder, edits }: Notes, title: string) {
	const row = expectOk(await folder.tables.notes.get('milk'));
	if (row === undefined) throw new Error('milk is not stored');
	expect(edits.row('notes', 'milk').change(row, { fields: { title } })).toBe(
		true,
	);
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

test('a close sends typing still waiting for its pause, then destroys the window', async () => {
	const { context, milk } = await guarded();
	await typeTitle(context, 'Oat milk');
	expect(milk.held).toBe(true);

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(milk.held).toBe(false);
	expect(await storedTitle(context)).toBe('Oat milk');
});

test('a failed save keeps the window and the typing; the next close saves and destroys', async () => {
	const { context, milk } = await guarded();
	await typeTitle(context, 'Oat milk');
	const restore = fillDisk();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	expect(milk.held).toBe(true);
	expect(milk.error).toBeDefined();
	expect(context.saveState).toBe('failed');
	// The close fenced nothing: typing is still taken.
	await typeTitle(context, 'Oat milk, two litres');
	expect(milk.locked).toBe(false);

	restore();
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle(context)).toBe('Oat milk, two litres');
});

test('registered unsent input keeps the window until it is gone', async () => {
	const { context } = await guarded();
	let typed = 'Buy bread';
	const unregister = context.registerUnsent(() =>
		typed === '' ? undefined : 'A new note is not added.',
	);

	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(typed).toBe('Buy bread');

	typed = '';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	unregister();
});

test('a rejected app save keeps the window even if the app reports no held draft', async () => {
	const { context } = await guarded();
	context.registerWork({
		busy: false,
		failed: false,
		settle: () => Promise.reject(new Error('save interrupted')),
	});

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
});

test('two close requests at once destroy the window once', async () => {
	const { context } = await guarded();
	await typeTitle(context, 'Oat milk');

	await Promise.all([requestClose(), requestClose()]);

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle(context)).toBe('Oat milk');
});

test('a failed destroy keeps the close guard for the next attempt', async () => {
	const { context } = await guarded();
	await typeTitle(context, 'Oat milk');
	nativeWindow.refuseDestroy = true;

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(await storedTitle(context)).toBe('Oat milk');
	expect(nativeWindow.listeners).toBe(1);
	await typeTitle(context, 'Oat milk, two litres');
	nativeWindow.refuseDestroy = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle(context)).toBe('Oat milk, two litres');
});

test('registration must finish before the guarded folder can be edited', async () => {
	const folder = await freshFolder();
	const context = createFolderContext(folder, { saveAfterMs: MINUTE });
	cleanup.push(() => context.close());
	desktop(true);
	let release!: () => void;
	nativeWindow.registration = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready = false;
	const guarded = context.guardWindowClose().then(() => {
		ready = true;
	});
	await Bun.sleep(5);
	expect(ready).toBe(false);
	expect(nativeWindow.listeners).toBe(0);
	release();
	await guarded;
	expect(ready).toBe(true);
	expect(nativeWindow.listeners).toBe(1);
});

test('a second context cannot guard the same window', async () => {
	await guarded();
	desktop(false);
	const folder = await freshFolder();
	desktop(true);
	const second = createFolderContext(folder);
	cleanup.push(() => second.close());
	await expect(second.guardWindowClose()).rejects.toThrow(
		'This window already has a Folder close guard',
	);
	expect(nativeWindow.listeners).toBe(1);
});

test('input is inert while destruction is pending and restored if it fails', async () => {
	const { context } = await guarded();
	let release!: () => void;
	nativeWindow.destruction = new Promise<void>((resolve) => {
		release = resolve;
	});
	nativeWindow.refuseDestroy = true;
	const closing = requestClose();
	await until(() => document.documentElement.inert, 'the page to become inert');
	expect(nativeWindow.destroyed).toBe(0);
	release();
	await closing;
	expect(document.documentElement.inert).toBe(false);
	expect(nativeWindow.listeners).toBe(1);
	await typeTitle(context, 'Still editable');
	expect(context.edits.row('notes', 'milk').held).toBe(true);
});

test('a browser tab registers nothing, and closing the context stops listening', async () => {
	const folder = await freshFolder();
	const tab = createFolderContext(folder, { saveAfterMs: MINUTE });
	await tab.guardWindowClose();
	expect(nativeWindow.listeners).toBe(0);
	await tab.close();

	const { context } = await guarded();
	expect(nativeWindow.listeners).toBe(1);
	await context.close();
	await until(() => nativeWindow.listeners === 0, 'the listener to stop');
});

test('<FolderApp> guards the window it opened its folder in', async () => {
	await (await freshFolder()).close();
	let context: FolderContext | undefined;
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(FolderAppHost, {
		target,
		props: {
			tables: { notes },
			saveAfterMs: MINUTE,
			onContext: (opened: FolderContext) => {
				context = opened;
			},
		},
	});
	cleanup.push(async () => {
		await unmount(view);
		target.remove();
	});
	// The page chose browser storage as it mounted; it now runs as a window.
	desktop(true);
	await until(() => context !== undefined, 'the folder to open');
	const opened = context as unknown as Notes;
	await untilListening();

	await typeTitle(opened, 'Typed just before closing');
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(await storedTitle(opened)).toBe('Typed just before closing');
});
