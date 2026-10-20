/**
 * The close guard's async boundary, without a Folder or mounted app.
 * A retired guard cannot destroy its window after a late dialog answer;
 * status or registration failures leave another close attempt possible.
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

test('a late confirmation from a stopped guard cannot destroy the replacement page', async () => {
	desktop(true);
	const stop = await holdWindowClose(() => true, 'Close anyway?');
	cleanup.push(stop);
	const answer = Promise.withResolvers<boolean>();
	nativeDialog.answer = answer.promise;
	const closing = requestClose();
	for (let tries = 0; tries < 400 && nativeDialog.count === 0; tries++)
		await Bun.sleep(1);
	expect(nativeDialog.count).toBe(1);
	stop();
	cleanup.push(await holdWindowClose(() => false, 'Close anyway?'));
	answer.resolve(true);
	await closing;

	expect(nativeWindow.destroyed).toBe(0);
	expect(nativeWindow.listeners).toBe(1);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('a save finishing while the window is focused needs no confirmation', async () => {
	desktop(true);
	let pending = true;
	cleanup.push(await holdWindowClose(() => pending, 'Close anyway?'));
	const closing = requestClose();
	pending = false;
	await closing;

	expect(nativeDialog.count).toBe(0);
	expect(nativeWindow.destroyed).toBe(1);
});

test('a status check that throws keeps the window and allows another attempt', async () => {
	desktop(true);
	let refuse = true;
	cleanup.push(
		await holdWindowClose(() => {
			if (refuse) throw new Error('Save status is unavailable');
			return false;
		}, 'Close anyway?'),
	);
	await requestClose();
	expect(nativeWindow.destroyed).toBe(0);
	refuse = false;
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});

test('failed registration releases ownership for a new guard', async () => {
	desktop(true);
	nativeWindow.refuseRegistration = true;
	await expect(holdWindowClose(() => false, 'Close anyway?')).rejects.toThrow(
		'Close listener could not be installed',
	);
	nativeWindow.refuseRegistration = false;
	cleanup.push(await holdWindowClose(() => false, 'Close anyway?'));
	await requestClose();
	expect(nativeWindow.destroyed).toBe(1);
});
