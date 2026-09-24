import { afterEach, expect, test } from 'bun:test';
import {
	MAX_HOSTED_BLOB_BYTES,
	mintPersonalBlobUrl,
	parsePersonalBlobUrl,
} from '@epicenter/blobs';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import { resolveDeploymentBlobStore } from '../s3-blob-store.js';
import type { Env } from '../types.js';
import { mountPersonalAuthorityBlobs } from './authority-blobs.js';

const origin = 'https://api.test';
const collection = `${origin}/api/blobs/personal/alice/public`;
const object = mintPersonalBlobUrl(origin, 'alice', 'public');
const privateObject = mintPersonalBlobUrl(origin, 'alice', 'private');
const config = {
	BLOBS_S3_ENDPOINT: 'https://storage.test',
	BLOBS_S3_ACCESS_KEY_ID: 'test',
	BLOBS_S3_SECRET_ACCESS_KEY: 'test',
};
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function setup(actor: string | null = 'alice') {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('authBaseURL', origin);
		await next();
	});
	mountPersonalAuthorityBlobs(app, {
		resolveStore: resolveDeploymentBlobStore,
		auth: async (c, next) => {
			if (!actor) return c.text('Unauthorized', 401);
			c.set('principal', { id: asPrincipalId(actor) });
			await next();
		},
	});
	return app;
}

test('publication returns the full URL after a create-only write', async () => {
	const writes: Request[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		writes.push(new Request(input, init));
		return new Response();
	}) as unknown as typeof fetch;
	const response = await setup().request(
		collection,
		{ method: 'POST', body: new Blob(['hello'], { type: 'audio/webm' }) },
		config,
	);
	expect(response.status).toBe(201);
	const { url } = await response.json<{ url: string }>();
	const address = parsePersonalBlobUrl(url, origin)!;
	expect(address.principalId).toBe('alice');
	expect(address.visibility).toBe('public');
	expect(writes[0]!.url).toEndWith('/' + address.storageKey);
	expect(writes[0]!.headers.get('if-none-match')).toBe('*');
	expect(await writes[0]!.text()).toBe('hello');
});

test('the public authority may sit behind a proxy that rewrites Host', async () => {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		new Response(new Request(input, init).method === 'HEAD' ? null : 'audio', {
			headers: { 'content-length': '5' },
		})) as unknown as typeof fetch;
	const proxied = new URL(object);
	proxied.host = 'internal.test';
	const response = await setup(null).request(proxied.href, {}, config);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('audio');
});

test('publication is bounded, owner-pinned, and never confirms uncertain storage', async () => {
	let writes = 0;
	globalThis.fetch = (async () => {
		writes++;
		return new Response(null, { status: 409 });
	}) as unknown as typeof fetch;
	expect(
		(
			await setup('bob').request(
				collection,
				{ method: 'POST', body: 'x' },
				config,
			)
		).status,
	).toBe(403);
	expect(
		(
			await setup().request(
				collection,
				{
					method: 'POST',
					headers: { 'content-length': String(MAX_HOSTED_BLOB_BYTES + 1) },
				},
				config,
			)
		).status,
	).toBe(413);
	expect(writes).toBe(0);
	const response = await setup().request(
		collection,
		{ method: 'POST', body: 'x' },
		config,
	);
	expect(response.status).toBe(503);
	expect(await response.text()).not.toContain('api/blobs/personal/');
	expect(writes).toBe(1);
});

test('an actual oversized body and a storage collision publish no URL', async () => {
	let writes = 0;
	globalThis.fetch = (async () => {
		writes++;
		return new Response(null, { status: 412 });
	}) as unknown as typeof fetch;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new Uint8Array(MAX_HOSTED_BLOB_BYTES));
			controller.enqueue(new Uint8Array([1]));
			controller.close();
		},
	});
	expect(
		(await setup().request(collection, { method: 'POST', body }, config))
			.status,
	).toBe(413);
	expect(writes).toBe(0);
	const collision = await setup().request(
		collection,
		{ method: 'POST', body: 'x' },
		config,
	);
	expect(collision.status).toBe(503);
	expect(await collision.text()).not.toContain('api/blobs/personal/');
	expect(writes).toBe(1);
});

