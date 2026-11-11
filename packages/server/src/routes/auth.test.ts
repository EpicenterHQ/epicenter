import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { CloudAuthBindings } from '../auth/create-auth.js';
import type { CloudEnv } from '../types.js';
import { authApp } from './auth.js';

type TestSession = {
	user: {
		name: string;
		email: string;
	};
};

const BASE_SECRETS = {
	BETTER_AUTH_SECRET: 'test-secret',
} satisfies CloudAuthBindings;

function createAuthRouteApp({
	session = null,
	authSecrets = BASE_SECRETS,
	shell = () =>
		new Response('<!doctype html><title>Svelte auth shell</title>', {
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		}),
}: {
	session?: TestSession | null;
	authSecrets?: CloudAuthBindings;
	shell?: CloudEnv['Variables']['authUiShell'];
} = {}) {
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('authSecrets', authSecrets);
		c.set('authUiShell', shell);
		c.set('auth', {
			api: {
				getSession: async () => session,
			},
			handler: async () =>
				new Response('better auth catch-all', { status: 418 }),
		} as never);
		await next();
	});
	app.route('/', authApp);
	return app;
}

test('GET /sign-in with a session and signed OAuth query redirects to authorize', async () => {
	const app = createAuthRouteApp({
		session: { user: { name: 'Ada', email: 'ada@example.com' } },
	});

	const response = await app.request('/sign-in?client_id=cli&sig=signed');

	expect(response.status).toBe(302);
	expect(response.headers.get('Location')).toBe(
		'/auth/oauth2/authorize?client_id=cli&sig=signed',
	);
});

test('GET /sign-in with a session and safe callbackURL redirects to callbackURL', async () => {
	const app = createAuthRouteApp({
		session: { user: { name: 'Ada', email: 'ada@example.com' } },
	});

	const response = await app.request('/sign-in?callbackURL=/dashboard');

	expect(response.status).toBe(302);
	expect(response.headers.get('Location')).toBe('/dashboard');
});

test('GET /sign-in refuses callbackURLs that resolve to another origin', async () => {
	const app = createAuthRouteApp({
		session: { user: { name: 'Ada', email: 'ada@example.com' } },
	});

	for (const callbackURL of ['//evil.example', '/\\evil.example']) {
		const response = await app.request(
			`/sign-in?callbackURL=${encodeURIComponent(callbackURL)}`,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('Location')).toBeNull();
		expect(await response.text()).toContain('Svelte auth shell');
	}
});

test('GET /sign-in with no redirect case serves the auth UI shell', async () => {
	const app = createAuthRouteApp({
		session: { user: { name: 'Ada', email: 'ada@example.com' } },
	});

	const response = await app.request('/sign-in');

	expect(response.status).toBe(200);
	expect(await response.text()).toContain('Svelte auth shell');
});

test('GET /consent without a session redirects to sign-in with callbackURL', async () => {
	const app = createAuthRouteApp();

	const response = await app.request(
		'/consent?client_id=cli&scope=email%20profile',
	);

	expect(response.status).toBe(302);
	expect(response.headers.get('Location')).toBe(
		`/sign-in?callbackURL=${encodeURIComponent(
			'/consent?client_id=cli&scope=email%20profile',
		)}`,
	);
});

test('GET /consent with a session serves the auth UI shell', async () => {
	const app = createAuthRouteApp({
		session: { user: { name: 'Ada', email: 'ada@example.com' } },
	});

	const response = await app.request('/consent?client_id=cli');

	expect(response.status).toBe(200);
	expect(await response.text()).toContain('Svelte auth shell');
});

test('GET /auth/* still reaches the Better Auth catch-all', async () => {
	const app = createAuthRouteApp();

	const response = await app.request('/auth/get-session');

	expect(response.status).toBe(418);
	expect(await response.text()).toBe('better auth catch-all');
});
