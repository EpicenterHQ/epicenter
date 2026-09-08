/**
 * Real Chromium handoff proof. Run from the repo root:
 * bun packages/auth/smoke/session-handoff.browser.mjs
 *
 * Opt-in smoke, outside bun's *.test.* discovery. Reuses Playwright declared by
 * packages/data and Hono declared by packages/server; installs nothing. Only a
 * disposable Better Auth memory fixture is seeded, through internalAdapter.
 * No provider, deployment credentials, database URL, or existing UI is involved.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bearerSubprotocol, MAIN_SUBPROTOCOL } from '@epicenter/sync';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { bearer } from 'better-auth/plugins/bearer';
import { BASE_AUTH_CONFIG } from '../../server/src/auth/base-config.js';
import { extractUpgradeBearer } from '../../server/src/auth/extract-upgrade-bearer.js';
import { sessionHandoff } from '../../server/src/auth/session-handoff.js';
import { corsMiddleware } from '../../server/src/middleware/cors.js';
import {
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
} from '../../server/src/middleware/require-auth.js';
import { mountSessionApp } from '../../server/src/routes/session.js';

const { chromium } = createRequire(
	new URL('../../data/package.json', import.meta.url),
)('playwright');
const { Hono } = createRequire(
	new URL('../../server/package.json', import.meta.url),
)('hono');
const bundle = await Bun.build({
	entrypoints: [
		fileURLToPath(new URL('./session-handoff-page.ts', import.meta.url)),
	],
	target: 'browser',
	format: 'esm',
});
assert(bundle.success, bundle.logs.map(String).join('\n'));
assert(bundle.outputs[0]);
const script = await bundle.outputs[0].text();
const db = { user: [], session: [], account: [], verification: [] };
const requests = [];
let auth;
let browser;
let apiServer;
let appServer;

function html(role) {
	return new Response(
		`<!doctype html><meta charset="utf-8"><title>Handoff browser proof</title>
		<body data-role="${role}" data-auth-origin="${apiServer.url.origin}">
		<button id="begin">Begin</button><button id="authorize">Authorize</button><button id="complete">Complete</button>
		<output></output><script type="module" src="/fixture.js"></script>`,
		{
			headers: {
				'content-type': 'text/html',
				'cache-control': 'no-store',
				'referrer-policy': 'no-referrer',
			},
		},
	);
}

try {
	const app = new Hono();
	apiServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request, server) {
			const path = new URL(request.url).pathname;
			requests.push({
				path,
				method: request.method,
				origin: request.headers.get('origin'),
				cookie: request.headers.has('cookie'),
				authorization: request.headers.has('authorization'),
			});
			if (path !== '/socket') return app.fetch(request);
			const token = extractUpgradeBearer(request.headers);
			const session = token
				? await auth.api.getSession({
						headers: new Headers({ authorization: `Bearer ${token}` }),
					})
				: null;
			if (!session) return new Response('Unauthorized', { status: 401 });
			assert(
				request.headers
					.get('sec-websocket-protocol')
					.includes(bearerSubprotocol(token)),
			);
			// Bun 1.3.1 echoes the request protocol; response options would duplicate it.
			request.headers.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
			if (server.upgrade(request, { data: { principalId: session.user.id } }))
				return;
			return new Response('Upgrade failed', { status: 400 });
		},
		websocket: {
			message(socket, message) {
				socket.send(
					JSON.stringify({
						principalId: socket.data.principalId,
						echo: String(message),
					}),
				);
			},
		},
	});
	appServer = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === '/fixture.js')
				return new Response(script, {
					headers: { 'content-type': 'text/javascript' },
				});
			return html('client');
		},
	});
	const origin = apiServer.url.origin;
	const clientOrigin = appServer.url.origin;
	const callback = `${clientOrigin}/auth/callback`;
	const secret = 'disposable-browser-handoff-secret-1234567890';
	auth = betterAuth({
		...BASE_AUTH_CONFIG,
		baseURL: origin,
		secret,
		database: memoryAdapter(db),
		trustedOrigins: [origin, clientOrigin],
		plugins: [
			bearer({ requireSignature: true }),
			sessionHandoff({ origin, callbacks: [callback] }),
		],
	});
	const context = await auth.$context;
	const user = await context.internalAdapter.createUser({
		name: 'Browser proof',
		email: 'browser@example.test',
		emailVerified: true,
	});
	const hosted = await context.internalAdapter.createSession(user.id, false);
	const signed = `${hosted.token}.${await makeSignature(hosted.token, secret)}`;
	app.use('*', async (c, next) => {
		c.set('auth', auth);
		c.set('trustedOrigins', [clientOrigin]);
		await next();
	});
	app.use('*', corsMiddleware);
	app.get(
		'/fixture/login',
		() =>
			new Response('Fixture hosted session installed', {
				headers: {
					'content-type': 'text/html',
					'set-cookie': `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax`,
				},
			}),
	);
	app.get(
		'/fixture.js',
		() =>
			new Response(script, { headers: { 'content-type': 'text/javascript' } }),
	);
	app.get('/sign-in', () => html('hosted'));
	app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));
	mountSessionApp(app, {
		auth: requireBearerPrincipal(resolveRequestSessionPrincipal),
	});

	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	const corsResponses = [];
	page.on('response', (response) => {
		if (
			response.url() === `${origin}/auth/session/redeem` ||
			response.url() === `${origin}/api/session`
		) {
			corsResponses.push({
				url: response.url(),
				status: response.status(),
				headers: response.headers(),
			});
		}
	});
	await page.goto(`${origin}/fixture/login`);
	await page.goto(clientOrigin);
	await page.getByRole('button', { name: 'Begin', exact: true }).click();
	await page.locator('output[data-status="ok"]').waitFor();
	const { login } = JSON.parse(await page.locator('output').innerText());
	const pending = await page.evaluate(() =>
		Object.entries(sessionStorage).filter(([key]) =>
			key.startsWith('epicenter.session-handoff:'),
		),
	);
	assert.equal(pending.length, 1);
	assert.match(JSON.parse(pending[0][1]).verifier, /^[A-Za-z0-9_-]{43}$/);
	await page.reload();
	assert.deepEqual(
		await page.evaluate(() =>
			Object.entries(sessionStorage).filter(([key]) =>
				key.startsWith('epicenter.session-handoff:'),
			),
		),
		pending,
	);
	await page.goto(login);
	assert.equal(new URL(page.url()).origin, origin);
	await page.getByRole('button', { name: 'Authorize', exact: true }).click();
	await page.waitForURL(`${callback}?**`);
	const callbackUrl = page.url();
	assert.deepEqual([...new URL(callbackUrl).searchParams.keys()].sort(), [
		'code',
		'state',
	]);
	assert.equal(
		new URL(callbackUrl).searchParams.get('state'),
		JSON.parse(pending[0][1]).state,
	);
	assert.deepEqual(
		await page.evaluate(() =>
			Object.entries(sessionStorage).filter(([key]) =>
				key.startsWith('epicenter.session-handoff:'),
			),
		),
		pending,
	);
	await page.getByRole('button', { name: 'Complete', exact: true }).click();
	await page.locator('output[data-status]').waitFor();
	assert.equal(
		await page.locator('output').getAttribute('data-status'),
		'ok',
		await page.locator('output').innerText(),
	);
	const result = JSON.parse(await page.locator('output').innerText());
	assert.deepEqual(result.principal, {
		principalId: user.id,
		email: user.email,
	});
	assert.equal(result.socket.protocol, MAIN_SUBPROTOCOL);
	assert.deepEqual(JSON.parse(result.socket.message), {
		principalId: user.id,
		echo: 'browser-proof',
	});
	assert.equal(result.encodedPadding, true);
	assert.equal(db.session.length, 2);
	assert.equal(db.verification.length, 0);
	assert(db.session.some((session) => session.id === hosted.id));
	assert(
		db.session.some(
			(session) => session.id !== hosted.id && session.userId === user.id,
		),
	);
	const authorize = requests.find(
		(request) =>
			request.path === '/auth/session/authorize' && request.method === 'POST',
	);
	assert.equal(authorize.origin, origin);
	assert.equal(authorize.cookie, true);
	assert.equal(authorize.authorization, false);
	for (const path of ['/auth/session/redeem', '/api/session']) {
		assert(
			requests.some(
				(request) => request.path === path && request.method === 'OPTIONS',
			),
			`Missing browser preflight: ${path}`,
		);
		const actual = requests.find(
			(request) => request.path === path && request.method !== 'OPTIONS',
		);
		assert.equal(actual.origin, clientOrigin);
		assert.equal(actual.cookie, false);
		assert.equal(actual.authorization, path === '/api/session');
		const response = corsResponses.find(
			(response) =>
				response.url === `${origin}${path}` && response.status === 200,
		);
		assert(response);
		assert.equal(response.headers['access-control-allow-origin'], clientOrigin);
	}
	// A reload constructs another client, but the spent verifier cannot be replayed.
	await page.reload();
	await page.getByRole('button', { name: 'Complete', exact: true }).click();
	await page.locator('output[data-status="error"]').waitFor();
	assert.match(
		await page.locator('output').innerText(),
		/missing|expired|does not match/,
	);
	assert.equal(
		requests.filter(
			(request) =>
				request.path === '/auth/session/redeem' && request.method === 'POST',
		).length,
		1,
	);
	assert.deepEqual(pageErrors, []);
	console.log(
		`PASS Chromium ${browser.version()}: persisted begin, hosted cookie authorization, redirect, CORS redemption, /api/session, encoded WebSocket bearer, reload replay refusal.`,
	);
} finally {
	try {
		await browser?.close();
	} finally {
		await appServer?.stop(true);
		await apiServer?.stop(true);
	}
}