test('public safe media is anonymous; unsafe content attaches; private reads require owner', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		return new Response(
			request.method === 'HEAD'
				? null
				: request.url.includes('/private/')
					? 'secret'
					: 'media',
			{
				headers: {
					'content-length': request.url.includes('/private/') ? '6' : '5',
					'content-type': request.url.includes('/private/')
						? 'text/html'
						: 'audio/webm',
					etag: '"v1"',
					'accept-ranges': 'bytes',
				},
			},
		);
	}) as typeof fetch;
	const publicResponse = await setup(null).request(object, {}, config);
	expect(publicResponse.status).toBe(200);
	expect(publicResponse.headers.get('content-disposition')).toBe('inline');
	expect(publicResponse.headers.get('x-content-type-options')).toBe('nosniff');
	expect(await publicResponse.text()).toBe('media');
	expect((await setup(null).request(privateObject, {}, config)).status).toBe(
		401,
	);
	expect((await setup('bob').request(privateObject, {}, config)).status).toBe(
		403,
	);
	expect(requests).toHaveLength(2);
	const privateResponse = await setup().request(privateObject, {}, config);
	expect(privateResponse.headers.get('content-disposition')).toBe('attachment');
	expect(privateResponse.headers.get('cache-control')).toBe(
		'private, no-store',
	);
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		new Response(
			new Request(input, init).method === 'HEAD'
				? null
				: '<script>alert(1)</script>',
			{
				headers: { 'content-type': 'text/html', 'content-length': '25' },
			},
		)) as unknown as typeof fetch;
	const unsafePublic = await setup(null).request(object, {}, config);
	expect(unsafePublic.headers.get('content-disposition')).toBe('attachment');
	expect(unsafePublic.headers.get('content-security-policy')).toBe(
		"sandbox; default-src 'none'",
	);
});

test('HEAD, ranges, and conditional status survive the proxy', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const headers = {
			'content-type': 'audio/webm',
			'content-length': '10',
			'content-range': 'bytes 0-3/10',
			etag: '"v1"',
			'accept-ranges': 'bytes',
		};
		return request.method === 'HEAD'
			? new Response(null, { headers })
			: new Response('abcd', { status: 206, headers });
	}) as typeof fetch;
	const head = await setup(null).request(object, { method: 'HEAD' }, config);
	expect(head.headers.get('content-length')).toBe('10');
	expect(await head.text()).toBe('');
	const range = await setup(null).request(
		object,
		{ headers: { range: 'bytes=0-3', 'if-range': '"v1"' } },
		config,
	);
	expect(range.status).toBe(206);
	expect(range.headers.get('content-range')).toBe('bytes 0-3/10');
	expect(requests[1]?.method).toBe('HEAD');
	expect(requests[2]?.headers.get('range')).toBe('bytes=0-3');
	expect(
		(
			await setup(null).request(
				object,
				{ headers: { range: 'bytes=0-1,4-5' } },
				config,
			)
		).status,
	).toBe(400);
	expect(requests).toHaveLength(3);
});

test('If-Range serves the full object when its validator does not match', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		requests.push(request);
		const headers = {
			etag: '"current"',
			'content-type': 'text/plain',
			'content-length': '10',
		};
		if (request.method === 'HEAD') return new Response(null, { headers });
		return request.headers.get('range') === 'bytes=0-2'
			? new Response('abc', { status: 206, headers })
			: new Response('abcdefghij', { headers });
	}) as typeof fetch;
	const response = await setup(null).request(
		object,
		{ headers: { range: 'bytes=0-2', 'if-range': '"old"' } },
		config,
	);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('abcdefghij');
	expect(requests.at(-1)?.headers.get('range')).toBe('bytes=0-9');
});

test('the route owns conditional and unsatisfiable range responses', async () => {
	globalThis.fetch = (async () =>
		new Response(null, {
			headers: {
				'content-length': '10',
				'content-type': 'audio/webm',
				etag: '"v1"',
			},
		})) as unknown as typeof fetch;
	const precondition = await setup(null).request(
		object,
		{ headers: { 'if-match': '"other"' } },
		config,
	);
	expect(precondition.status).toBe(412);
	const range = await setup(null).request(
		object,
		{ headers: { range: 'bytes=20-' } },
		config,
	);
	expect(range.status).toBe(416);
	expect(range.headers.get('content-range')).toBe('bytes */10');
	expect(range.headers.get('etag')).toBe('"v1"');
});

test('delete is exact, freshly authorized, and isolated from other owners and visibility', async () => {
	const requests: Request[] = [];
	globalThis.fetch = (async (input, init) => {
		requests.push(new Request(input, init));
		return new Response(null, { status: 204 });
	}) as typeof fetch;
	expect(
		(await setup(null).request(object, { method: 'DELETE' }, config)).status,
	).toBe(401);
	expect(
		(await setup('bob').request(object, { method: 'DELETE' }, config)).status,
	).toBe(403);
	expect(
		(await setup().request(object + '?x=1', { method: 'DELETE' }, config))
			.status,
	).toBe(404);
	expect(requests).toHaveLength(0);
	expect(
		(await setup().request(object, { method: 'DELETE' }, config)).status,
	).toBe(204);
	expect(
		(await setup().request(privateObject, { method: 'DELETE' }, config)).status,
	).toBe(204);
	expect(requests[0]!.url).not.toBe(requests[1]!.url);
	expect(requests[0]!.url).toContain('/public/');
	expect(requests[1]!.url).toContain('/private/');
});
