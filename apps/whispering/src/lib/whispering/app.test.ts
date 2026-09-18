/**
 * Whispering domains recover defaults, notify readers, retain settings across
 * reopening a durable record, and stop subscriptions when disposed.
 */
import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import {
	createMemoryRecord,
	type MemoryRecord,
	openMemory,
} from '@epicenter/app/memory';
import { createAppBlobs } from '@epicenter/blobs/app';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { whisperingDefinition } from '../data.js';
import { createWhisperingDomains } from './app.js';

Reflect.set(
	globalThis,
	'$state',
	Object.assign(<T>(value: T) => value, { raw: <T>(value: T) => value }),
);
Reflect.set(
	globalThis,
	'$derived',
	Object.assign(<T>(value: T) => value, {
		by: <T>(derive: () => T) => derive(),
	}),
);

async function openWhispering(record: MemoryRecord) {
	const data = await openMemory(whisperingDefinition, record);
	const local = createBrowserBlobStore({ appId: whisperingDefinition.id });
	const blobs = createAppBlobs({
		local,
		sources: createBrowserBlobSources(local),
	});
	return {
		data,
		device: { kv: data.kv },
		signal: new AbortController().signal,
		blobs: { local: blobs.value, remote: null },
		async close() {
			await blobs.close();
			await data[Symbol.asyncDispose]();
		},
	};
}

test('settings recover application defaults, notify, and survive a reopen', async () => {
	const record = createMemoryRecord();
	using _record = { [Symbol.dispose]: () => record.close() };
	{
		const openedApp = await openWhispering(record);
		const app = createWhisperingDomains({
			openedApp,
			data: openedApp.data,
		});

		// Chosen by the application, applied by a read, never stored.
		expect(app.settings.get('transcriptionModel')).toBe('');
		expect(app.settings.get('recordingPausePlayback')).toBe(false);
		expect(app.settings.get('soundManualStart')).toBe(true);

		let notifications = 0;
		const stop = app.settings.subscribe(() => {
			notifications += 1;
		});
		app.settings.set('recordingPausePlayback', true);
		expect(app.settings.get('recordingPausePlayback')).toBe(true);
		expect(notifications).toBeGreaterThan(0);
		stop();

		app[Symbol.dispose]();
		await openedApp.close();
	}

	// Reopening the same durable record restores the settings written above.
	const openedApp = await openWhispering(record);
	const reopened = createWhisperingDomains({
		openedApp,
		data: openedApp.data,
	});

	expect(reopened.settings.get('recordingPausePlayback')).toBe(true);

	reopened[Symbol.dispose]();
	await openedApp.close();
});

test('the domains stop reading the store once they are disposed', async () => {
	// Disposal is on the value `createWhisperingDomains` returns and not on
	// `WhisperingApp`, so the session that built the domains is the only thing
	// that can end them: a component reading the app through context has no
	// `[Symbol.dispose]` to reach for.
	const record = createMemoryRecord();
	using _record = { [Symbol.dispose]: () => record.close() };
	const openedApp = await openWhispering(record);
	const app = createWhisperingDomains({
		openedApp,
		data: openedApp.data,
	});

	app[Symbol.dispose]();
	let notifications = 0;
	app.settings.subscribe(() => {
		notifications += 1;
	});
	openedApp.device.kv.update({ recordingPausePlayback: true });

	expect(notifications).toBe(0);
	await openedApp.close();
});
