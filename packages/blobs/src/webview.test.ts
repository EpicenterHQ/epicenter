/**
 * WebView Blob Adapter Tests
 *
 * Verifies the WebView implementation of the portable local blob contract.
 * The adapter must keep requests relative to the active authenticated origin
 * and translate the small HTTP status vocabulary back into typed Results.
 *
 * Key behaviors:
 * - Stable media URLs remain relative and contain only the opaque BlobId
 * - Requests preserve same-origin cookie authentication
 * - COPY sends only ids within the captured app and account scope
 * - HTTP not-found and collision statuses become expected typed errors
 * - HEAD metadata is validated before entering the portable contract
 * - Sources hand out the stable URL after a stat check, with a safe no-op
 *   disposer
 */

import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import {
	createWebviewBlobRemote,
	createWebviewBlobSources,
	createWebviewBlobStore,
	desktopBlobUrl,
} from './webview.js';

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
		blobs: createWebviewBlobStore({ fetch: fetcher }),
		fetcher,
		requestInits,
		requests,
	};
}

test('desktopBlobUrl constructs one relative opaque-id locator', () => {
	const id = generateBlobId();

	expect(desktopBlobUrl(id)).toBe(`/api/local-blobs/${id}`);
});

test('put sends bytes with same-origin credentials and maps collisions', async () => {
	const { blobs, requestInits, requests } = setup([
		new Response(null, { status: 201 }),
		new Response(null, { status: 409 }),
	]);
	const id = generateBlobId();

	expectOk(await blobs.put(id, new Blob(['first'], { type: 'audio/wav' })));
	const error = expectErr(
		await blobs.put(id, new Blob(['second'], { type: 'audio/wav' })),
	);

	expect(error.name).toBe('BlobAlreadyExists');
	expect(requests[0]?.url).toBe(`http://localhost${desktopBlobUrl(id)}`);
	expect(requests[0]?.method).toBe('PUT');
	expect(requestInits[0]?.credentials).toBe('same-origin');
	expect(requests[0]?.headers.get('content-type')).toBe('audio/wav');
});

test('get returns response bytes and maps a missing object', async () => {
	const { blobs } = setup([
		new Response('audio', {
			headers: { 'content-type': 'audio/test' },
		}),
		new Response(null, { status: 404 }),
	]);
	const id = generateBlobId();

	const blob = expectOk(await blobs.get(id));
	expect(blob.type).toBe('audio/test');
	expect(await blob.text()).toBe('audio');
	expect(expectErr(await blobs.get(id)).name).toBe('BlobNotFound');
});

test('copy sends only ids in the captured app and account scope', async () => {
	const { fetcher, requests, requestInits } = setup([
		new Response(null, { status: 204 }),
	]);
	const scope = {
		kind: 'account' as const,
		authorityId: 'authority/one',
		principalId: 'principal one',
	};
	const blobs = createWebviewBlobStore({
		appId: 'so.epicenter.test',
		scope,
		fetch: fetcher,
	});
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	scope.authorityId = 'other-authority';
	scope.principalId = 'other-principal';
	expectOk(await blobs.copy(sourceId, destinationId));
	expect(requests).toHaveLength(1);
	const request = requests[0]!;
	const url = new URL(request.url);
	expect(url.pathname).toBe(
		`/api/apps/so.epicenter.test/blobs/${destinationId}/copy`,
	);
	expect([...url.searchParams]).toEqual([
		['authorityId', 'authority/one'],
		['principalId', 'principal one'],
	]);
	expect(request.method).toBe('POST');
	expect(request.headers.get('content-type')).toBe('application/json');
	expect(request.headers.get('authorization')).toBeNull();
	expect(await request.json()).toEqual({ sourceId });
	expect(requestInits[0]).toMatchObject({
		credentials: 'same-origin',
		redirect: 'error',
	});
});

test('local copy carries no account scope and maps each failure to the affected id', async () => {
	const { fetcher, requests } = setup(
		[204, 404, 409, 500].map((status) => new Response(null, { status })),
	);
	const blobs = createWebviewBlobStore({
		appId: 'so.epicenter.test',
		scope: { kind: 'local' },
		fetch: fetcher,
	});
	const sourceId = generateBlobId();
	const destinationId = generateBlobId();
	expectOk(await blobs.copy(sourceId, destinationId));
	expect(new URL(requests[0]!.url).search).toBe('');
	expect(expectErr(await blobs.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobNotFound',
		id: sourceId,
	});
	expect(expectErr(await blobs.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobAlreadyExists',
		id: destinationId,
	});
	expect(expectErr(await blobs.copy(sourceId, destinationId))).toMatchObject({
		name: 'BlobStoreFailed',
		id: destinationId,
	});
});

