import { afterEach, describe, expect, test } from 'bun:test';
import {
	type BlobStore,
	BlobStoreError,
	generateBlobId,
} from '@epicenter/blobs';
import { Ok } from 'wellcrafted/result';
import {
	createBrowserBlobRemote,
	createBunBlobRemote,
	createEpicenterClient,
} from './index.js';

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
			generateBlobId(),
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

	test('a store 412 is idempotent upload success for the same BlobId', async () => {
		const id = generateBlobId();
		const blob = new Blob(['bytes'], { type: 'text/plain' });
		let storeInit: RequestInit | undefined;
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			storeInit = init;
			return new Response(null, { status: 412 });
		}) as unknown as typeof fetch;
		let ticketInit: RequestInit | undefined;
		const client = createEpicenterClient({
			baseURL,
			fetch: async (_input, init) => {
				ticketInit = init;
				return Response.json({
					url: `https://api.epicenter.so/api/blobs/${id}`,
					uploadUrl: 'https://store.example.com/upload',
					requiredHeaders: {
						'content-type': 'text/plain',
						'if-none-match': '*',
					},
				});
			},
		});

		const { data, error } = await client.blobs.add(id, blob);

		expect(error).toBeNull();
		expect(JSON.parse(String(ticketInit?.body))).toEqual({
			blobId: id,
			sizeBytes: 5,
			contentType: blob.type,
		});
		expect(storeInit?.body).toBe(blob);
		expect(storeInit?.headers).toEqual({
			'content-type': 'text/plain',
			'if-none-match': '*',
		});
		expect(data).toEqual({
			blobId: id,
			url: `https://api.epicenter.so/api/blobs/${id}`,
		});
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
		const id = generateBlobId();
		const presignedUrl = `https://store.example.com/principals/o/blobs/${id}?sig=1`;
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

		const { data, error } = await client.blobs.get(id);

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeCalls).toEqual([presignedUrl]);
	});

	test('a redirect without a Location header fails closed', async () => {
		const id = generateBlobId();
		let storeReached = false;
		globalThis.fetch = (async () => {
			storeReached = true;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;

		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response(null, { status: 302 }),
		});

		const { data, error } = await client.blobs.get(id);

		expect(data).toBeNull();
		expect(error?.name).toBe('RequestFailed');
		if (error?.name === 'RequestFailed') {
			expect(error.status).toBe(302);
		}
		expect(storeReached).toBe(false);
	});

	test('a 2xx from a redirect-following fetch is returned as-is', async () => {
		const id = generateBlobId();
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

		const { data, error } = await client.blobs.get(id);

		expect(error).toBeNull();
		expect(await data?.text()).toBe('blob bytes');
		expect(storeReached).toBe(false);
	});
});

describe('createBrowserBlobRemote', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('upload copies the local Blob under the same id', async () => {
		const id = generateBlobId();
		const localBlob = new Blob(['local'], { type: 'text/plain' });
		let uploadedBody: BodyInit | null | undefined;
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			uploadedBody = init?.body;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				Response.json({
					url: `${baseURL}/api/blobs/${id}`,
					uploadUrl: 'https://store.example.com/upload',
					requiredHeaders: {
						'content-type': 'text/plain',
						'if-none-match': '*',
					},
				}),
		});
		const remote = createBrowserBlobRemote({
			local: stubLocalStore({ get: async () => Ok(localBlob) }),
			client,
		});

		const { error } = await remote.upload(id);

		expect(error).toBeNull();
		expect(uploadedBody).toBe(localBlob);
	});

	test('download consumes an immutable local collision as idempotent success', async () => {
		const id = generateBlobId();
		const original = new Blob(['original']);
		const stored = original;
		const local = stubLocalStore({
			put: async () => BlobStoreError.BlobAlreadyExists({ id }),
			get: async () => Ok(stored),
		});
		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response('remote'),
		});
		const remote = createBrowserBlobRemote({ local, client });

		const { error } = await remote.download(id);

		expect(error).toBeNull();
		expect(stored).toBe(original);
	});

	test('download skips the remote when immutable local bytes already exist', async () => {
		const id = generateBlobId();
		let remoteReached = false;
		const client = createEpicenterClient({
			baseURL,
			fetch: async () => {
				remoteReached = true;
				return new Response('remote');
			},
		});
		const remote = createBrowserBlobRemote({
			local: stubLocalStore({
				stat: async () => Ok({ size: 5, contentType: 'text/plain' }),
			}),
			client,
		});

		const { error } = await remote.download(id);

		expect(error).toBeNull();
		expect(remoteReached).toBe(false);
	});

	test('download maps a remote 404 to RemoteBlobNotFound', async () => {
		const id = generateBlobId();
		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response('missing', { status: 404 }),
		});
		const remote = createBrowserBlobRemote({
			local: stubLocalStore(),
			client,
		});

		const { error } = await remote.download(id);

		expect(error?.name).toBe('RemoteBlobNotFound');
	});
});

