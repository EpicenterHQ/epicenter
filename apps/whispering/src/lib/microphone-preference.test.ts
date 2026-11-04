/**
 * The microphone choice kept in this origin's `localStorage`
 * (`localPreferences`). Malformed device settings remain visible rather
 * than overwritten.
 */
import { afterEach, expect, test } from 'bun:test';
import { localPreferences } from './microphone-preference.js';

const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
afterEach(() => {
	if (originalStorage)
		Object.defineProperty(globalThis, 'localStorage', originalStorage);
	else Reflect.deleteProperty(globalThis, 'localStorage');
});

function preferences(getItem: (key: string) => string | null) {
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem },
	});
	return localPreferences;
}

test('missing and valid microphone preferences retain their meaning', async () => {
	let saved: string | null = null;
	const reader = preferences((key) => {
		expect(key).toBe('whispering.microphone');
		return saved;
	});
	expect(await reader.microphone()).toBeUndefined();
	saved = JSON.stringify({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
	expect(await reader.microphone()).toEqual({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
});

test('a refused storage read rejects instead of selecting System default', async () => {
	const reader = preferences(() => {
		throw new Error('Storage access refused');
	});
	await expect(reader.microphone()).rejects.toThrow('Storage access refused');
});

test('malformed microphone JSON rejects instead of selecting System default', async () => {
	const reader = preferences(() => '{broken');
	await expect(reader.microphone()).rejects.toBeInstanceOf(SyntaxError);
});
