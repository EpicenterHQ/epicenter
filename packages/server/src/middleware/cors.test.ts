/**
 * Who the CORS middleware lets in.
 *
 * This asserts the one thing the middleware decides for itself: the origin
 * allow-list is `c.var.trustedOrigins` and nothing else. The header allowances
 * are Hono's `cors()` doing what it is configured to do, so testing those here
 * tests Hono.
 *
 * This file used to do exactly that, for the document pull protocol's
 * `If-None-Match` / `ETag` pair. That protocol is gone, and the tests kept
 * passing the whole time because they stood up their own route to exercise:
 * they never touched a real one, so nothing told them their subject had been
 * deleted. The route below is a stand-in on purpose, which is why the
 * assertions are only about the origin.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { corsMiddleware } from './cors.js';

const TRUSTED_ORIGIN = 'https://notes.example.com';
const PATH = '/api/repos';

function createCorsTestApp() {
	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('trustedOrigins', [TRUSTED_ORIGIN]);
		await next();
	});
	app.use('*', corsMiddleware);
	app.get(PATH, (c) => c.body(null, 204));
	return app;
}

test('a trusted origin is echoed back with credentials', async () => {
	const res = await createCorsTestApp().request(PATH, {
		headers: { origin: TRUSTED_ORIGIN },
	});
	expect(res.headers.get('access-control-allow-origin')).toBe(TRUSTED_ORIGIN);
	expect(res.headers.get('access-control-allow-credentials')).toBe('true');
});

test('an untrusted origin gets no allow-origin header', async () => {
	const res = await createCorsTestApp().request(PATH, {
		headers: { origin: 'https://evil.example' },
	});
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
});

test('a request with no Origin header is untouched', async () => {
	const res = await createCorsTestApp().request(PATH);
	expect(res.status).toBe(204);
	expect(res.headers.get('access-control-allow-origin')).toBeNull();
});
