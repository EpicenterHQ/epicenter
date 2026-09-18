/**
 * App retirement reaches blob network and playback resources.
 * A real store retirement frame aborts an admitted upload and revokes an opened
 * playback URL while the captured Account itself remains available.
 */
import { expect, spyOn, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId, REMOTE_BLOB_ROUTES } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { encodeFrame } from './data/sync/frames.js';
import { defineApp } from './index.js';
import { openApp } from './open.js';
import { createMemoryRuntime } from './testing.js';

test('document retirement aborts an upload and releases playback before explicit App close', async () => {
	const runtime = createMemoryRuntime();
	await using _runtime = { [Symbol.asyncDispose]: () => runtime.dispose() };
	const appId = `test.${crypto.randomUUID()}`;
	const baseURL = 'https://blob-retirement.test';
	const events = new EventTarget();
	const socket = Object.assign(events, {
		readyState: 1,
		binaryType: '',
		send() {},
		close() {},
	}) as unknown as WebSocket;
	const started = Promise.withResolvers<AbortSignal>();
	const released = Promise.withResolvers<string>();
	const originalRevoke = URL.revokeObjectURL.bind(URL);
	const revoke = spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
		originalRevoke(url);
		released.resolve(url);
	});
	const account: Account = {
		supportsShared: false,
		authorityId: 'blob-retirement',
		principalId: asPrincipalId('alice'),
		baseURL,
		async fetch(input, init) {
			const request = new Request(input, init);
			if (new URL(request.url).pathname.endsWith('/current')) {
				return createCurrentDownloadResponse({
					generation: 1,
					head: 1,
					snapshot: {
						position: 1,
						bytes: new Uint8Array(await request.arrayBuffer()),
					},
					tail: [],
				});
			}
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
			return socket;
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const appDefinition = defineApp({ tables: {}, kv: {}, id: appId });
	const app = await openApp(appDefinition, {
		account,
		runtime,
	});
	try {
		await Bun.sleep(0);
		const url = REMOTE_BLOB_ROUTES.objectUrl(
			baseURL,
			appId,
			account.principalId,
			generateBlobId('wav'),
		);
		const source = expectOk(await app.blobs.remote!.open(url));
		expect(await (await fetch(source.url)).text()).toBe('audio');
		const upload = app.blobs.remote!.add(new Blob(['pending']));
		const signal = await started.promise;
		expect(signal.aborted).toBe(false);
		events.dispatchEvent(
			new MessageEvent('message', {
				data: encodeFrame({ kind: 'retired' }).buffer,
			}),
		);
		expect(app.signal.aborted).toBe(true);
		expect(signal.aborted).toBe(true);
		expect(expectErr(await upload).name).toBe('Failed');
		expect(await released.promise).toBe(source.url);
		expect(revoke).toHaveBeenCalledTimes(1);
		// Library retirement did not retire the Account itself.
		expect(await (await account.fetch(url)).text()).toBe('audio');
		expect(() => app.blobs.remote!.get(url)).toThrow();
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
