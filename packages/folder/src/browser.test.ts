/** This browser's storage as a place, in Bun. */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { browserStorage } from './browser.js';
import { opfsStore } from './device/opfs-store.js';
import { openingOf } from './place.js';

test('a browser that gives the page no private storage fails the open, saying so', async () => {
	const contract = defineContract({
		collections: { audio: { path: 'recordings/{id}.{ext}' } },
	});
	// Bun gives a page no private file system, as a private window does not.
	const opened = await openingOf(browserStorage(), contract).open();
	expect(opened.error).toMatchObject({
		name: 'StorageUnavailable',
		cause: { name: 'StorageRefused' },
	});
});

test('a closed store stops its Worker, and every later call is Unavailable', async () => {
	const store = opfsStore();
	// Starts the Worker; Bun has no private file system, so it answers either way.
	await store.list(['']);
	store.close();
	const after = await store.list(['']);
	expect(after.error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'WorkerFailed' },
	});
});
