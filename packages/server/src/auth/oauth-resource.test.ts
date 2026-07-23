/**
 * OAuth resource response tests.
 *
 * `createOAuthUnauthorizedResourceResponse` is HTTP-only: it maps an
 * `OAuthError` to a JSON failure response with the right status and, on a 401,
 * the `WWW-Authenticate` challenge. WebSocket-upgrade rejection belongs to
 * each transport surface, so there is no runtime global to exercise here.
 */

import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { OAuthError } from './oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from './oauth-resource.js';

test('InvalidToken returns 401 with the invalid_token challenge', async () => {
	const app = new Hono();
	app.get('/resource', (c) =>
		createOAuthUnauthorizedResourceResponse(c, OAuthError.InvalidToken().error),
	);

	const response = await app.request('/resource');

	expect(response.status).toBe(401);
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
	const body = (await response.json()) as { name: string };
	expect(body.name).toBe('InvalidToken');
});

test('ServerError returns 503 with no bearer challenge', async () => {
	const app = new Hono();
	app.get('/resource', (c) =>
		createOAuthUnauthorizedResourceResponse(c, OAuthError.ServerError().error),
	);

	const response = await app.request('/resource');

	expect(response.status).toBe(503);
	expect(response.headers.get('WWW-Authenticate')).toBeNull();
	const body = (await response.json()) as { name: string };
	expect(body.name).toBe('ServerError');
});
