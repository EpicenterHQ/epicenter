/** This browser's storage as a place, in Bun. */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { unwrap } from 'wellcrafted/result';
import { browserStorage } from './browser.js';
import { openingOf } from './place.js';

test('a closed store stops its Worker, and every later call is Unavailable', async () => {
	const contract = defineContract({
		collections: { audio: { path: 'recordings/{id}.{ext}' } },
	});
	const store = unwrap(await openingOf(browserStorage(), contract).open());
	// Starts the Worker; Bun has no private file system, so it answers either way.
	await store.list();
	store.close?.();
	const after = await store.list();
	expect(after.error).toMatchObject({
		name: 'Unavailable',
		cause: { name: 'WorkerFailed' },
	});
});
