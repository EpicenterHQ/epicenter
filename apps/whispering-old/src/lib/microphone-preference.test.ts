/**
 * The microphone choice kept in this computer's `localStorage`
 * (`localPreferences`). What is kept that does not read as a choice is
 * said, never taken for the system default, and saving replaces it.
 */
import './svelte-dom.test-support.js';
import { beforeEach, expect, test } from 'bun:test';
import { localPreferences } from './microphone-preference.js';

const KEY = 'whispering.microphone';
beforeEach(() => localStorage.removeItem(KEY));

test('missing and saved microphone choices read back', async () => {
	expect(localPreferences.microphone()).toBeUndefined();
	expect(
		await localPreferences.setMicrophone({
			deviceId: 'fixture-input',
			label: 'Fixture microphone',
		}),
	).toBeUndefined();
	expect(localPreferences.microphone()).toEqual({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
	await localPreferences.setMicrophone(undefined);
	expect(localStorage.getItem(KEY)).toBeNull();
});

test('a kept choice that does not read is said, and saving replaces it', async () => {
	localStorage.setItem(KEY, '{broken');
	expect(() => localPreferences.microphone()).toThrow('not JSON');
	localStorage.setItem(KEY, '{"deviceId":""}');
	expect(() => localPreferences.microphone()).toThrow('does not name one');
	await localPreferences.setMicrophone({ deviceId: 'a', label: 'A' });
	expect(localPreferences.microphone()).toEqual({ deviceId: 'a', label: 'A' });
});
