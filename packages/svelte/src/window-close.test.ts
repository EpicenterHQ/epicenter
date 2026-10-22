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
 * - A saved folder closes without a prompt
 * - An accepted edit prompts, and Cancel keeps the window and its edit
 * - Confirm destroys the window without waiting for a save
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
	nativeDialog,
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
	const folder = expectOk(
		await openFolder({ tables: { notes }, saveAfterMs: MINUTE }),
	);
	expectOk(
		await folder.tables.notes.set('milk', {
			fields: { title: 'Milk', done: false },
			body: '',
		}),
	);
	return folder;
}

/** The context over a fresh folder, guarding the desktop window it runs in. */
async function guarded() {
	const folder = await freshFolder();
	const context = createFolderContext(folder);
	cleanup.push(() => context.close());
	desktop(true);
	await context.guardWindowClose();
	return { context, milk: folder.tables.notes.edit('milk') };
}

type Notes = FolderContext<{ notes: typeof notes }>;

/** Type `title` into `milk` over the row as stored. */
async function typeTitle({ folder }: Notes, title: string) {
	const edit = folder.tables.notes.edit('milk');
	expectOk(await edit.refresh());
	expectOk(edit.change({ fields: { title } }));
}

async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 400; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

test('a saved folder closes without a prompt', async () => {
	await guarded();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(0);
});

test('an accepted edit prompts and Cancel keeps its input', async () => {
	const { context, milk } = await guarded();
	await typeTitle(context, 'Oat milk');
	expect(milk.getSnapshot().isDirty).toBe(true);

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeDialog.count).toBe(1);
	expect(milk.getSnapshot().isDirty).toBe(true);
});

test('Confirm destroys without waiting for the accepted edit to save', async () => {
	const { context, milk } = await guarded();
	await typeTitle(context, 'Oat milk');
	nativeDialog.answer = true;

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(1);
	expect(milk.getSnapshot().isDirty).toBe(true);
});

test('an app action before its first Folder write does not prompt', async () => {
	const { context } = await guarded();
	context.folder
		.run(() => Promise.reject(new Error('save interrupted')))
		.catch(() => {});

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(0);
});

test('whole text waiting to save prompts and Cancel retains it', async () => {
	const { context } = await guarded();
	const path = 'notes/source.md';
	expectOk(await context.folder.files.write(path, 'saved'));
	const text = context.folder.files.edit(path);
	expectOk(await text.refresh());
	expectOk(text.replaceText('unsaved source'));
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	expect(nativeDialog.count).toBe(1);
	expect(text.getSnapshot()).toMatchObject({
		isDirty: true,
		content: { text: 'unsaved source' },
	});
});

test('two close requests at once destroy the window once', async () => {
	await guarded();

	await Promise.all([requestClose(), requestClose()]);

	expect(nativeWindow.destroyed).toBe(1);
});

test('a failed destroy keeps the close guard for the next attempt', async () => {
	const { context } = await guarded();
	await typeTitle(context, 'Oat milk');
	nativeDialog.answer = true;
	nativeWindow.refuseDestroy = true;

	await requestClose();

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	await typeTitle(context, 'Oat milk, two litres');
	nativeWindow.refuseDestroy = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('registration must finish before the guarded folder can be edited', async () => {
	const folder = await freshFolder();
	const context = createFolderContext(folder);
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
	expect(context.folder.tables.notes.edit('milk').getSnapshot().isDirty).toBe(
		true,
	);
});

test('a browser tab registers nothing, and closing the context stops listening', async () => {
	const folder = await freshFolder();
	const tab = createFolderContext(folder);
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
			open: () => openFolder({ tables: { notes }, saveAfterMs: MINUTE }),
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
	nativeDialog.answer = true;
	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
	expect(nativeDialog.count).toBe(1);
});
