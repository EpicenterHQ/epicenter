/**
 * Blob route boundary tests.
 *
 * Wave 3 removes the identity URL segment. Auth supplies the principal; the route
 * URL carries only the blob surface and optional BlobId.
 */

import { afterEach, expect, test } from 'bun:test';
import { generateBlobId } from '@epicenter/blobs';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountBlobsApp } from './blobs.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('collection route uses the principal from auth without a principal URL segment', async () => {
	const app = new Hono().post(
		API_ROUTES.blobs.collection.pattern,
		(c) =>
			new Response(JSON.stringify({ path: c.req.path }), {
				headers: { 'content-type': 'application/json' },
			}),
	);
	const url = API_ROUTES.blobs.collection.url('https://x');
	const res = await app.request(url, { method: 'POST' });

	expect(res.status).toBe(200);
	expect(new URL(url).pathname).toBe('/api/blobs');
	const body = (await res.json()) as unknown;
	expect(body).toEqual({ path: '/api/blobs' });
});

test('the collection has no enumeration route', async () => {
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			c.set('authBaseURL', 'https://api.example.com');
			await next();
		},
	});

	const res = await app.request(
		`${API_ROUTES.blobs.collection.url('https://api.example.com')}?appId=so.epicenter.notes&library=personal`,
		{ method: 'GET' },
		{
			BLOBS_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
			BLOBS_S3_ACCESS_KEY_ID: 'test-access-key',
			BLOBS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
		},
	);

	expect(res.status).toBe(404);
});

test('by-id route accepts only canonical BlobIds', async () => {
	const app = new Hono().get(API_ROUTES.blobs.byId.pattern, (c) =>
		c.text(c.req.param('blobId')),
	);
	const blobId = generateBlobId();

	expect(
		(await app.request(API_ROUTES.blobs.byId.url('https://x', blobId))).status,
	).toBe(200);
	expect(
		(await app.request(`https://x/api/blobs/${'a'.repeat(64)}`)).status,
	).toBe(404);
});

test('upload ticket presigns directly without a HEAD request', async () => {
	globalThis.fetch = (async () => {
		throw new Error('ticket mint must not call S3');
	}) as unknown as typeof fetch;
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			c.set('authBaseURL', 'https://api.example.com');
			await next();
		},
	});
	const blobId = generateBlobId();
	const res = await app.request(
		`${API_ROUTES.blobs.collection.url('https://api.example.com')}?appId=so.epicenter.notes&library=personal`,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				blobId,
				sizeBytes: 5,
				contentType: 'text/plain',
			}),
		},
		{
			BLOBS_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
			BLOBS_S3_ACCESS_KEY_ID: 'test-access-key',
			BLOBS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
		},
	);

	expect(res.status).toBe(200);
	const ticket = (await res.json()) as {
		url: string;
		uploadUrl: string;
		requiredHeaders: Record<string, string>;
	};
	expect(ticket.url).toBe(
		`${API_ROUTES.blobs.byId.url('https://api.example.com', blobId)}?appId=so.epicenter.notes&library=personal`,
	);
	expect(ticket.requiredHeaders).toEqual({
		'content-type': 'text/plain',
		'if-none-match': '*',
	});
	expect(ticket.uploadUrl).toContain(
		`/libraries/apps/so.epicenter.notes/personal/alice/blobs/${blobId}`,
	);
});

test('Personal and Shared tickets, reads, and deletes use the same authorized library', async () => {
	const blobId = generateBlobId();
	const config = {
		BLOBS_S3_ENDPOINT: 'https://storage.test',
		BLOBS_S3_ACCESS_KEY_ID: 'test',
		BLOBS_S3_SECRET_ACCESS_KEY: 'test',
	};
	const requests: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requests.push(
			new URL(input instanceof Request ? input.url : String(input)).pathname,
		);
		return new Response(null, { status: 200 });
	}) as typeof fetch;
	async function destination(actor: string, library: 'personal' | 'shared') {
		const app = new Hono<Env>();
		mountBlobsApp(app, {
			shared: true,
			auth: async (c, next) => {
				c.set('principal', { id: asPrincipalId(actor) });
				c.set('authBaseURL', 'https://api.test');
				await next();
			},
		});
		const query = `?appId=so.epicenter.notes&library=${library}`;
		const ticket = await app.request(
			`https://api.test/api/blobs${query}`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					blobId,
					sizeBytes: 3,
					contentType: 'text/plain',
				}),
			},
			config,
		);
		expect(ticket.status).toBe(200);
		const body = (await ticket.json()) as { url: string; uploadUrl: string };
		const key = new URL(body.uploadUrl).pathname;
		const get = await app.request(body.url, {}, config);
		expect(get.status).toBe(302);
		expect(new URL(get.headers.get('location')!).pathname).toBe(key);
		expect(
			(await app.request(body.url, { method: 'DELETE' }, config)).status,
		).toBe(204);
		expect(requests.slice(-2)).toEqual([key, key]);
		return key;
	}
	const alice = await destination('alice', 'personal');
	const bob = await destination('bob', 'personal');
	expect(alice).not.toBe(bob);
	const shared = await destination('alice', 'shared');
	expect(await destination('bob', 'shared')).toBe(shared);
	expect(shared).not.toBe(alice);
});

test('Cloud refuses Shared blob operations before storage access', async () => {
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			await next();
		},
	});
	const id = generateBlobId();
	for (const method of ['POST', 'GET', 'DELETE']) {
		const path = method === 'POST' ? '/api/blobs' : `/api/blobs/${id}`;
		expect(
			(
				await app.request(
					`https://api.test${path}?appId=so.epicenter.notes&library=shared`,
					{ method },
				)
			).status,
		).toBe(403);
	}
});
