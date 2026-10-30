/**
 * The desktop close guard waits for queued writes and destroys once;
 * closing again while it waits asks whether to
 * close anyway. One window holds one close listener.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
} from './tauri-window.test-support.js';

const { holdWindowClose } = await import('./window-close.js');
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	nativeWindow.reset();
});

test('a window holds one close listener until it is released', async () => {
	desktop(true);
	const release = await holdWindowClose();
	const again = await holdWindowClose();
	expect(nativeWindow.listeners).toBe(1);
	again();
	expect(nativeWindow.listeners).toBe(1);
	release();
	release();
	expect(nativeWindow.listeners).toBe(0);
	cleanup.push(await holdWindowClose());
	expect(nativeWindow.listeners).toBe(1);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('failed registration releases ownership for a new guard', async () => {
	desktop(true);
	nativeWindow.refuseRegistration = true;
	await expect(holdWindowClose()).rejects.toThrow(
		'Close listener could not be installed',
	);
	nativeWindow.refuseRegistration = false;
	cleanup.push(await holdWindowClose());
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('closing again while writes are out asks; Keep waiting closes once they land', async () => {
	desktop(true);
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let calls = 0;
	cleanup.push(
		await holdWindowClose(async () => {
			calls++;
			started.resolve();
			await drain.promise;
		}),
	);
	const first = requestClose();
	await started.promise;
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	expect(calls).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	drain.resolve();
	await first;
	expect(nativeWindow.destroyed).toBe(1);
});

test('a failed destroy restores input and allows another close', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose());
	nativeWindow.refuseDestroy = true;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	nativeWindow.refuseDestroy = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('successful destruction drains once and stays inert', async () => {
	desktop(true);
	let drains = 0;
	cleanup.push(
		await holdWindowClose(async () => {
			drains++;
		}),
	);
	await requestClose();
	expect(document.documentElement.inert).toBe(true);
	await requestClose();
	expect(drains).toBe(1);
	expect(nativeWindow.destroyed).toBe(1);
});

test('a close waits for queued writes without dispatching beforeunload', async () => {
	desktop(true);
	const sent: string[] = [];
	const listener = () => sent.push('beforeunload');
	window.addEventListener('beforeunload', listener);
	cleanup.push(() => window.removeEventListener('beforeunload', listener));
	cleanup.push(
		await holdWindowClose(async () => {
			sent.push('drain');
		}),
	);
	await requestClose();
	expect(sent).toEqual(['drain']);
	expect(nativeDialog.count).toBe(0);
	expect(nativeWindow.destroyed).toBe(1);
});

test('a save that never answers waits until Close anyway', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose(() => new Promise<void>(() => {})));
	void requestClose();
	await Bun.sleep(5);
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(true);
	nativeDialog.answer = true;
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(1);
});
