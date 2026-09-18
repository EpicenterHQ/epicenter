/**
 * App retirement reaches blob network and playback resources.
 * A real store retirement frame aborts an admitted upload and revokes an opened
 * playback URL while the captured Account itself remains available.
 */
import 'fake-indexeddb/auto';
import { expect, spyOn, test } from 'bun:test';
import type { Account } from '@epicenter/auth';
import { generateBlobId, REMOTE_BLOB_ROUTES } from '@epicenter/blobs';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { installTestLocks } from '@epicenter/device/test-locks';
import { asPrincipalId } from '@epicenter/principal';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { encodeFrame } from '../../data/src/sync/frames.js';
import { browser } from './browser.js';
import { defineApp } from './index.js';

installTestLocks();

test('document retirement aborts an upload and releases playback before explicit App close', async () => {
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
	const sqlite: DeviceSqliteOwner = {
		async acquire() {
			return {
				async open() {
					return {
						async run() {
							return Ok({ changes: 0 });
						},
						async all() {
							return Ok([]);
						},
						async query() {
							return Ok({ columns: [], rows: [], truncated: false });
						},
						async batch() {
							return Ok({ changes: [] });
						},
					};
				},
				async delete() {},
				async close() {},
			};
		},
	};
	const app = defineApp({
		tables: {},
		kv: {},
		id: appId,
		runtime: { ...browser, sqlite },
		ai: { runtime: null, account: null },
	}).open(account);
	try {
		expectOk(await app.ready);
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
		await app.libraryReplaced;
	} finally {
		await app.close();
		revoke.mockRestore();
	}
});
