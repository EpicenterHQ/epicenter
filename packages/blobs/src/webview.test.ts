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
 * - HTTP not-found and collision statuses become expected typed errors
 * - HEAD metadata is validated before entering the portable contract
 * - Sources hand out the stable URL after a stat check, with a safe no-op
 *   disposer
 */

import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { generateBlobId } from './blob-id.js';
import {
	createWebviewBlobSources,
	createWebviewBlobs,
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
		blobs: createWebviewBlobs({ fetch: fetcher }),
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
