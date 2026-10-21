/**
 * Epicenter's independent Quit status reporter and page-owned close flow.
 * Quit receives current Folder status; window close reads the caller's native
 * recording flag and awaits one native confirmation for all unfinished work.
 * Cancel and native-query failure retain the window. Standalone hosts never
 * call Epicenter's recording query or participate in its Quit protocol.
 */
import 'fake-indexeddb/auto';
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { openFolder } from '@epicenter/folder/browser';
import { expectOk } from 'wellcrafted/testing';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
} from './tauri-window.test-support.js';

const replies: { event: string; payload: unknown }[] = [];
const listeners = new Map<string, (event: { payload: number }) => void>();
let target: unknown;
let recording = false;
let refuseRecordingQuery = false;
const nativeQueries: { command: string; args: unknown }[] = [];
mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => (globalThis as { isTauri?: boolean }).isTauri === true,
	async invoke(command: string, args: unknown) {
		nativeQueries.push({ command, args });
		if (refuseRecordingQuery) throw new Error('Recording status unavailable');
		return recording;
	},
}));
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
		return () => {
			listeners.delete(event);
		};
	},
}));

const { createFolderContext } = await import('./folder-context.js');
const { holdWindowClose, reportFolderSaveStatus } = await import(
	'./window-close.js'
);
const location = Object.getOwnPropertyDescriptor(globalThis, 'location');
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
	nativeWindow.reset();
	listeners.clear();
	replies.length = 0;
	target = undefined;
	recording = false;
	refuseRecordingQuery = false;
	nativeQueries.length = 0;
	if (location === undefined) Reflect.deleteProperty(globalThis, 'location');
	else Object.defineProperty(globalThis, 'location', location);
});

/** The page is served from `url`. */
function served(url: string) {
	const { protocol, hostname } = new URL(url);
	Object.defineProperty(globalThis, 'location', {
		value: { protocol, hostname },
		configurable: true,
	});
}

const EPICENTER = 'epicenter-app://localhost/whispering/';

test('only an Epicenter desktop page registers for Quit checks', async () => {
	served(EPICENTER);
	(await reportFolderSaveStatus(() => false))();
	desktop(true);
	served('http://localhost:5173/');
	(await reportFolderSaveStatus(() => false))();
	expect(listeners.size).toBe(0);
	expect(replies).toEqual([]);
});

test('Epicenter is its scheme, or the origin Tauri maps it to on Windows and Android, and no other origin', async () => {
	desktop(true);
	for (const [url, epicenter] of [
		[EPICENTER, true],
		['http://epicenter-app.localhost/whispering/', true],
		['https://epicenter-app.localhost/whispering/', true],
		['epicenter-app://elsewhere/whispering/', false],
		['http://localhost:5173/', false],
		['https://epicenter-app.localhost.example.com/', false],
		['https://example.com/', false],
		['tauri://localhost/', false],
	] as const) {
		served(url);
		replies.length = 0;
		const unlisten = await reportFolderSaveStatus(() => false);
		expect(listeners.has('epicenter://quit-check')).toBe(epicenter);
		unlisten();
	}
	expect(nativeQueries).toEqual([]);
});

test('a targeted check reports its id and the current save state without caching it', async () => {
	desktop(true);
	served(EPICENTER);
	let pending = false;
	cleanup.push(await reportFolderSaveStatus(() => pending));
	expect(target).toEqual({ kind: 'WebviewWindow', label: 'test-folder' });
	const check = listeners.get('epicenter://quit-check');
	if (check === undefined) throw new Error('The Quit reporter must listen');
	check({ payload: 41 });
	pending = true;
	check({ payload: 42 });
	expect(replies).toEqual([
		{
			event: 'epicenter://quit-status',
			payload: { id: 41, label: 'test-folder', pending: false },
		},
		{
			event: 'epicenter://quit-status',
			payload: { id: 42, label: 'test-folder', pending: true },
		},
	]);
});

test('a saved Epicenter window reads its own recording flag and closes silently', async () => {
	desktop(true);
	served(EPICENTER);
	cleanup.push(await holdWindowClose(() => false));
	await requestClose();
	expect(nativeQueries).toEqual([
		{ command: 'window_is_recording', args: undefined },
	]);
	expect(replies).toEqual([]);
	expect(nativeDialog.count).toBe(0);
	expect(nativeWindow.destroyed).toBe(1);
});

test('recording and pending input share one native warning, and Cancel preserves both', async () => {
	desktop(true);
	served(EPICENTER);
	recording = true;
	let pending = true;
	cleanup.push(await holdWindowClose(() => pending));
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(pending).toBe(true);
	expect(recording).toBe(true);
	expect(nativeDialog.messages).toHaveLength(1);
	expect(nativeDialog.messages[0]).toContain('recording');
	expect(nativeDialog.messages[0]).toContain('not saved');
	expect(nativeDialog.messages[0]).toContain('keeps the audio captured so far');

	// Saving input cannot suppress the warning for a running recording.
	pending = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeDialog.messages).toHaveLength(2);
	expect(nativeDialog.messages[1]).toContain('recording');
	expect(nativeDialog.messages[1]).not.toContain('not saved');

	nativeDialog.answer = true;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	// The page never stops or deletes audio; native destruction finalizes it.
	expect(
		nativeQueries.every(({ command }) => command === 'window_is_recording'),
	).toBe(true);
	expect(replies).toEqual([]);
});

test('an unavailable recording status keeps the page usable and permits retry', async () => {
	desktop(true);
	served(EPICENTER);
	cleanup.push(await holdWindowClose(() => false));
	refuseRecordingQuery = true;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	refuseRecordingQuery = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a standalone window confirms pending input without querying Epicenter', async () => {
	desktop(true);
	served('tauri://localhost/');
	cleanup.push(await holdWindowClose(() => true));
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeQueries).toEqual([]);
	expect(replies).toEqual([]);
});

test('normal context close removes its Quit reporter', async () => {
	globalThis.indexedDB = new IDBFactory();
	const folder = expectOk(await openFolder({ tables: {} }));
	desktop(true);
	served(EPICENTER);
	const context = createFolderContext(folder);
	cleanup.push(() => context.close());
	await context.guardWindowClose();
	expect(listeners.has('epicenter://quit-check')).toBe(true);
	await context.close();
	expect(listeners.size).toBe(0);
});
