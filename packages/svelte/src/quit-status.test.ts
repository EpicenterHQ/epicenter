/**
 * The page half of application Quit: each targeted check gets its request id,
 * window label and current Folder save state. Browser and standalone pages do
 * not report to Epicenter, and orderly context close removes the reporter.
 */
import 'fake-indexeddb/auto';
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import { desktop, nativeWindow } from './tauri-window.test-support.js';

const replies: { event: string; payload: unknown }[] = [];
const listeners = new Map<string, (event: { payload: number }) => void>();
let target: unknown;
mock.module('@tauri-apps/api/event', () => ({
	async emit(event: string, payload: unknown) {
		replies.push({ event, payload });
	},
	async listen(
		event: string,
		handler: (event: { payload: number }) => void,
		options: { target: unknown },
	) {
		target = options.target;
		listeners.set(event, handler);
		return () => { listeners.delete(event); };
	},
}));

const { createFolderContext } = await import('./folder-context.js');
const { reportFolderSaveStatus } = await import('./window-close.js');
const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	nativeWindow.reset();
	listeners.clear();
	replies.length = 0;
	target = undefined;
	if (location === undefined) Reflect.deleteProperty(globalThis, 'location');
	else Object.defineProperty(globalThis, 'location', location);
});

function protocol(protocol: string) {
	Object.defineProperty(globalThis, 'location', {
		value: { protocol }, configurable: true,
	});
}

test('only an Epicenter desktop page registers for Quit checks', async () => {
	protocol('epicenter-app:');
	(await reportFolderSaveStatus(() => false))();
	desktop(true);
	protocol('http:');
	(await reportFolderSaveStatus(() => false))();
	expect(listeners.size).toBe(0);
	expect(replies).toEqual([]);
});

test('a targeted check reports its id and the current save state without caching it', async () => {
	desktop(true);
	protocol('epicenter-app:');
	let pending = false;
	cleanup.push(await reportFolderSaveStatus(() => pending));
	expect(target).toEqual({ kind: 'WebviewWindow', label: 'test-folder' });
	const check = listeners.get('epicenter://quit-check');
	if (check === undefined) throw new Error('The Quit reporter must listen');
	check({ payload: 41 });
	pending = true;
	check({ payload: 42 });
	expect(replies).toEqual([
		{ event: 'epicenter://quit-status', payload: { id: 41, label: 'test-folder', pending: false } },
		{ event: 'epicenter://quit-status', payload: { id: 42, label: 'test-folder', pending: true } },
	]);
});

test('normal context close removes its Quit reporter', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables: {} }));
	desktop(true);
	protocol('epicenter-app:');
	const context = createFolderContext(folder);
	cleanup.push(() => context.close());
	await context.guardWindowClose();
	expect(listeners.has('epicenter://quit-check')).toBe(true);
	await context.close();
	expect(listeners.size).toBe(0);
});
