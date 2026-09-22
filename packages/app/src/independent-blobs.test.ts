/** Independent blob owners share only admitted transfers and recorder publication. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { asPrincipalId } from '@epicenter/principal';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs, acquireRemoteBlobs } from './blob-owner.js';
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
		const local = expectOk(
			await acquireLocalBlobs({
				assertUsable: () => {},
				id: 'test.source',
				binding: binding(),
			}),
		);
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
		const remote = await acquireRemoteBlobs({
			assertUsable: () => {},
			id: 'test.destination',
			account,
		});
		const id = expectOk(await local.value.add(new Blob(['exact source'])));
		const transfer = remote.value.copyFrom(local.value, id);
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

test('close during source metadata reading drains cancellation without reporting cleanup failure', async () => {
	const bytes = binding();
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const get = bytes.local.get;
	bytes.local.get = async (id) => {
		entered.resolve();
		await finish.promise;
		return get(id);
	};
	const local = expectOk(
		await acquireLocalBlobs({
			assertUsable: () => {},
			id: 'test.source',
			binding: bytes,
		}),
	);
	const id = expectOk(await local.value.add(new Blob(['source'])));
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
	const remote = await acquireRemoteBlobs({
		assertUsable: () => {},
		id: 'test.destination',
		account,
	});
	const transfer = remote.value
		.copyFrom(local.value, id)
		.catch(() => undefined);
	await entered.promise;
	const closing = local.close();
	finish.resolve();
	await expect(closing).resolves.toBeUndefined();
	await transfer;
	await remote.close();
});

test('uploads from independent local handles use the captured remote namespace and preserve local bytes', async () => {
	const requests: Request[] = [];
	const account = {
		authorityId: 'test',
		principalId: asPrincipalId('me'),
		baseURL: 'https://remote.test',
		async fetch(input, init) {
			requests.push(new Request(input, init));
			return Response.json({ id: generateBlobId('bin') }, { status: 201 });
		},
		async openWebSocket() {
			throw new Error('unused');
		},
		async getProfile() {
			throw new Error('unused');
		},
	} satisfies Account;
	const first = expectOk(
		await acquireLocalBlobs({
			assertUsable: () => {},
			id: 'test.first',
			binding: binding(),
		}),
	);
	const second = expectOk(
		await acquireLocalBlobs({
			assertUsable: () => {},
			id: 'test.second',
			binding: binding(),
		}),
	);
	const remote = await acquireRemoteBlobs({
		assertUsable: () => {},
		id: 'test.destination',
		account,
	});
	try {
		const firstId = expectOk(await first.value.add(new Blob(['first'])));
		const secondId = expectOk(await second.value.add(new Blob(['second'])));
		// Mutating the caller's account cannot retarget an already opened destination.
		account.baseURL = 'https://different.test';
		account.principalId = asPrincipalId('someone-else');
		expectOk(await remote.value.copyFrom(first.value, firstId));
		expectOk(await remote.value.copyFrom(second.value, secondId));
		expect(requests.map((request) => request.url)).toEqual([
			`https://remote.test/api/apps/test.destination/principals/me/blobs`,
			`https://remote.test/api/apps/test.destination/principals/me/blobs`,
		]);
		expect(await requests[0]!.text()).toBe('first');
		expect(await requests[1]!.text()).toBe('second');

		expect(await expectOk(await first.value.get(firstId)).text()).toBe('first');
		expect(await expectOk(await second.value.get(secondId)).text()).toBe(
			'second',
		);
		expect('add' in remote).toBe(false);
		expect('addFrom' in remote).toBe(false);
	} finally {
		await Promise.all([first.close(), second.close(), remote.close()]);
	}
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