test('copy retains transport causes in a storage failure Result', async () => {
	const cause = new Error('host unavailable');
	const blobs = createWebviewBlobStore({
		appId: 'so.epicenter.test',
		fetch: async () => {
			throw cause;
		},
	});
	const destinationId = generateBlobId();
	expect(
		expectErr(await blobs.copy(generateBlobId(), destinationId)),
	).toMatchObject({ name: 'BlobStoreFailed', id: destinationId, cause });
});

test('copy refuses an unspecified app without contacting the host', async () => {
	const { blobs, requests } = setup([]);
	const destinationId = generateBlobId();
	expect(
		expectErr(await blobs.copy(generateBlobId(), destinationId)),
	).toMatchObject({ name: 'BlobStoreFailed', id: destinationId });
	expect(requests).toHaveLength(0);
});

test('stat parses HEAD metadata and rejects malformed responses', async () => {
	const { blobs } = setup([
		new Response(null, {
			headers: {
				'content-length': '42',
				'content-type': 'audio/wav',
			},
		}),
		new Response(null, {
			headers: {
				'content-length': 'not-a-number',
				'content-type': 'audio/wav',
			},
		}),
	]);
	const id = generateBlobId();

	expect(expectOk(await blobs.stat(id))).toEqual({
		contentType: 'audio/wav',
		size: 42,
	});
	expect(expectErr(await blobs.stat(id)).name).toBe('BlobStoreFailed');
});

test('delete is idempotent when the host accepts repeated requests', async () => {
	const { blobs } = setup([
		new Response(null, { status: 204 }),
		new Response(null, { status: 204 }),
	]);
	const id = generateBlobId();

	expectOk(await blobs.delete(id));
	expectOk(await blobs.delete(id));
});

test('webview sources stat local availability and return the stable URL', async () => {
	const { blobs, requests } = setup([
		new Response(null, {
			headers: { 'content-length': '7', 'content-type': 'audio/wav' },
		}),
	]);
	const sources = createWebviewBlobSources(blobs);
	const id = generateBlobId();

	const source = expectOk(await sources.open(id));
	expect(source.url).toBe(desktopBlobUrl(id));
	expect(requests[0]?.method).toBe('HEAD');

	// The URL is stable, so disposal is a harmless idempotent no-op.
	source[Symbol.dispose]();
	source[Symbol.dispose]();
	expect(source.url).toBe(desktopBlobUrl(id));
});

test('webview sources forward missing local bytes from the stat check', async () => {
	const { blobs } = setup([new Response(null, { status: 404 })]);
	const sources = createWebviewBlobSources(blobs);
	const id = generateBlobId();

	const error = expectErr(await sources.open(id));
	expect(error).toMatchObject({ name: 'BlobNotFound', id });
});

test('remote operations post the id-only path with same-origin credentials', async () => {
	const { fetcher, requests, requestInits } = setup([
		new Response(null, { status: 204 }),
		new Response(null, { status: 204 }),
		new Response(null, { status: 204 }),
	]);
	const remote = createWebviewBlobRemote({ fetch: fetcher });
	const id = generateBlobId();

	expectOk(await remote.upload(id));
	expectOk(await remote.download(id));
	expectOk(await remote.purge(id));

	expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
		`${desktopBlobUrl(id)}/upload`,
		`${desktopBlobUrl(id)}/download`,
		`${desktopBlobUrl(id)}/purge`,
	]);
	for (const request of requests) {
		expect(request.method).toBe('POST');
		expect(request.headers.get('authorization')).toBeNull();
	}
	for (const init of requestInits) {
		expect(init.credentials).toBe('same-origin');
		expect(init.body).toBeUndefined();
	}
});

test('remote statuses map onto the typed blob vocabulary', async () => {
	const { fetcher } = setup([
		new Response('Blob not found', { status: 404 }),
		new Response('Blob not found', { status: 404 }),
		new Response('Blob store failed', { status: 500 }),
		new Response('Remote operation failed', { status: 502 }),
		new Response('Remote storage unavailable', { status: 503 }),
	]);
	const remote = createWebviewBlobRemote({ fetch: fetcher });
	const id = generateBlobId();

	expect(expectErr(await remote.upload(id)).name).toBe('BlobNotFound');
	expect(expectErr(await remote.download(id)).name).toBe('RemoteBlobNotFound');
	expect(expectErr(await remote.upload(id)).name).toBe('BlobStoreFailed');
	expect(expectErr(await remote.download(id)).name).toBe('BlobRemoteFailed');
	expect(expectErr(await remote.purge(id)).name).toBe('BlobRemoteFailed');
});
