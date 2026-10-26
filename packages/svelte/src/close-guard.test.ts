/**
 * The desktop close guard waits for drafts and writes, then destroys once.
 * A retired guard cannot destroy a replacement or post a late failure notice.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import {
	desktop,
	nativeWindow,
	requestClose,
} from './tauri-window.test-support.js';

type Notice = {
	description: string;
	action?: { label: string; onClick(): void };
};
const warning = mock((_title: string, _notice: Notice) => {});
mock.module('@epicenter/ui/sonner', () => ({ toast: { warning } }));

const { holdWindowClose } = await import('./window-close.js');
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	nativeWindow.reset();
	warning.mockClear();
});

test('a retired guard cannot destroy the replacement window', async () => {
	desktop(true);
	const drain = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const stop = await holdWindowClose(async () => {
		started.resolve();
		await drain.promise;
	});
	cleanup.push(stop);
	const oldClose = requestClose();
	await started.promise;
	stop();
	cleanup.push(await holdWindowClose());
	stop();
	await expect(holdWindowClose()).rejects.toThrow(
		'This window already has a Folder close guard',
	);
	drain.resolve();
	await oldClose;
	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a failure notice waiting for focus cannot reach a replacement guard', async () => {
	desktop(true);
	const focus = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	nativeWindow.focus = focus.promise;
	const stop = await holdWindowClose(async () => {
		started.resolve();
		throw new Error('Draft flush failed');
	});
	cleanup.push(stop);
	const oldClose = requestClose();
	await started.promise;
	stop();
	cleanup.push(await holdWindowClose());
	focus.resolve();
	await oldClose;
	expect(warning).not.toHaveBeenCalled();
	expect(document.documentElement.inert).toBe(false);
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
	expect(warning).toHaveBeenCalledTimes(1);
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

test('a retired destroy completion keeps the replacement listener', async () => {
	desktop(true);
	const destruction = Promise.withResolvers<void>();
	nativeWindow.destruction = destruction.promise;
	const stop = await holdWindowClose();
	cleanup.push(stop);
	const oldClose = requestClose();
	for (let tries = 0; tries < 400 && !document.documentElement.inert; tries++)
		await Bun.sleep(1);
	stop();
	nativeWindow.destruction = undefined;
	cleanup.push(await holdWindowClose());
	destruction.resolve();
	await oldClose;
	expect(nativeWindow.listeners).toBe(1);
});

test('a reason to stay open keeps the window and offers to close anyway', async () => {
	desktop(true);
	let drains = 0;
	cleanup.push(
		await holdWindowClose(async () => {
			drains++;
			return 'Some typed text did not save.';
		}),
	);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	expect(warning).toHaveBeenCalledTimes(1);
	const notice = warning.mock.calls[0]?.[1];
	expect(notice?.description).toBe('Some typed text did not save.');
	expect(notice?.action?.label).toBe('Close anyway');
	notice?.action?.onClick();
	for (let tries = 0; tries < 400 && nativeWindow.destroyed === 0; tries++)
		await Bun.sleep(1);
	expect(nativeWindow.destroyed).toBe(1);
	expect(drains).toBe(1);
});
