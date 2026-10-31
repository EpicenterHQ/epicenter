/**
 * The leave guard: a page is unsure to leave while a write is out.
 *
 * Key behaviors:
 * - A write is out from the moment it is handed over until it settles,
 *   landed or refused, and `whenSaved` answers once none is
 * - Leaving the page asks only while a write is out, and not once the guard
 *   is released
 * - On desktop, closing the window waits for the writes out, then closes
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	desktop,
	nativeWindow,
	requestClose,
	untilListening,
} from './tauri-window.test-support.js';

const { guardLeave, holdLeave, isSaving, whenSaved } = await import(
	'./leave-guard.js'
);

afterEach(() => nativeWindow.reset());

/** Whether leaving the page now would ask first. */
function leavingAsks() {
	const leaving = new Event('beforeunload', { cancelable: true });
	window.dispatchEvent(leaving);
	return leaving.defaultPrevented;
}

test('a write is out from the moment it is handed over until it settles, landed or refused', async () => {
	const first = Promise.withResolvers<string>();
	const second = Promise.withResolvers<string>();
	expect(isSaving()).toBe(false);
	await whenSaved();

	const landing = holdLeave(first.promise);
	const refused = holdLeave(second.promise);
	expect(isSaving()).toBe(true);
	let saved = false;
	void whenSaved().then(() => {
		saved = true;
	});

	first.resolve('landed');
	expect(await landing).toBe('landed');
	expect(isSaving()).toBe(true);
	expect(saved).toBe(false);

	second.reject(new Error('refused'));
	await expect(refused).rejects.toThrow('refused');
	await whenSaved();
	expect(saved).toBe(true);
	expect(isSaving()).toBe(false);
});

test('leaving the page asks only while a write is out, until the guard is released', async () => {
	const release = guardLeave();
	expect(leavingAsks()).toBe(false);

	const write = Promise.withResolvers<void>();
	const out = holdLeave(write.promise);
	expect(leavingAsks()).toBe(true);
	write.resolve();
	await out;
	expect(leavingAsks()).toBe(false);

	const again = Promise.withResolvers<void>();
	const stillOut = holdLeave(again.promise);
	release();
	expect(leavingAsks()).toBe(false);
	again.resolve();
	await stillOut;
});

test('on desktop, closing the window waits for the writes out, then closes', async () => {
	desktop(true);
	const release = guardLeave();
	await untilListening();

	const write = Promise.withResolvers<void>();
	const out = holdLeave(write.promise);
	const closing = requestClose();
	await Bun.sleep(10);
	expect(nativeWindow.destroyed).toBe(0);

	write.resolve();
	await out;
	await closing;
	expect(nativeWindow.destroyed).toBe(1);
	release();
});
