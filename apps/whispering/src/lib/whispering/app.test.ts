/**
 * Whispering reads defaults without storing them and writes settings through the
 * device KV. Persisted values survive reopening, and reset restores product defaults.
 */
import { expect, test } from 'bun:test';
import { openLocal } from '@epicenter/app/open';
import { createMemoryStoreRuntime } from '@epicenter/app/testing';
import { speechProfileDefinition, whisperingDefinition } from '../data.js';
import { DEVICE_DEFAULTS } from '../operations/settings.js';

test('settings apply defaults without writes and preserve explicit values across reopening', async () => {
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	const kv = app.kv;
	expect(
		kv.get('transcriptionModel') ?? DEVICE_DEFAULTS.transcriptionModel,
	).toBe('');
	expect(kv.get('soundManualStart') ?? DEVICE_DEFAULTS.soundManualStart).toBe(
		true,
	);
	expect(kv.get('soundManualStart')).toBeUndefined();
	kv.update({ soundManualStart: false, recordingPausePlayback: true });
	expect(kv.get('soundManualStart') ?? DEVICE_DEFAULTS.soundManualStart).toBe(
		false,
	);
	await app.close();
	const reopened = await openLocal(whisperingDefinition, { runtime });
	expect(
		reopened.kv.get('soundManualStart') ?? DEVICE_DEFAULTS.soundManualStart,
	).toBe(false);
	expect(
		reopened.kv.get('recordingPausePlayback') ??
			DEVICE_DEFAULTS.recordingPausePlayback,
	).toBe(true);
	await reopened.close();
});

test('device reset restores defaults while speech profile keys stay in a separate definition', async () => {
	const runtime = createMemoryStoreRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const app = await openLocal(whisperingDefinition, { runtime });
	const kv = app.kv;
	kv.update({
		polishEnabled: false,
		transcriptionModel: 'selected',
	});
	kv.update(DEVICE_DEFAULTS);
	expect(kv.get('polishEnabled') ?? DEVICE_DEFAULTS.polishEnabled).toBe(true);
	expect(
		Object.keys(speechProfileDefinition.kv).some(
			(key) => key in whisperingDefinition.kv,
		),
	).toBe(false);
	expect(
		kv.get('transcriptionModel') ?? DEVICE_DEFAULTS.transcriptionModel,
	).toBe('');
	await app.close();
});
