/**
 * Whispering reads defaults without storing them and writes settings through the
 * device KV. Persisted values survive reopening, and reset restores product defaults.
 */
import { expect, test } from 'bun:test';
import { openApp } from '@epicenter/app/open';
import { createMemoryRuntime } from '@epicenter/app/testing';
import { whisperingDefinition } from '../data.js';
import { APPLICATION_DEFAULTS, getSetting } from '../operations/settings.js';

test('settings apply defaults without writes and preserve explicit values across reopening', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openApp(whisperingDefinition, { runtime });
	const kv = app.device.kv;
	expect(getSetting(kv, 'transcriptionModel')).toBe('');
	expect(getSetting(kv, 'soundManualStart')).toBe(true);
	expect(kv.get('soundManualStart')).toBeUndefined();
	kv.update({ soundManualStart: false, recordingPausePlayback: true });
	expect(getSetting(kv, 'soundManualStart')).toBe(false);
	await app.close();
	const reopened = await openApp(whisperingDefinition, { runtime });
	expect(getSetting(reopened.device.kv, 'soundManualStart')).toBe(false);
	expect(getSetting(reopened.device.kv, 'recordingPausePlayback')).toBe(true);
	await reopened.close();
});

test('reset writes product defaults over saved settings in one KV update', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openApp(whisperingDefinition, { runtime });
	const kv = app.device.kv;
	kv.update({
		polishEnabled: false,
		dictionary: ['Epicenter'],
		transcriptionModel: 'selected',
	});
	kv.update(APPLICATION_DEFAULTS);
	expect(getSetting(kv, 'polishEnabled')).toBe(true);
	expect(getSetting(kv, 'dictionary')).toBeNull();
	expect(getSetting(kv, 'transcriptionModel')).toBe('');
	await app.close();
});