describe('createBunBlobRemote', () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test('upload streams the lazy local file to the presigned PUT', async () => {
		const id = generateBlobId();
		const file = new Blob(['lazy file bytes'], { type: 'audio/test' });
		let uploadedBody: BodyInit | null | undefined;
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			uploadedBody = init?.body;
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch;
		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				Response.json({
					url: `${baseURL}/api/blobs/${id}`,
					uploadUrl: 'https://store.example.com/upload',
					requiredHeaders: {
						'content-type': 'audio/test',
						'if-none-match': '*',
					},
				}),
		});
		const remote = createBunBlobRemote({
			store: stubBunStore({
				openFile: async () =>
					Ok({ file, stat: { size: file.size, contentType: 'audio/test' } }),
			}),
			client,
		});

		const { error } = await remote.upload(id);

		expect(error).toBeNull();
		expect(uploadedBody).toBe(file);
	});

	test('upload without local bytes is a typed BlobNotFound', async () => {
		const id = generateBlobId();
		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response(null, { status: 200 }),
		});
		const remote = createBunBlobRemote({ store: stubBunStore(), client });

		const { error } = await remote.upload(id);

		expect(error?.name).toBe('BlobNotFound');
	});

	test('download writes the remote response stream through the store', async () => {
		const id = generateBlobId();
		let written: Response | undefined;
		const client = createEpicenterClient({
			baseURL,
			fetch: async () =>
				new Response('remote bytes', {
					headers: { 'content-type': 'audio/test' },
				}),
		});
		const remote = createBunBlobRemote({
			store: stubBunStore({
				putResponse: async (_id, response) => {
					written = response;
					return Ok(undefined);
				},
			}),
			client,
		});

		const { error } = await remote.download(id);

		expect(error).toBeNull();
		expect(await written?.text()).toBe('remote bytes');
	});

	test('download skips the remote when local bytes exist and maps a 404', async () => {
		const id = generateBlobId();
		let remoteReached = false;
		const reachingClient = createEpicenterClient({
			baseURL,
			fetch: async () => {
				remoteReached = true;
				return new Response('missing', { status: 404 });
			},
		});

		const alreadyLocal = createBunBlobRemote({
			store: stubBunStore({
				stat: async () => Ok({ size: 5, contentType: 'audio/test' }),
			}),
			client: reachingClient,
		});
		expect((await alreadyLocal.download(id)).error).toBeNull();
		expect(remoteReached).toBe(false);

		const missingRemote = createBunBlobRemote({
			store: stubBunStore(),
			client: reachingClient,
		});
		expect((await missingRemote.download(id)).error?.name).toBe(
			'RemoteBlobNotFound',
		);
	});

	test('purge maps a failed remote delete onto BlobRemoteFailed', async () => {
		const id = generateBlobId();
		const client = createEpicenterClient({
			baseURL,
			fetch: async () => new Response('nope', { status: 500 }),
		});
		const remote = createBunBlobRemote({ store: stubBunStore(), client });

		const { error } = await remote.purge(id);

		expect(error?.name).toBe('BlobRemoteFailed');
	});
});

type BunRemoteStore = Parameters<typeof createBunBlobRemote>[0]['store'];

function stubBunStore(overrides: Partial<BunRemoteStore> = {}): BunRemoteStore {
	return {
		openFile: async (id) => BlobStoreError.BlobNotFound({ id }),
		putResponse: async () => Ok(undefined),
		stat: async (id) => BlobStoreError.BlobNotFound({ id }),
		...overrides,
	};
}

function stubLocalStore(overrides: Partial<BlobStore> = {}): BlobStore {
	const store: BlobStore = {
		put: async () => Ok(undefined),
		get: async (id) => BlobStoreError.BlobNotFound({ id }),
		stat: async (id) => BlobStoreError.BlobNotFound({ id }),
		statMany: (ids) => Promise.all(ids.map((id) => store.stat(id))),
		delete: async () => Ok(undefined),
		...overrides,
	};
	return store;
}
