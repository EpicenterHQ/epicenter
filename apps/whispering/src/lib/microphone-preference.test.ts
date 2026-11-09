/**
 * The microphone choice kept in this computer's settings
 * (`localPreferences`, `microphone.json`). A file that does not read as a
 * choice is said, never taken for the system default, and saving replaces it.
 */
import { expect, test } from 'bun:test';
import { settings } from '@epicenter/local';
import { outside } from '@epicenter/local/memory';
import { localPreferences } from './microphone-preference.js';

const file = settings.file('microphone.json');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('missing and saved microphone choices read back', async () => {
	await file.connected();
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
	expect(file.text()).toBeNull();
});

test('a microphone.json that does not read is said by name, and saving replaces it', async () => {
	await file.connected();
	outside.write('microphone.json', '{broken');
	await tick();
	expect(() => localPreferences.microphone()).toThrow('microphone.json');
	outside.write('microphone.json', '{"deviceId":""}');
	await tick();
	expect(() => localPreferences.microphone()).toThrow('microphone.json');
	await localPreferences.setMicrophone({ deviceId: 'a', label: 'A' });
	expect(localPreferences.microphone()).toEqual({ deviceId: 'a', label: 'A' });
});
