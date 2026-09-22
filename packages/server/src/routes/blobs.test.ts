/**
 * Direct blob route tests.
 * Actual bytes are bounded before immutable publication, and durable read URLs
 * name the application and owner rather than selecting whoever next signs in.
 */
import { afterEach, expect, test } from 'bun:test';
import { generateBlobId, MAX_REMOTE_BLOB_BYTES } from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountBlobsApp } from './blobs.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});
const config = {
	BLOBS_S3_ENDPOINT: 'https://storage.test',
	BLOBS_S3_ACCESS_KEY_ID: 'test',
	BLOBS_S3_SECRET_ACCESS_KEY: 'test',
};
const collection =
	'https://api.test/api/apps/so.epicenter.notes/principals/alice/blobs';
const object = `${collection}/${generateBlobId('bin')}`;
function setup(actor = 'alice') {
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId(actor) });
			c.set('authBaseURL', 'https://api.test');
			await next();
		},
	});
	return app;
}

test('creation allocates an immutable ID under the authenticated owner', async () => {
	const writes: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		writes.push(new Request(input, init));
		return new Response();
	}) as typeof fetch;
	const response = await setup().request(
		collection,
		{ method: 'POST', body: 'bytes' },
		config,
	);
	expect(response.status).toBe(201);
	const { id } = await response.json<{ id: string }>();
	expect(writes[0]!.url).toEndWith('/' + id);
	expect(writes[0]!.headers.get('if-none-match')).toBe('*');
	expect(writes[0]!.headers.get('authorization')).toContain('AWS4-HMAC-SHA256');
	expect(await writes[0]!.text()).toBe('bytes');
});

test('declared and actual oversize uploads never reach object storage', async () => {
	let writes = 0;
	globalThis.fetch = (async () => {
		writes++;
		return new Response();
	}) as unknown as typeof fetch;
	const app = setup();
	expect(
		(
			await app.request(
				collection,
				{
					method: 'POST',
					headers: { 'content-length': String(MAX_REMOTE_BLOB_BYTES + 1) },
				},
				config,
			)
		).status,
	).toBe(413);
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(MAX_REMOTE_BLOB_BYTES));
			controller.enqueue(new Uint8Array([1]));
			controller.close();
		},
	});
	expect(
		(await app.request(collection, { method: 'POST', body }, config)).status,
	).toBe(413);
	expect(writes).toBe(0);
});

test.each([
	['audio/x-wav', 'wav'],
	['audio/webm;codecs=opus', 'webm'],
	['audio/mp4', 'm4a'],
	['application/x-private-archive', 'bin'],
])('creation retains %s and allocates a .%s identity', async (contentType, extension) => {
	const writes: Request[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		writes.push(new Request(input, init));
		return new Response();
	}) as typeof fetch;
	const response = await setup().request(
		collection,
		{
			method: 'POST',
			body: new Blob(['original'], { type: contentType }),
		},
		config,
	);
	expect(response.status).toBe(201);
	expect(writes[0]!.url).toEndWith(`.${extension}`);
	expect(writes[0]!.headers.get('content-type')).toBe(contentType);
	expect(await writes[0]!.text()).toBe('original');
});

test('extensionless URLs are refused before accessing object storage', async () => {
	let reads = 0;
	globalThis.fetch = (async () => {
		reads++;
		return new Response();
	}) as unknown as typeof fetch;
	const url = object.replace(/blob_[^/]+$/, `blob_${'a'.repeat(21)}`);
	for (const method of ['GET', 'DELETE'])
		expect((await setup().request(url, { method }, config)).status).toBe(404);
	expect(reads).toBe(0);
});

test('another principal cannot read or delete the durable URL', async () => {
	let reads = 0;
	globalThis.fetch = (async () => {
		reads++;
		return new Response();
	}) as unknown as typeof fetch;
	const url = `https://api.test/api/apps/so.epicenter.notes/principals/alice/blobs/${generateBlobId('bin')}`;
	for (const method of ['GET', 'DELETE'])
		expect((await setup('bob').request(url, { method }, config)).status).toBe(
			403,
		);
	expect(reads).toBe(0);
});

