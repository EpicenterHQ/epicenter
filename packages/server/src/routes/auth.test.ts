/**
 * Hosted auth routing keeps sign-in query input out of redirects and removes
 * Epicenter's OAuth discovery and consent endpoints.
 */
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';

function setup() {
	const app = new Hono<CloudEnv>();
	mountAuthRoutes(app, {
		serveAuthUiShell: () => new Response('sign-in shell'),
		setup: async (c, next) => {
			c.set('auth', {
				handler: async () => new Response('Better Auth', { status: 418 }),
			} as unknown as CloudEnv['Variables']['auth']);
			await next();
		},
	});
	return app;
}
test('sign-in serves the shell without redirecting arbitrary callback URLs', async () => {
	const app = setup();
	for (const callback of [
		'/dashboard',
		'//attacker.example',
		'/\\\\attacker.example',
		'https://attacker.example',
	]) {
		const response = await app.request(
			'/sign-in?callbackURL=' + encodeURIComponent(callback),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('location')).toBeNull();
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(await response.text()).toBe('sign-in shell');
	}
});
test('the provider catch-all remains and consent/resource discovery are absent', async () => {
	const app = setup();
	expect((await app.request('/auth/callback/google')).status).toBe(418);
	expect((await app.request('/consent')).status).toBe(404);
	expect(
		(await app.request('/.well-known/oauth-protected-resource')).status,
	).toBe(404);
});
test('the dashboard callback serves a private shell outside the Better Auth catch-all', async () => {
	const response = await setup().request(
		'/session/callback?code=one-time&state=bound',
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(await response.text()).toBe('sign-in shell');
});
