/**
 * The close guard's async boundary, without a Folder or mounted app.
 * A retired guard cannot destroy its window or post a late failure notice;
 * status, dialog or registration failures leave another close possible.
 * Repeated requests share a pending prompt, and a dispatched destruction
 * leaves the page inert and refuses further requests until it is gone.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import {
	desktop,
	nativeDialog,
	nativeWindow,
	requestClose,
} from './tauri-window.test-support.js';

const warning = mock(() => {});
mock.module('@epicenter/ui/sonner', () => ({ toast: { warning } }));

const { holdWindowClose } = await import('./window-close.js');
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
	nativeWindow.reset();
	warning.mockClear();
});

test('a late confirmation from a stopped guard cannot destroy the replacement page', async () => {
	desktop(true);
	const stop = await holdWindowClose(() => true);
	cleanup.push(stop);
	const answer = Promise.withResolvers<boolean>();
	nativeDialog.answer = answer.promise;
	const closing = requestClose();
	for (let tries = 0; tries < 400 && nativeDialog.count === 0; tries++)
		await Bun.sleep(1);
	expect(nativeDialog.count).toBe(1);
	stop();
	cleanup.push(await holdWindowClose(() => false));
	// Repeating an old cleanup cannot release the replacement's ownership.
	stop();
	await expect(holdWindowClose(() => false)).rejects.toThrow(
		'This window already has a Folder close guard',
	);
	answer.resolve(true);
	await closing;

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a retired dialog failure cannot restore input while the replacement window is closing', async () => {
	desktop(true);
	const stop = await holdWindowClose(() => true);
	cleanup.push(stop);
	const answer = Promise.withResolvers<boolean>();
	nativeDialog.answer = answer.promise;
	const oldClose = requestClose();
	for (let tries = 0; tries < 400 && nativeDialog.count === 0; tries++)
		await Bun.sleep(1);
	expect(nativeDialog.count).toBe(1);
	stop();
	cleanup.push(await holdWindowClose(() => false));
	await requestClose();
	expect(document.documentElement.inert).toBe(true);
	answer.reject(new Error('The retired dialog failed'));
	await oldClose;

	expect(document.documentElement.inert).toBe(true);
	expect(nativeWindow.destroyed).toBe(1);
});

test('a failure notice waiting for focus cannot reach a replacement guard', async () => {
	desktop(true);
	const focus = Promise.withResolvers<void>();
	const checked = Promise.withResolvers<void>();
	nativeWindow.focus = focus.promise;
	const stop = await holdWindowClose(() => {
		checked.resolve();
		throw new Error('Save status is unavailable');
	});
	cleanup.push(stop);
	const oldClose = requestClose();
	await checked.promise;
	stop();
	cleanup.push(await holdWindowClose(() => false));
	focus.resolve();
	await oldClose;

	expect(warning).not.toHaveBeenCalled();
	expect(document.documentElement.inert).toBe(false);
	expect(nativeWindow.listeners).toBe(1);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('close uses one save-status snapshot even when saving finishes during focus', async () => {
	desktop(true);
	let pending = true;
	const focus = Promise.withResolvers<void>();
	nativeWindow.focus = focus.promise;
	const observed = Promise.withResolvers<void>();
	cleanup.push(
		await holdWindowClose(() => {
			observed.resolve();
			return pending;
		}),
	);
	const closing = requestClose();
	await observed.promise;
	pending = false;
	focus.resolve();
	await closing;

	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
});

test('a status check that throws keeps the window and allows another attempt', async () => {
	desktop(true);
	let refuse = true;
	cleanup.push(
		await holdWindowClose(() => {
			if (refuse) throw new Error('Save status is unavailable');
			return false;
		}),
	);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	expect(warning).toHaveBeenCalledTimes(1);
	refuse = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a focus failure still offers confirmation and Cancel leaves another close possible', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose(() => true));
	nativeWindow.refuseFocus = true;
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	nativeDialog.answer = true;
	await requestClose();
	expect(nativeDialog.count).toBe(2);
	expect(nativeWindow.destroyed).toBe(1);
});

test('failed registration releases ownership for a new guard', async () => {
	desktop(true);
	nativeWindow.refuseRegistration = true;
	await expect(holdWindowClose(() => false)).rejects.toThrow(
		'Close listener could not be installed',
	);
	nativeWindow.refuseRegistration = false;
	cleanup.push(await holdWindowClose(() => false));
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('repeated pending close requests show one prompt and Cancel allows another', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose(() => true));
	const answer = Promise.withResolvers<boolean>();
	nativeDialog.answer = answer.promise;
	const first = requestClose();
	for (let tries = 0; tries < 400 && nativeDialog.count === 0; tries++)
		await Bun.sleep(1);
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	answer.resolve(false);
	await first;
	expect(nativeWindow.destroyed).toBe(0);
	nativeDialog.answer = false;
	await requestClose();
	expect(nativeDialog.count).toBe(2);
});

test('a rejected dialog preserves usable input and allows another close', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose(() => true));
	const answer = Promise.withResolvers<boolean>();
	nativeDialog.answer = answer.promise;
	const closing = requestClose();
	for (let tries = 0; tries < 400 && nativeDialog.count === 0; tries++)
		await Bun.sleep(1);
	answer.reject(new Error('The native dialog was unavailable'));
	await closing;
	expect(nativeWindow.destroyed).toBe(0);
	expect(document.documentElement.inert).toBe(false);
	expect(nativeWindow.listeners).toBe(1);
	nativeDialog.answer = true;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a dispatched destroy stays inert and cannot prompt or destroy again', async () => {
	desktop(true);
	cleanup.push(await holdWindowClose(() => true));
	nativeDialog.answer = true;
	await requestClose();
	expect(document.documentElement.inert).toBe(true);
	await requestClose();
	expect(nativeDialog.count).toBe(1);
	expect(nativeWindow.destroyed).toBe(1);
});
