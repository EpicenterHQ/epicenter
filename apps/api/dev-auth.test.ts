/**
 * Tests for the dev-only `Bearer dev:<principalId>` resolver.
 *
 * Drives {@link resolveDevPrincipal} through the real `requireBearerPrincipal` wrapper
 * (the production library middleware) by closing the wrapper over it, exactly
 * how a deployment builds its auth. This proves two things at once: the
 * resolver's own behavior (localhost guard, bearer parsing, synthetic principal) and
 * that the wrapper honors the resolver it was given instead of a hardcoded one.
 *
 * Imported from `@epicenter/server/bun` (not the main barrel) so the Cloudflare
 * Cloudflare Durable Object modules, which import `cloudflare:workers`, never load
 * in this Bun test.
 */

import { expect, test } from 'bun:test';
import { type CloudEnv, requireBearerPrincipal } from '@epicenter/server/bun';
import { Hono } from 'hono';
import { resolveDevPrincipal } from './dev-auth.js';

/** A minimal app: guard `/protected` with a wrapper closed over the dev resolver. */
function devAuthApp() {
	return new Hono<CloudEnv>().get(
		'/protected',
		requireBearerPrincipal(resolveDevPrincipal),
		(c) => c.json(c.var.principal),
	);
}

test('resolves Bearer dev:<principalId> to a synthetic principal on localhost', async () => {
	const res = await devAuthApp().request('/protected', {
		headers: { authorization: 'Bearer dev:alice' },
	});

	expect(res.status).toBe(200);
	const body = (await res.json()) as { id: string; email: string };
	expect(body).toEqual({ id: 'alice', email: 'alice@dev.invalid' });
});

test('rejects a request with no bearer (401 InvalidToken)', async () => {
	const res = await devAuthApp().request('/protected');

	expect(res.status).toBe(401);
	expect(((await res.json()) as { name: string }).name).toBe('InvalidToken');
});

test('rejects a dev bearer when the request did not land on localhost', async () => {
	// Same valid `dev:` token, but the request URL is off-box: the belt-and-
	// suspenders hostname guard refuses it even though the wrapper would
	// otherwise accept the resolver's result.
	const res = await devAuthApp().request('http://evil.example.com/protected', {
		headers: { authorization: 'Bearer dev:alice' },
	});

	expect(res.status).toBe(401);
	expect(((await res.json()) as { name: string }).name).toBe('InvalidToken');
});

test('rejects a non-dev bearer token', async () => {
	const res = await devAuthApp().request('/protected', {
		headers: { authorization: 'Bearer not-a-dev-token' },
	});

	expect(res.status).toBe(401);
});

test('rejects an empty principal id (Bearer dev:)', async () => {
	const res = await devAuthApp().request('/protected', {
		headers: { authorization: 'Bearer dev:' },
	});

	expect(res.status).toBe(401);
});
