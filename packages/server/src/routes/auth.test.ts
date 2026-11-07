/**
 * Hosted auth routing keeps sign-in query input out of redirects, serves the
 * authorization server's pages from the UI shell, and answers RFC 9728
 * discovery for the audiences this origin serves.
 */
import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { CloudEnv } from '../types.js';
import { mountAuthRoutes } from './auth.js';

const origin = 'https://api.example.test';

function setup() {
	const app = new Hono<CloudEnv>();
	app.use(async (c, next) => {
		c.set('authBaseURL', origin);
		c.set('audiences', {
			api: origin,
			folders: `${origin}/folders`,
		});
		await next();
	});
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
test('the provider catch-all remains and the consent and device pages are shells', async () => {
	const app = setup();
	expect((await app.request('/auth/callback/google')).status).toBe(418);
	for (const page of ['/consent', '/device?user_code=ABCD-EFGH']) {
		const response = await app.request(page);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.text()).toBe('sign-in shell');
	}
});
test('protected resource metadata answers only for audiences on this origin', async () => {
	const app = setup();
	const api = await app.request(
		`${origin}/.well-known/oauth-protected-resource`,
	);
	expect(api.status).toBe(200);
	expect(await api.json()).toMatchObject({
		resource: origin,
		authorization_servers: [`${origin}/auth`],
	});
	// No audience lives at another path on this origin.
	expect(
		(await app.request(`${origin}/.well-known/oauth-protected-resource/mcp`))
			.status,
	).toBe(404);
	// Another origin's metadata is not this origin's to answer.
	expect(
		(
			await app.request(
				'https://other.example.test/.well-known/oauth-protected-resource/folders',
			)
		).status,
	).toBe(404);
});
test("each audience's metadata lists its own scopes, at its own path", async () => {
	const app = setup();
	const api = await app.request(
		`${origin}/.well-known/oauth-protected-resource`,
	);
	expect(await api.json()).toMatchObject({
		scopes_supported: ['ai'],
	});
	const folders = await app.request(
		`${origin}/.well-known/oauth-protected-resource/folders`,
	);
	expect((await folders.json()) as object).toEqual({
		resource: `${origin}/folders`,
		authorization_servers: [`${origin}/auth`],
		scopes_supported: ['folders:read', 'folders:write', 'folders:all'],
		bearer_methods_supported: ['header'],
	});
});
test('the sign-in page serves a private shell outside the Better Auth catch-all', async () => {
	const response = await setup().request('/sign-in?redirect=%2Fdashboard');
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	expect(await response.text()).toBe('sign-in shell');
});
