import 'fake-indexeddb/auto';
import { expect, test } from 'bun:test';
import { installTestLocks } from '@epicenter/device/test-locks';
import { expectOk } from 'wellcrafted/testing';
import { createLocalBlobs } from './blobs.js';

installTestLocks();

test('independent local handles enumerate the same app bytes and close only their own access', async () => {
	const appId = `so.epicenter.blobs-${crypto.randomUUID()}`;
	const first = createLocalBlobs({ appId });
	const second = createLocalBlobs({ appId });
	const id = expectOk(
		await first.add(new Blob(['saved'], { type: 'audio/wav' })),
	);
	expect(expectOk(await second.list()).items).toEqual([
		{ id, size: 5, contentType: 'audio/wav' },
	]);
	await first.close();
	expect(() => first.get(id)).toThrow('closed');
	expect(await expectOk(await second.get(id)).text()).toBe('saved');
	expectOk(await second.delete(id));
	expect(expectOk(await second.list()).items).toEqual([]);
	await second.close();
});
