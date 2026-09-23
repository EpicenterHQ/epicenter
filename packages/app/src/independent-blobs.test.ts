/** Local blob owners retain recorder and publication lifetimes. */
import { expect, test } from 'bun:test';
import { createBrowserBlobSources, createBrowserBlobStore } from '@epicenter/blobs/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs } from './blob-owner.js';
import { createRecorder } from './recorder.js';
import { createBrowserRecording } from './recording/browser.js';

function binding() {
  const local = createBrowserBlobStore({
    appId: 'test.source',
    idb: { factory: new IDBFactory(), keyRange: IDBKeyRange },
  });
  return { local, sources: createBrowserBlobSources(local), recording: createBrowserRecording };
}
test('closing a recorder leaves its destination usable; closing blobs retires retained recorders', async () => {
	const local = expectOk(
		await acquireLocalBlobs({
			assertUsable: () => {},
			id: 'test.source',
			binding: binding(),
		}),
	);
	const first = createRecorder({ localBlobs: local.value });
	await first.close();
	expect(local.signal.aborted).toBe(false);
	const id = expectOk(await local.value.add(new Blob(['retained'])));
	expect(await expectOk(await local.value.get(id)).text()).toBe('retained');
	const second = createRecorder({ localBlobs: local.value });
	await local.close();
	expect(second.signal.aborted).toBe(true);
	expect(() => second.start({})).toThrow();
	expect(() => createRecorder({ localBlobs: local.value })).toThrow();
});

test('Local add preserves the minted identity and scope after a writer commits then throws', async () => {
	const bytes = binding();
	const put = bytes.local.put;
	bytes.local.put = async (id, blob) => {
		expectOk(await put(id, blob));
		throw new Error('acknowledgment lost');
	};
	const owner = expectOk(
		await acquireLocalBlobs({
			id: 'test.source',
			binding: bytes,
			assertUsable() {},
		}),
	);
	const result = await owner.value.add(new Blob(['published']));
	expect(result.error).not.toBeNull();
	if (!result.error) throw new Error('Expected failed acknowledgment');
	expect(result.error.destination).toEqual({
		kind: 'local',
		namespace: 'test.source',
	});
	expect(await expectOk(await owner.value.get(result.error.id)).text()).toBe(
		'published',
	);
	await owner.close();
});
