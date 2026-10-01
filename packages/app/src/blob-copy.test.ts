/** Local copies create independent identities and reject invented sources. */
import { expect, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { expectOk } from 'wellcrafted/testing';
import type { LocalBlobs } from './blobs.js';
import { defineStore } from './index.js';
import { openLocal } from './open-store.js';
import { createMemoryStoreRuntime } from './testing.js';

test('Local copies mint fresh IDs and preserve bytes across definitions', async () => {
	const runtime = createMemoryStoreRuntime();
	const definition = (id: string) => defineStore({ id, tables: {}, kv: {} });
	const a = await openLocal(definition('test.a'), { runtime });
	const b = await openLocal(definition('test.b'), { runtime });
	const source = expectOk(await a.blobs.add(new Blob(['snapshot'])));
	const copied = expectOk(await b.blobs.copyFrom(a.blobs, source));
	expect(copied).not.toBe(source);
	expect(await expectOk(await b.blobs.get(copied)).text()).toBe('snapshot');
	expect(await expectOk(await a.blobs.get(source)).text()).toBe('snapshot');
	expectOk(await a.blobs.delete(source));
	expect(await expectOk(await b.blobs.get(copied)).text()).toBe('snapshot');
	const fake = {
		get() {
			throw new Error('fake called');
		},
	} as unknown as LocalBlobs;
	expect(() => b.blobs.copyFrom(fake, generateBlobId('bin'))).toThrow(
		'store-owned',
	);
	await Promise.all([a.close(), b.close()]);
	await runtime.dispose();
});
