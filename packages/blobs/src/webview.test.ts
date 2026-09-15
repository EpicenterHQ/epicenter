/**
 * WebView Blob Adapter Tests
 *
 * Verifies one captured partition for storage, playback, and remote transfers.
 *
 * Key behaviors:
 * - All verbs and playback retain identity across caller mutations
 * - Missing or invalid identity fails before fetch; local requires null
 * - Encoded segments preserve canonical routes without traversal
 * - Cookie authentication, redirect refusal, and typed status errors survive
 * - HEAD metadata and source availability are checked before playback
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import type { BlobRemoteError } from './blob-remote.js';
import type { BlobStoreError } from './blob-store.js';
import { BLOB_PATHS, createWebviewBlobs } from './webview.js';
const noNativeTransfer = {
	async nativeTransfer() {
		throw new Error('Unexpected native transfer');
	},
};
const remoteTransport = {
	baseURL: 'https://server.test',
	fetch: globalThis.fetch,
};

test('native one-shot transfer forwards only identity, evidence, ticket and cancellation', async () => {
	const signal = new AbortController().signal;
	const id = generateBlobId();
	const expected = {
		sha256: 'a'.repeat(64),
		size: 172_800_044,
		contentType: 'audio/wav',
	};
	const calls: unknown[][] = [];
	const adapter = createWebviewBlobs({
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: { library: 'local' },
		remote: null,
		fetch: async () => {
			throw new Error('Native bytes must not cross HTTP into the WebView');
		},
		async nativeTransfer(...args) {
			calls.push(args);
			if (args[0] === 'upload')
				throw {
					kind: 'transport',
					cause: 'Immutable object already exists',
					status: 412,
				};
		},
	});
	expectOk(
		await adapter.local.attachments!.download(
			id,
			expected,
			{ url: 'https://signed.test/file' },
			signal,
		),
	);
	const error = expectErr(
		await adapter.local.attachments!.upload(
			id,
			expected,
			{ url: 'https://signed.test/file', requiredHeaders: {} },
			signal,
		),
	);
	expect(error.kind).toBe('transport');
	expect(error.status).toBe(412);
	expect(calls[0]).toEqual([
		'download',
		id,
		expected,
		{ url: 'https://signed.test/file' },
		signal,
	]);
	expect(calls).toHaveLength(2);
});

function setup(responses: Response[]) {
	const requests: Request[] = [];
	const requestInits: RequestInit[] = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		requestInits.push(init ?? {});
		const absoluteInput =
			typeof input === 'string' && input.startsWith('/')
				? new URL(input, 'http://localhost')
				: input;
		requests.push(new Request(absoluteInput, init));
		const response = responses.shift();
		if (response === undefined) throw new Error('Unexpected HTTP request');
		return response;
	};
	return {
		...createWebviewBlobs({
			...noNativeTransfer,
			appId: 'so.epicenter.test',
			replica: { library: 'local' },
			remote: null,
			fetch: fetcher,
		}),
		fetcher,
		requestInits,
		requests,
	};
}

// ============================================================================
// Captured identity and canonical routes
// ============================================================================

test('host mounts use canonical local and account collection paths', () => {
	expect(BLOB_PATHS).toEqual({
		local: '/api/apps/:appId/local/blobs',
		account: '/api/apps/:appId/accounts/:authorityId/:principalId/blobs',
		shared: '/api/apps/:appId/accounts/:authorityId/:principalId/shared/blobs',
	});
});

test('all verbs and playback keep the same encoded account after input mutation', async () => {
	const metadata = () =>
		new Response(null, {
			headers: { 'content-length': '7', 'content-type': 'audio/wav' },
		});
	const { fetcher, requests, requestInits } = setup([
		metadata(),
		new Response(null, { status: 201 }),
		new Response('audio'),
		metadata(),
		metadata(),
		...Array.from({ length: 5 }, () => new Response(null, { status: 204 })),
	]);
	const account = {
		authorityId: 'authority %?#é',
		principalId: asPrincipalId('principal :@&=+'),
	};
	const options = {
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: { library: 'personal' as const, account },
		remote: remoteTransport,
		fetch: fetcher,
	};
	const { local, sources, remote } = createWebviewBlobs(options);
	const id = generateBlobId();
	const destinationId = generateBlobId();
	const prefix =
		'/api/apps/so.epicenter.test/accounts/authority%20%25%3F%23%C3%A9/principal%20%3A%40%26%3D%2B/blobs';
	// HEAD has dispatched, but open has not resumed from its await.
	const opening = sources.open(id);
	account.authorityId = 'other-authority';
	account.principalId = asPrincipalId('other-principal');
	options.appId = 'so.epicenter.other';
	options.replica.account = {
		authorityId: 'replacement',
		principalId: asPrincipalId('replacement'),
	};
	const source = expectOk(await opening);
	expect(source.url).toBe(`${prefix}/${id}`);
	source[Symbol.dispose]();
	source[Symbol.dispose]();
	expect(source.url).toBe(`${prefix}/${id}`);
	expectOk(await local.put(id, new Blob(['audio'], { type: 'audio/wav' })));
	expectOk(await local.get(id));
	expectOk(await local.stat(id));
	for (const result of await local.statMany([id])) expectOk(result);
	expectOk(await local.copy(id, destinationId));
	expectOk(await local.delete(id));
	expect(remote).not.toBeNull();
	expectOk(await remote!.upload(id));
	expectOk(await remote!.download(id));
	expectOk(await remote!.purge(id));
	expect(
		requests.map((request) => [request.method, new URL(request.url).pathname]),
	).toEqual([
		['HEAD', `${prefix}/${id}`],
		['PUT', `${prefix}/${id}`],
		['GET', `${prefix}/${id}`],
		['HEAD', `${prefix}/${id}`],
		['HEAD', `${prefix}/${id}`],
		['POST', `${prefix}/${destinationId}/copy`],
		['DELETE', `${prefix}/${id}`],
		['POST', `${prefix}/${id}/upload`],
		['POST', `${prefix}/${id}/download`],
		['POST', `${prefix}/${id}/purge`],
	]);
	for (const request of requests) {
		expect(new URL(request.url).origin).toBe('http://localhost');
		expect(new URL(request.url).search).toBe('');
		expect(new URL(request.url).hash).toBe('');
		expect(request.headers.get('authorization')).toBeNull();
	}
	for (const init of requestInits) {
		expect(init.credentials).toBe('same-origin');
		expect(init.redirect).toBe('error');
	}
	expect(requests[5]!.headers.get('content-type')).toBe('application/json');
	expect(await requests[5]!.json()).toEqual({ sourceId: id });
	for (const init of requestInits.slice(7)) expect(init.body).toBeUndefined();
});

test('explicit local identity has no remote and uses the local path for every verb', async () => {
	const { local, sources, remote, requests } = setup([
		new Response(null, { status: 201 }),
		new Response('audio'),
		new Response(null, {
			headers: { 'content-length': '5', 'content-type': 'audio/wav' },
		}),
		new Response(null, { status: 204 }),
		new Response(null, { status: 204 }),
	]);
	const id = generateBlobId();
	const destinationId = generateBlobId();
	const prefix = '/api/apps/so.epicenter.test/local/blobs/';
	expect(remote).toBeNull();
	expectOk(await local.put(id, new Blob(['audio'])));
	expectOk(await local.get(id));
	expect(expectOk(await sources.open(id)).url).toBe(prefix + id);
	expectOk(await local.copy(id, destinationId));
	expectOk(await local.delete(id));
	expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
		prefix + id,
		prefix + id,
		prefix + id,
		`${prefix + destinationId}/copy`,
		prefix + id,
	]);
});

test('missing app and account fail the type contract and throw before fetch', () => {
	const { fetcher, requests } = setup([]);
	expect(() => {
		// @ts-expect-error Account omission must never select local storage.
		createWebviewBlobs({
			...noNativeTransfer,
			appId: 'so.epicenter.test',
			fetch: fetcher,
		});
	}).toThrow();
	expect(() => {
		// @ts-expect-error App identity is mandatory for every capability.
		createWebviewBlobs({
			...noNativeTransfer,
			replica: { library: 'local' },
			remote: null,
			fetch: fetcher,
		});
	}).toThrow();
	expect(requests).toHaveLength(0);
});

test('invalid app ids and incomplete or unsafe account segments fail before fetch', () => {
	const { fetcher, requests } = setup([]);
	const invalidApps: unknown[] = [
		undefined,
		null,
		42,
		'',
		'app',
		'.',
		'..',
		'a..b',
		'SO.app',
		'a.b/../c',
		'a.b\\c',
		'a.b?x',
		'a.b#x',
		'a.%2e%2e',
		'a.b\n',
		'a.b\u0000',
	];
	const invalidSegments: unknown[] = [
		undefined,
		null,
		42,
		'',
		'.',
		'..',
		'/',
		'\\',
		'a/../b',
		'a\\b',
		'\u0000',
		'a\nb',
		'\u007f',
		'\ud800',
	];
	const invalidAccounts: unknown[] = [
		undefined,
		false,
		'account',
		[],
		{},
		{ authorityId: 'a' },
		{ principalId: 'p' },
	];
	for (const value of invalidSegments) {
		invalidAccounts.push(
			{ authorityId: value, principalId: 'p' },
			{ authorityId: 'a', principalId: value },
		);
	}
	for (const appId of invalidApps) {
		expect(() =>
			createWebviewBlobs({
				...noNativeTransfer,
				// @ts-expect-error Exercise malformed runtime input at construction.
				appId,
				replica: { library: 'local' },
				remote: null,
				fetch: fetcher,
			}),
		).toThrow();
	}
	for (const account of invalidAccounts) {
		expect(() =>
			createWebviewBlobs({
				...noNativeTransfer,
				appId: 'so.epicenter.test',
				// @ts-expect-error Exercise malformed runtime input at construction.
				replica: { library: 'personal', account },
				remote: remoteTransport,
				fetch: fetcher,
			}),
		).toThrow();
	}
	expect(requests).toHaveLength(0);
});

test('percent-encoded traversal text stays a literal identity segment', async () => {
	const { fetcher, requests } = setup([new Response('audio')]);
	const { local } = createWebviewBlobs({
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: {
			library: 'personal',
			account: {
				authorityId: '%2e%2e',
				principalId: asPrincipalId('%2f..%5c'),
			},
		},
		remote: remoteTransport,
		fetch: fetcher,
	});
	const id = generateBlobId();
	expectOk(await local.get(id));
	expect(new URL(requests[0]!.url).pathname).toBe(
		`/api/apps/so.epicenter.test/accounts/%252e%252e/%252f..%255c/blobs/${id}`,
	);
});

// ============================================================================
// Local storage and playback contracts
// ============================================================================

test('put sends bytes and content type and maps collisions', async () => {
	const { local, requests } = setup(
		[201, 409].map((status) => new Response(null, { status })),
	);
	const id = generateBlobId();
	expectOk(await local.put(id, new Blob(['first'], { type: 'audio/wav' })));
	expect(expectErr(await local.put(id, new Blob(['second'])))).toMatchObject({
		name: 'BlobAlreadyExists',
		id,
	});
	expect(requests[0]!.headers.get('content-type')).toBe('audio/wav');
	expect(await requests[0]!.text()).toBe('first');
});

test('get returns response bytes and maps a missing object', async () => {
	const { local } = setup([
		new Response('audio', { headers: { 'content-type': 'audio/test' } }),
		new Response(null, { status: 404 }),
	]);
	const id = generateBlobId();
	const blob = expectOk(await local.get(id));
	expect(blob.type).toBe('audio/test');
	expect(await blob.text()).toBe('audio');
	expect(expectErr(await local.get(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
});

test('copy maps each failure to the affected id', async () => {
	const { local } = setup(
		[404, 409, 500].map((status) => new Response(null, { status })),
	);
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	expect(expectErr(await local.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobNotFound',
		id: sourceId,
	});
	expect(expectErr(await local.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobAlreadyExists',
		id: destinationId,
	});
	expect(expectErr(await local.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobStoreFailed',
		id: destinationId,
	});
});

test('statMany preserves input order and performs no IO for empty input', async () => {
	const { local, requests } = setup([
		new Response(null, {
			headers: { 'content-length': '42', 'content-type': 'audio/wav' },
		}),
		new Response(null, { status: 404 }),
	]);
	const ids = [generateBlobId(), generateBlobId()];
	expect(await local.statMany([])).toEqual([]);
	expect(requests).toHaveLength(0);
	const results = await local.statMany(ids);
	expect(expectOk(results[0]!)).toEqual({ contentType: 'audio/wav', size: 42 });
	expect(expectErr(results[1]!)).toMatchObject({
		name: 'BlobNotFound',
		id: ids[1],
	});
});

test('stat refuses missing or invalid metadata', async () => {
	const id = generateBlobId();
	for (const length of [
		null,
		'not-a-number',
		'-1',
		'1.5',
		'9007199254740992',
	]) {
		const headers = new Headers({ 'content-type': 'audio/wav' });
		if (length !== null) headers.set('content-length', length);
		const { local } = setup([new Response(null, { headers })]);
		expect(expectErr(await local.stat(id)).name).toBe('BlobStoreFailed');
	}
	const { local } = setup([
		new Response(null, { headers: { 'content-length': '42' } }),
	]);
	expect(expectErr(await local.stat(id)).name).toBe('BlobStoreFailed');
});

test('delete is idempotent when the host accepts repeated requests', async () => {
	const { local } = setup(
		[204, 204].map((status) => new Response(null, { status })),
	);
	const id = generateBlobId();
	expectOk(await local.delete(id));
	expectOk(await local.delete(id));
});

test('sources forward missing local bytes from their stat check', async () => {
	const { sources } = setup([new Response(null, { status: 404 })]);
	const id = generateBlobId();
	expect(expectErr(await sources.open(id))).toMatchObject({
		name: 'BlobNotFound',
		id,
	});
});

test('local verbs preserve transport causes and reject failed HTTP responses', async () => {
	const cause = new Error('host unavailable');
	const { local } = createWebviewBlobs({
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: { library: 'local' },
		remote: null,
		fetch: async () => {
			throw cause;
		},
	});
	const id = generateBlobId();
	const sourceId = generateBlobId();
	for (const result of await Promise.all([
		local.put(id, new Blob()),
		local.get(id),
		local.stat(id),
		local.copy(sourceId, id),
		local.delete(id),
	]))
		expect(expectErr(result)).toMatchObject({
			name: 'BlobStoreFailed',
			id,
			cause,
		});
	for (const status of [401, 403, 500]) {
		const { local: denied } = setup(
			Array.from({ length: 5 }, () => new Response(null, { status })),
		);
		for (const result of await Promise.all([
			denied.put(id, new Blob()),
			denied.get(id),
			denied.stat(id),
			denied.copy(sourceId, id),
			denied.delete(id),
		]))
			expect(expectErr(result)).toMatchObject({ name: 'BlobStoreFailed', id });
	}
});

// ============================================================================
// Remote contracts
// ============================================================================

test('remote statuses preserve typed errors including unavailable backing', async () => {
	const cases = [
		['upload', 404, 'BlobNotFound'],
		['download', 404, 'RemoteBlobNotFound'],
		['upload', 500, 'BlobStoreFailed'],
		['download', 500, 'BlobStoreFailed'],
		['purge', 500, 'BlobRemoteFailed'],
	] as const;
	const id = generateBlobId();
	for (const [operation, status, name] of cases) {
		const { fetcher } = setup([new Response(null, { status })]);
		const { remote } = createWebviewBlobs({
			...noNativeTransfer,
			appId: 'so.epicenter.test',
			replica: {
				library: 'personal',
				account: { authorityId: 'a', principalId: asPrincipalId('p') },
			},
			remote: remoteTransport,
			fetch: fetcher,
		});
		expect(
			expectErr<BlobRemoteError | BlobStoreError>(await remote![operation](id)),
		).toMatchObject({ name, id });
	}
	for (const operation of ['upload', 'download', 'purge'] as const) {
		for (const status of [401, 403, 502, 503]) {
			const { fetcher } = setup([new Response(null, { status })]);
			const { remote } = createWebviewBlobs({
				...noNativeTransfer,
				appId: 'so.epicenter.test',
				replica: {
					library: 'personal',
					account: { authorityId: 'a', principalId: asPrincipalId('p') },
				},
				remote: remoteTransport,
				fetch: fetcher,
			});
			expect(
				expectErr<BlobRemoteError | BlobStoreError>(
					await remote![operation](id),
				).name,
			).toBe(status === 503 ? 'RemoteNotConfigured' : 'BlobRemoteFailed');
		}
	}
});

test('all remote verbs preserve transport causes', async () => {
	const cause = new Error('host unavailable');
	const { remote } = createWebviewBlobs({
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: {
			library: 'personal',
			account: { authorityId: 'a', principalId: asPrincipalId('p') },
		},
		remote: remoteTransport,
		fetch: async () => {
			throw cause;
		},
	});
	const id = generateBlobId();
	for (const operation of ['upload', 'download', 'purge'] as const) {
		expect(
			expectErr<BlobRemoteError | BlobStoreError>(await remote![operation](id)),
		).toMatchObject({
			name: 'BlobRemoteFailed',
			id,
			cause,
		});
	}
});

test('shared bytes and transfers capture the actor and selected library', async () => {
	const { fetcher, requests } = setup([
		new Response(null, { status: 201 }),
		new Response(null, { status: 204 }),
	]);
	const account = {
		authorityId: 'server',
		principalId: asPrincipalId('alice'),
	};
	const blobs = createWebviewBlobs({
		...noNativeTransfer,
		appId: 'so.epicenter.test',
		replica: { library: 'shared', account },
		remote: remoteTransport,
		fetch: fetcher,
	});
	account.principalId = asPrincipalId('bob');
	const id = generateBlobId();
	expectOk(await blobs.local.put(id, new Blob(['alice'])));
	expectOk(await blobs.remote!.upload(id));
	expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
		`/api/apps/so.epicenter.test/accounts/server/alice/shared/blobs/${id}`,
		`/api/apps/so.epicenter.test/accounts/server/alice/shared/blobs/${id}/upload`,
	]);
});
