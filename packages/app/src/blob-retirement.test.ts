/** Closing Personal blob access aborts publication without retiring its captured Account. */
import { expect, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '@epicenter/blobs/browser';
import { asPrincipalId } from '@epicenter/principal';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { acquireLocalBlobs, acquireRemoteBlobs } from './blob-owner.js';
import { createBrowserRecording } from './recording/browser.js';

test('Remote close aborts a copy without retiring the Account and presentation requires its worker', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	const baseURL = 'https://blob-retirement.test';
	const started = Promise.withResolvers<AbortSignal>();
	const account: Account = {
		authorityId: 'blob-retirement',
		principalId: asPrincipalId('alice'),
		baseURL,
		async fetch(input, init) {
			const request = new Request(input, init);
			if (request.method === 'GET')
				return new Response('audio', {
					headers: { 'content-type': 'audio/wav' },
				});
			started.resolve(request.signal);
			return new Promise<Response>((_resolve, reject) => {
				request.signal.addEventListener(
					'abort',
					() => reject(request.signal.reason),
					{ once: true },
				);
			});
		},
		async openWebSocket() {
			throw new Error('Remote blobs must not open store synchronization.');
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const store = createBrowserBlobStore({
		appId,
		idb: { factory: new IDBFactory(), keyRange: IDBKeyRange },
	});
	const local = expectOk(
		await acquireLocalBlobs({
			assertUsable: () => {},
			id: appId,
			binding: {
				local: store,
				sources: createBrowserBlobSources(store),
				recording: createBrowserRecording,
			},
		}),
	);
	const remote = await acquireRemoteBlobs({
		assertUsable: () => {},
		id: appId,
		account,
	});
	try {
		await Bun.sleep(0);
		const url = generateBlobId('wav');
		expect(expectErr(await remote.value.open(url)).name).toBe('Failed');
		const id = expectOk(await local.value.add(new Blob(['pending'])));
		const upload = remote.value.copyFrom(local.value, id);
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		const closing = remote.close();
		expect(remote.signal.aborted).toBe(true);
		expect(signal.aborted).toBe(true);
		expect(expectErr(await upload).name).toBe('PublicationUnconfirmed');
		await closing;
		// Remote handle retirement did not retire the Account itself.
		expect(await (await account.fetch(baseURL + '/test')).text()).toBe('audio');
		expect(() => remote.value.get(url)).toThrow();
		await new Promise<void>((resolve) => {
			if (remote.signal.aborted) resolve();
			else
				remote.signal.addEventListener('abort', () => resolve(), {
					once: true,
				});
		});
	} finally {
		await Promise.all([remote.close(), local.close()]);
	}
});
