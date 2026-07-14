import { afterEach, describe, expect, test } from 'bun:test';
import { createEpicenterClient } from './index.js';

const baseURL = 'https://api.epicenter.so';

describe('blobs.add fails closed', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('a 401 on the upload ticket returns an error and never PUTs bytes', async () => {
		// The ticket POST is the first authed request. If auth rejects it, the
		// client must stop before streaming bytes to the store. The store PUT goes
		// through the global `fetch`, so we fail the test if it is ever reached.
		let putReached = false;
		globalThis.fetch = (async () => {
			putReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const ticketCalls: string[] = [];
		const client = createEpicenterClient({
			baseURL,
			fetch: async (input) => {
				ticketCalls.push(String(input));
				return new Response('unauthorized', { status: 401 });
			},
		});

		const { data, error } = await client.blobs.add(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }),
		);

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(401);
		}
		expect(putReached).toBe(false);
		expect(ticketCalls).toHaveLength(1);
	});

	test('returns a BlobRef only after the store accepts the bytes', async () => {
		let stored = false;
		globalThis.fetch = (async () => {
			stored = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				Response.json({
					status: 'upload',
					url: `${baseURL}/api/blobs/hash`,
					uploadUrl: 'https://store.example.com/upload',
					requiredHeaders: {},
				}),
		});

		const { data, error } = await client.blobs.add(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }),
		);

		expect(error).toBeNull();
		expect(stored).toBe(true);
		expect(data?.ref).toEqual({
			hash: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
			size: 3,
			mediaType: 'text/plain;charset=utf-8',
		});
	});

	test('duplicate BlobRef uses the durable object media type', async () => {
		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				Response.json({
					status: 'duplicate',
					url: `${baseURL}/api/blobs/hash`,
					size: 3,
					mediaType: 'application/x-original',
				}),
		});

		const { data, error } = await client.blobs.add(
			new Blob([new Uint8Array([1, 2, 3])], { type: 'text/plain' }),
		);

		expect(error).toBeNull();
		expect(data?.ref).toEqual({
			hash: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
			size: 3,
			mediaType: 'application/x-original',
		});
	});
});

test('blobs.head returns exact durable reference metadata', async () => {
	const hash = 'a'.repeat(64);
	const client = createEpicenterClient({
		baseURL,
		fetch: async () =>
			new Response(null, {
				status: 200,
				headers: {
					'content-length': '42',
					'content-type': 'audio/webm',
					'x-epicenter-sha256': hash,
				},
			}),
	});

	expect(await client.blobs.head(hash)).toEqual({
		data: { hash, size: 42, mediaType: 'audio/webm' },
		error: null,
	});
});

describe('blobs.get follows the 302 by hand', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('a manual-redirect 302 is followed with the plain global fetch', async () => {
		// A bearer-authed fetch pins `redirect: 'manual'`, so the server's 302
		// surfaces raw. The client must read `Location` and hit the presigned URL
		// through the global `fetch` (no bearer), then hand back the bytes.
		const presignedUrl =
			'https://store.example.com/principals/o/blobs/abc?sig=1';
		const storeCalls: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request) => {
			storeCalls.push(String(input));
			return new Response('blob bytes', {
				status: 200,
				headers: { 'content-type': 'text/plain' },
			});
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				new Response(null, {
					status: 302,
					headers: { location: presignedUrl },
				}),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeCalls).toEqual([presignedUrl]);
	});

	test('a redirect without a Location header fails closed', async () => {
		let storeReached = false;
		globalThis.fetch = (async () => {
			storeReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response(null, { status: 302 }),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(302);
		}
		expect(storeReached).toBe(false);
	});

	test('a 2xx from a redirect-following fetch is returned as-is', async () => {
		// A cookie-authed browser fetch follows the redirect itself; the client
		// must not fetch again.
		let storeReached = false;
		globalThis.fetch = (async () => {
			storeReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response('blob bytes', { status: 200 }),
		});

		const { data, error } = await client.blobs.get('abc');

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeReached).toBe(false);
	});
});
