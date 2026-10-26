/**
 * The desktop close guard asks the page's beforeunload listeners, waits for
 * writes, and asks once more; one native question answers an unsure page.
 * One window holds one close listener, and it destroys once.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import {
	desktop,
	nativeWindow,
	requestClose,
} from './tauri-window.test-support.js';

let closeAnyway = false;
const ask = mock(async () => closeAnyway);
mock.module('@tauri-apps/plugin-dialog', () => ({ ask }));

/** A page listener that is unsure while `unsure()` says so. */
function unsureWhile(unsure: () => boolean) {
	const listener = (event: Event) => {
		if (unsure()) event.preventDefault();
	};
	window.addEventListener('beforeunload', listener);
	cleanup.push(() => window.removeEventListener('beforeunload', listener));
}

const { holdWindowClose } = await import('./window-close.js');
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	nativeWindow.reset();
	ask.mockClear();
	closeAnyway = false;
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

test('repeated close requests wait for one drain', async () => {
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

test('a page sure after its writes land closes without asking', async () => {
	desktop(true);
	let out = true;
	unsureWhile(() => out);
	cleanup.push(
		await holdWindowClose(async () => {
			out = false;
		}),
	);
	await requestClose();
	expect(ask).not.toHaveBeenCalled();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a page still unsure asks once; Keep open keeps the window usable', async () => {
	desktop(true);
	unsureWhile(() => true);
	cleanup.push(await holdWindowClose());
	await requestClose();
	expect(ask).toHaveBeenCalledTimes(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	closeAnyway = true;
	await requestClose();
	expect(ask).toHaveBeenCalledTimes(2);
	expect(nativeWindow.destroyed).toBe(1);
});

test('a drain that never answers asks after the wait instead of trapping the window', async () => {
	desktop(true);
	unsureWhile(() => true);
	cleanup.push(await holdWindowClose(() => new Promise<void>(() => {})));
	closeAnyway = true;
	await requestClose();
	expect(ask).toHaveBeenCalledTimes(1);
	expect(nativeWindow.destroyed).toBe(1);
}, 10_000);
