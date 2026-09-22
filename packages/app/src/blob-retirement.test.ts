/**
 * App retirement reaches blob network and playback resources.
 * Closing App aborts an admitted upload and revokes playback while the
 * captured Account itself remains available.
 */
import { expect, spyOn, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId, REMOTE_BLOB_ROUTES } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRemoteBlobs } from './blobs.js';

test('App close aborts an upload and releases playback without retiring the Account', async () => {
	const appId = `test.${crypto.randomUUID()}`;
	const baseURL = 'https://blob-retirement.test';
	const started = Promise.withResolvers<AbortSignal>();
	const released = Promise.withResolvers<string>();
	const originalRevoke = URL.revokeObjectURL.bind(URL);
	const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
		originalRevoke(url);
		released.resolve(url);
	});
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
			throw new Error('App must not open store synchronization.');
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const app = await openRemoteBlobs({ id: appId, account });
	try {
		await Bun.sleep(0);
		const url = REMOTE_BLOB_ROUTES.objectUrl(
			baseURL,
			appId,
			account.principalId,
			generateBlobId('wav'),
		);
		const source = expectOk(await app.open(url));
		expect(await (await fetch(source.url)).text()).toBe('audio');
		const upload = app.add(new Blob(['pending']));
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		const closing = app.close();
		expect(app.signal.aborted).toBe(true);
		expect(signal.aborted).toBe(true);
		expect(expectErr(await upload).name).toBe('Failed');
		expect(await released.promise).toBe(source.url);
		expect(revoke).toHaveBeenCalledTimes(1);
		await closing;
		// App retirement did not retire the Account itself.
		expect(await (await account.fetch(url)).text()).toBe('audio');
		expect(() => app.get(url)).toThrow();
		await new Promise<void>((resolve) => {
			if (app.signal.aborted) resolve();
			else
				app.signal.addEventListener('abort', () => resolve(), { once: true });
		});
	} finally {
		await app.close();
		revoke.mockRestore();
	}
});
