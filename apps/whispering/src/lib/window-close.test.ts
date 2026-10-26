/**
 * Whispering Window Close Tests
 *
 * Product state over a folder, run as a desktop window: the stand-in in
 * `tauri-window.test-support`, which runs the close listener as Tauri's
 * API does. The window's close is held as `<OpenFolder>` holds it: it waits
 * for the folder's writes in flight, and asks only if the page is still
 * unsure afterwards; nothing here leaves it unsure.
 *
 * Key behaviors:
 * - A write in flight lands before the window closes, and nothing asks
 * - A recording under way holds nothing in the page: the window goes, and
 *   destroying it finishes the recording silently. Epicenter warns about
 *   active capture only for application Quit (ADR-0663)
 * - Connection settings, saved or not, do not hold the window
 * - Released, the folder no longer holds the window's close
 */
import {
	closeTestWhispering,
	createTestWhispering,
} from './whispering.test-support.js';

import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from '../../../../packages/svelte/src/tauri-window.test-support.js';
import { holdWindowClose } from '../../../../packages/svelte/src/window-close.js';
import {
	deferred,
	openMemoryTestFolder,
	openTestServices,
} from './services.test-support.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	nativeWindow.reset();
});

/** Product state in a desktop window over a folder in memory, its close held as `<OpenFolder>` holds it. */
async function openWindow() {
	const memory = await openMemoryTestFolder();
	const fixture = await openTestServices({ folder: memory });
	desktop(true);
	const { whispering } = await createTestWhispering(fixture);
	const release = await holdWindowClose(() => memory.opened.idle());
	cleanups.push(async () => {
		release();
		closeTestWhispering({ whispering, folder: fixture.folder });
		await fixture.remove();
	});
	await whispering.start();
	await untilListening();
	return { whispering, folder: fixture.folder, host: memory.host, release };
}

test('a write in flight lands before the window closes, and nothing asks', async () => {
	const window = await openWindow();
	const gate = deferred<void>();
	window.host.control.putGate = gate.promise;
	const saving = window.folder.write('note.md', 'Typed just before closing.\n');

	const closing = requestClose();
	await Bun.sleep(20);
	expect(nativeWindow.destroyed).toBe(0);
	gate.resolve();
	await closing;

	expect(nativeWindow.destroyed).toBe(1);
	expect(window.host.control.closed).toBe(false);
	expect((await saving).error).toBeNull();
	expect(window.host.text('note.md')).toBe('Typed just before closing.\n');
});

test('a recording under way holds nothing: the window goes', async () => {
	const window = await openWindow();
	await window.whispering.startRecording();

	await requestClose();

	expect(nativeWindow.destroyed).toBe(1);
});

test('unsubmitted connection settings do not prompt', async () => {
	const window = await openWindow();
	window.whispering.settings.transcription.model = 'new model';
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a connection save before a folder write does not prompt', async () => {
	const window = await openWindow();
	window.whispering.settings.transcription.model = 'saved before close';
	const saving = window.whispering.settings.transcription.save();
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
	expect(await saving).toBeUndefined();
});

test('released, the folder no longer holds the window’s close', async () => {
	const window = await openWindow();
	window.release();
	for (let tries = 0; tries < 100 && nativeWindow.listeners > 0; tries++)
		await Bun.sleep(5);
	expect(nativeWindow.listeners).toBe(0);
});