test('reads proxy bytes without a signed redirect and deletes use the same key', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request);
		return request.method === 'DELETE'
			? new Response(null, { status: 204 })
			: new Response('bytes', {
					headers: { 'content-type': 'text/plain', 'content-length': '5' },
				});
	}) as unknown as typeof fetch;
	const app = setup();
	const url = `https://api.test/api/apps/so.epicenter.notes/principals/alice/blobs/${generateBlobId('bin')}`;
	const response = await app.request(url, {}, config);
	expect(await response.text()).toBe('bytes');
	expect(response.headers.get('location')).toBeNull();
	expect(response.headers.get('content-disposition')).toBe('attachment');
	expect(response.headers.get('content-security-policy')).toBe(
		"sandbox; default-src 'none'",
	);
	expect((await app.request(url, { method: 'DELETE' }, config)).status).toBe(
		204,
	);
	expect(requests[0]!.url).toBe(requests[1]!.url);
});

test('missing objects, invalid addresses and native control headers fail closed', async () => {
	globalThis.fetch = (async () =>
		new Response(null, { status: 404 })) as unknown as typeof fetch;
	const app = setup();
	expect((await app.request(collection, {}, config)).status).toBe(404);
	expect(
		(
			await app.request(
				`${collection}?scope=shared`,
				{ method: 'POST' },
				config,
			)
		).status,
	).toBe(403);
	expect(
		(
			await app.request(
				collection,
				{
					method: 'POST',
					headers: { 'x-epicenter-local-blob-id': generateBlobId('bin') },
				},
				config,
			)
		).status,
	).toBe(400);
	expect(
		(
			await app.request(
				'https://api.test/api/apps/so.epicenter.notes/blobs',
				{ method: 'POST' },
				config,
			)
		).status,
	).toBe(404);
	expect(
		(
			await app.request(
				'https://api.test/api/blobs',
				{ method: 'POST' },
				config,
			)
		).status,
	).toBe(404);
});

test('an allocation collision fails without reading or overwriting the occupied object', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		requests.push(new Request(input, init));
		return new Response(null, { status: 412 });
	}) as typeof fetch;
	expect(
		(await setup().request(collection, { method: 'POST', body: 'x' }, config))
			.status,
	).toBe(503);
	expect(requests).toHaveLength(1);
	expect(requests[0]!.headers.get('if-none-match')).toBe('*');
});

test('an authenticated caller cannot publish at an existing or chosen ID', async () => {
	let writes = 0;
	globalThis.fetch = Object.assign(
		async () => {
			writes++;
			return new Response();
		},
		{ preconnect: originalFetch.preconnect },
	);
	for (const method of ['PUT', 'POST'])
		expect(
			(await setup().request(object, { method, body: 'replace' }, config))
				.status,
		).toBe(404);
	expect(writes).toBe(0);
	expect(
		(
			await setup('bob').request(
				collection,
				{ method: 'POST', body: 'x' },
				config,
			)
		).status,
	).toBe(403);
});

test('HEAD and single ranges preserve upstream lengths, version preconditions and partial status', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push(request);
		const headers = {
			etag: '"v1"',
			'content-type': 'audio/wav',
			'accept-ranges': 'bytes',
		};
		if (request.method === 'HEAD')
			return new Response(null, {
				headers: { ...headers, 'content-length': '100' },
			});
		if (request.headers.get('if-match') === '"old"')
			return new Response(null, { status: 412 });
		if (request.headers.get('range') === 'bytes=100-')
			return new Response(null, {
				status: 416,
				headers: { ...headers, 'content-range': 'bytes */100' },
			});
		return new Response('abcd', {
			status: 206,
			headers: {
				...headers,
				'content-length': '4',
				'content-range': 'bytes 4-7/100',
			},
		});
	}) as typeof fetch;
	const app = setup();
	const head = await app.request(object, { method: 'HEAD' }, config);
	expect(head.status).toBe(200);
	expect(requests.at(-1)!.method).toBe('HEAD');
	expect(head.headers.get('content-length')).toBe('100');
	expect(await head.text()).toBe('');
	const partial = await app.request(
		object,
		{ headers: { range: 'bytes=4-7', 'if-match': '"v1"' } },
		config,
	);
	expect(partial.status).toBe(206);
	expect(partial.headers.get('content-range')).toBe('bytes 4-7/100');
	expect(partial.headers.get('etag')).toBe('"v1"');
	expect(requests.at(-1)!.headers.get('if-match')).toBe('"v1"');
	expect(await partial.text()).toBe('abcd');
	const missing = await app.request(
		object,
		{ headers: { range: 'bytes=100-' } },
		config,
	);
	expect(missing.status).toBe(416);
	expect(missing.headers.get('content-range')).toBe('bytes */100');
	expect(
		(await app.request(object, { headers: { 'if-match': '"old"' } }, config))
			.status,
	).toBe(412);
	expect(
		(await app.request(object, { headers: { range: 'bytes=0-1,4-5' } }, config))
			.status,
	).toBe(400);
});
