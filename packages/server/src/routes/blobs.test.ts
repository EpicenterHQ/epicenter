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
		API_ROUTES.blobs.collection.url('https://api.example.com'),
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
	const requests: { method: string; path: string }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		requests.push({
			method: request.method,
			path: new URL(request.url).pathname,
		});
		return new Response(null, { status: 204 });
	}) as typeof fetch;
	const app = new Hono<Env>();
	mountBlobsApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('alice') });
			c.set('authBaseURL', 'https://api.example.com');
			await next();
		},
	});
	const blobId = generateBlobId();
	const env = {
		BLOBS_S3_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
		BLOBS_S3_ACCESS_KEY_ID: 'test-access-key',
		BLOBS_S3_SECRET_ACCESS_KEY: 'test-secret-key',
	};

	expect(
		(
			await app.request(
				API_ROUTES.blobs.byId.url('https://api.example.com', blobId),
				{ method: 'DELETE' },
				env,
			)
		).status,
	).toBe(204);
	expect(
		(
			await app.request(
				`https://api.example.com/api/blobs/${'a'.repeat(64)}`,
				{ method: 'DELETE' },
				env,
			)
		).status,
	).toBe(404);
	expect(
		(
			await app.request(
				`https://api.example.com/api/blobs/${'a'.repeat(64)}`,
				{ method: 'GET' },
				env,
			)
		).status,
	).toBe(404);
	expect(requests).toEqual([
		{
			method: 'DELETE',
			path: `/epicenter-blobs/principals/alice/blobs/${blobId}`,
		},
	]);
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
		API_ROUTES.blobs.collection.url('https://api.example.com'),
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
		API_ROUTES.blobs.byId.url('https://api.example.com', blobId),
	);
	expect(ticket.requiredHeaders).toEqual({
		'content-type': 'text/plain',
		'if-none-match': '*',
	});
	expect(ticket.uploadUrl).toContain(`/principals/alice/blobs/${blobId}`);
});
