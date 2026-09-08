/**
 * Built dashboard and hosted sign-in smoke with real Chromium/WebAuthn.
 * Run `bun run --cwd apps/api/ui build` first, then
 * `bun packages/auth/smoke/dashboard.browser.mjs` from the repository root.
 * Seeds only disposable Better Auth memory state. No provider or billing calls.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { BASE_AUTH_CONFIG } from '../../server/src/auth/base-config.js';
import { authPlugins } from '../../server/src/auth/plugins.js';
import { requireAccountSession } from '../../server/src/auth/session-policy.js';
import {
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
} from '../../server/src/middleware/require-auth.js';
import { authApp } from '../../server/src/routes/auth.js';
import { mountSessionApp } from '../../server/src/routes/session.js';

const { chromium } = createRequire(
	new URL('../../data/package.json', import.meta.url),
)('playwright');
const { Hono } = createRequire(
	new URL('../../server/package.json', import.meta.url),
)('hono');
const build = fileURLToPath(
	new URL('../../../apps/api/ui/build/', import.meta.url),
);
assert(
	await Bun.file(`${build}fallback.html`).exists(),
	'Build apps/api/ui first',
);
const db = {
	user: [],
	session: [],
	account: [],
	verification: [],
	passkey: [],
};
const requests = [];
const app = new Hono();
let browser;
const server = Bun.serve({
	hostname: 'localhost',
	port: 0,
	fetch: (request) => app.fetch(request),
});
try {
	const origin = server.url.origin;
	const secret = 'disposable-dashboard-browser-secret-1234567890';
	const auth = betterAuth({
		...BASE_AUTH_CONFIG,
		baseURL: origin,
		secret,
		database: memoryAdapter(db),
		trustedOrigins: [origin],
		plugins: authPlugins(origin, [`${origin}/session/callback`]),
		hooks: {
			before: requireAccountSession((headers) =>
				auth.api.getSession({
					headers,
					query: { disableCookieCache: true, disableRefresh: true },
				}),
			),
		},
	});
	const context = await auth.$context;
	const alice = await context.internalAdapter.createUser({
		name: 'Alice proof',
		email: 'alice@example.test',
		emailVerified: true,
	});
	const bob = await context.internalAdapter.createUser({
		name: 'Bob proof',
		email: 'bob@example.test',
		emailVerified: true,
	});
	const hosted = await context.internalAdapter.createSession(alice.id, false);
	const signed = `${hosted.token}.${await makeSignature(hosted.token, secret)}`;
	const shell = () =>
		new Response(Bun.file(`${build}fallback.html`), {
			headers: { 'content-type': 'text/html' },
		});
	app.use('*', async (c, next) => {
		requests.push({
			path: c.req.path,
			method: c.req.method,
			cookie: c.req.raw.headers.has('cookie'),
			bearer: c.req.raw.headers.has('authorization'),
			principal: c.req.raw.headers.get('x-epicenter-principal'),
		});
		c.set('auth', auth);
		c.set('authUiShell', shell);
		await next();
	});
	app.get(
		'/fixture/login',
		() =>
			new Response('Disposable hosted login', {
				headers: {
					'set-cookie': `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax`,
				},
			}),
	);
	app.route('/', authApp);
	mountSessionApp(app, {
		auth: requireBearerPrincipal(resolveRequestSessionPrincipal),
	});
	// Billing remains outside this smoke. Its real bearer gate still runs.
	app.use(
		'/api/billing/*',
		requireBearerPrincipal(resolveRequestSessionPrincipal),
	);
	app.all('/api/billing/*', () =>
		Response.json({ message: 'Billing fixture unavailable' }, { status: 503 }),
	);
	app.get('/dashboard', shell);
	app.get('/dashboard/*', shell);
	app.get('/*', async (c) => {
		const path = c.req.path;
		if (!path.startsWith('/_app/') && path !== '/favicon.ico')
			return c.notFound();
		const file = Bun.file(`${build}${path.slice(1)}`);
		return (await file.exists()) ? new Response(file) : c.notFound();
	});

	browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	page.setDefaultTimeout(10_000);
	const pageErrors = [];
	page.on('pageerror', (error) => pageErrors.push(error.message));
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await page.goto(`${origin}/fixture/login`);
	await page.goto(`${origin}/dashboard`);
	await page
		.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
		.click();
	await page.waitForURL(`${origin}/sign-in?**`);
	await page
		.getByRole('button', {
			name: 'Continue as alice@example.test',
			exact: true,
		})
		.click();
	await page.waitForURL(`${origin}/dashboard`);
	assert.equal(db.session.length, 2);
	const persisted = await page.evaluate(() =>
		JSON.parse(localStorage.getItem('so.epicenter.dashboard.auth.persisted')),
	);
	assert.equal(persisted.principalId, alice.id);
	assert(persisted.token && persisted.token !== signed);

	// An unrelated hosted cookie must not replace the dashboard's captured Alice.
	const bobSession = await context.internalAdapter.createSession(bob.id, false);
	const bobSigned = `${bobSession.token}.${await makeSignature(bobSession.token, secret)}`;
	await page.context().addCookies([
		{
			name: context.authCookies.sessionToken.name,
			value: encodeURIComponent(bobSigned),
			url: origin,
			httpOnly: true,
			sameSite: 'Lax',
		},
	]);
	await page.goto(`${origin}/dashboard/account`);
	await page.getByText('alice@example.test', { exact: true }).waitFor();
	await page.getByText('No passkeys yet.', { exact: true }).waitFor();
	const registration = page.waitForResponse((response) =>
		response.url().endsWith('/auth/passkey/verify-registration'),
	);
	await page
		.getByRole('button', { name: 'Add a passkey', exact: true })
		.click();
	const registered = await registration;
	assert.equal(registered.status(), 200, await registered.text());
	assert.equal(db.passkey.length, 1);
	assert.equal(db.passkey[0].userId, alice.id);
	await page.getByTitle('Rename passkey').click();
	await page.getByPlaceholder('Passkey name').fill('Chromium proof');
	await page.getByRole('button', { name: 'Save', exact: true }).click();
	await page.getByText('Chromium proof', { exact: true }).waitFor();

	for (const request of requests.filter((request) =>
		request.path.startsWith('/api/'),
	)) {
		assert(request.bearer, `Missing captured bearer: ${request.path}`);
		assert.equal(
			request.cookie,
			false,
			`Ambient resource cookie: ${request.path}`,
		);
	}
	for (const request of requests.filter((request) =>
		request.path.startsWith('/auth/passkey/'),
	)) {
		assert(request.bearer, `Missing management bearer: ${request.path}`);
		assert.equal(request.principal, alice.id);
		assert.equal(
			request.cookie,
			[
				'/auth/passkey/generate-register-options',
				'/auth/passkey/verify-registration',
			].includes(request.path),
		);
	}
	const malformed = await page.evaluate(async (principal) => {
		const response = await fetch('/auth/passkey/generate-register-options', {
			credentials: 'include',
			headers: {
				authorization: 'Bearer malformed',
				'x-epicenter-principal': principal,
			},
		});
		return response.status;
	}, bob.id);
	assert.equal(
		malformed,
		401,
		'Bob cookie must not rescue malformed explicit bearer',
	);
	assert.equal(db.passkey.length, 1);
	assert.deepEqual(pageErrors, []);
	console.log(
		`PASS Chromium ${browser.version()}: built hosted sign-in, independent dashboard session, callback routing, cookie-independent profile/resources, virtual passkey registration and rename bound to Alice despite Bob's cookie.`,
	);
} finally {
	await browser?.close();
	await server.stop(true);
}
