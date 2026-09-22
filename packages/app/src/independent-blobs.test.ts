/** Independent blob owners share only admitted transfers and recorder publication. */
import { expect, test } from 'bun:test';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import type { Account } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { openLocalBlobs, openRemoteBlobs } from './blobs.js';
import { createRecorder } from './recorder.js';
import { createBrowserRecording } from './recording/browser.js';

function binding() {
	const local = createBrowserBlobStore({
		appId: 'test.source',
		idb: { factory: new IDBFactory(), keyRange: IDBKeyRange },
	});
	return {
		local,
		sources: createBrowserBlobSources(local),
		recording: createBrowserRecording,
	};
}
for (const participant of ['local', 'remote'] as const)
	test(`${participant} close cancels a shared transfer while leaving the other handle usable`, async () => {
		const local = await openLocalBlobs({
			id: 'test.source',
			binding: binding(),
		});
		const started = Promise.withResolvers<AbortSignal>();
		const account: Account = {
			authorityId: 'test',
			principalId: asPrincipalId('me'),
			baseURL: 'https://remote.test',
			async fetch(_input, init) {
				const signal = init!.signal!;
				started.resolve(signal);
				return new Promise((_resolve, reject) =>
					signal.addEventListener('abort', () => reject(signal.reason), {
						once: true,
					}),
				);
			},
			async openWebSocket() {
				throw new Error('unexpected');
			},
			async getProfile() {
				throw new Error('unused');
			},
		};
		const remote = await openRemoteBlobs({ id: 'test.destination', account });
		const id = expectOk(await local.add(new Blob(['exact source'])));
		const transfer = remote.addFrom(local, id);
		const signal = await started.promise;
		await (participant === 'local' ? local.close() : remote.close());
		expect(signal.aborted).toBe(true);
		expect((await transfer).error).not.toBeNull();
		expect((participant === 'local' ? remote : local).signal.aborted).toBe(
			false,
		);
		await Promise.all([remote.close(), local.close()]);
	});

test('closing a recorder leaves its destination usable; closing blobs retires retained recorders', async () => {
	const local = await openLocalBlobs({ id: 'test.source', binding: binding() });
	const first = createRecorder({ blobs: local });
	await first.close();
	expect(local.signal.aborted).toBe(false);
	const id = expectOk(await local.add(new Blob(['retained'])));
	expect(await expectOk(await local.get(id)).text()).toBe('retained');
	const second = createRecorder({ blobs: local });
	await local.close();
	expect(second.signal.aborted).toBe(true);
	expect(() => second.start({})).toThrow();
	expect(() => createRecorder({ blobs: local })).toThrow();
});

test('close during source metadata reading drains cancellation without reporting cleanup failure', async () => {
	const bytes = binding();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const stat = bytes.local.stat;
	bytes.local.stat = async (id) => {
		entered.resolve();
		await finish.promise;
		return stat(id);
	};
	const local = await openLocalBlobs({ id: 'test.source', binding: bytes });
	const id = expectOk(await local.add(new Blob(['source'])));
	const account: Account = {
		authorityId: 'test',
		principalId: asPrincipalId('me'),
		baseURL: 'https://remote.test',
		async fetch() {
			throw new Error('must not dispatch');
		},
		async openWebSocket() {
			throw new Error('unexpected');
		},
		async getProfile() {
			throw new Error('unused');
		},
	};
	const remote = await openRemoteBlobs({ id: 'test.destination', account });
	const transfer = remote.addFrom(local, id).catch(() => undefined);
	await entered.promise;
	const closing = local.close();
	finish.resolve();
	await expect(closing).resolves.toBeUndefined();
	await transfer;
	await remote.close();
});
