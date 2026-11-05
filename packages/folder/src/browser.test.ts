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

test('a store whose storage is refused answers Unavailable, and once closed says so', async () => {
	const store = opfsStore();
	expect((await store.list([''])).error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'StorageRefused' },
	});
	store.close();
	expect((await store.list([''])).error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'Closed' },
	});
});
