/**
 * CORS Document-Plane Header Tests
 *
 * A browser replica is cross-origin with its authority, and the document plane
 * addresses one publication or pull entirely in headers. None of those headers
 * are CORS-safelisted in either direction, so the allow-list and expose-list
 * are load-bearing rather than cosmetic: without them a browser cannot send a
 * publication at all, and cannot read back the version or authority lifetime a
 * pull must fence installation against.
 *
 * Key behaviors:
 * - the document request headers survive preflight from a trusted origin
 * - `ETag` and the authority lifetime are exposed to the requesting page
 * - an untrusted origin still gets nothing
 */

import { expect, test } from 'bun:test';
import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
} from '@epicenter/data/document-v1';
import { Hono } from 'hono';

import type { Env } from '../types.js';
import { corsMiddleware } from './cors.js';

const TRUSTED_ORIGIN = 'https://notes.example';

function createCorsTestApp() {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('trustedOrigins', [TRUSTED_ORIGIN]);
		await next();
	});
	app.use('*', corsMiddleware);
	app.get('/api/sync/v1/records/a/b/c/document', (c) =>
		c.body(null, 204, { [DOCUMENT_LIFETIME_HEADER]: 'lifetime-one' }),
	);
	return app;
}

function allowedHeaders(response: Response): string[] {
	return (response.headers.get('access-control-allow-headers') ?? '')
		.split(',')
		.map((header) => header.trim().toLowerCase())
		.filter((header) => header.length > 0);
}

test('preflight admits every header the document plane addresses with', async () => {
	const response = await createCorsTestApp().request(
		'/api/sync/v1/records/a/b/c/document',
		{
			method: 'OPTIONS',
			headers: {
				origin: TRUSTED_ORIGIN,
				'access-control-request-method': 'GET',
				'access-control-request-headers': `${DOCUMENT_LIFETIME_HEADER}, if-none-match`,
			},
		},
	);

	const allowed = allowedHeaders(response);
	for (const header of [
		'authorization',
		'if-none-match',
		DOCUMENT_LIFETIME_HEADER,
		DOCUMENT_PROTOCOL_HEADER,
		DOCUMENT_DIGEST_HEADER,
	]) {
		expect(allowed).toContain(header.toLowerCase());
	}
});

test('a pull response exposes its version and authority lifetime to the page', async () => {
	const response = await createCorsTestApp().request(
		'/api/sync/v1/records/a/b/c/document',
		{ headers: { origin: TRUSTED_ORIGIN } },
	);

	const exposed = (response.headers.get('access-control-expose-headers') ?? '')
		.split(',')
		.map((header) => header.trim().toLowerCase());
	expect(exposed).toContain('etag');
	expect(exposed).toContain(DOCUMENT_LIFETIME_HEADER.toLowerCase());
	expect(response.headers.get('access-control-allow-origin')).toBe(
		TRUSTED_ORIGIN,
	);
});

test('an untrusted origin is still allowed nothing', async () => {
	const response = await createCorsTestApp().request(
		'/api/sync/v1/records/a/b/c/document',
		{ headers: { origin: 'https://evil.example' } },
	);

	expect(response.headers.get('access-control-allow-origin')).toBeNull();
});
