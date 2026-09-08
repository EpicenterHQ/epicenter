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

	// A client-side route change disposes the page, not the captured Account.
	// An injected ordinary link exercises SvelteKit's real navigation handler.
	async function navigateWithinDashboard(path) {
		await page.waitForLoadState('load');
		await page
			.getByRole('button', {
				name:
					new URL(page.url()).pathname === '/dashboard'
						? 'Manage billing'
						: 'Add a passkey',
				exact: true,
			})
			.waitFor();
		const marker = await page.evaluate((path) => {
			window.dashboardSmokeDocument ??= crypto.randomUUID();
			const link = document.createElement('a');
			link.href = path;
			document.body.append(link);
			link.click();
			link.remove();
			return window.dashboardSmokeDocument;
		}, path);
		await page.waitForURL(`${origin}${path}`);
		await page
			.getByRole('button', {
				name: path === '/dashboard' ? 'Manage billing' : 'Add a passkey',
				exact: true,
			})
			.waitFor();
		assert.equal(
			await page.evaluate(() => window.dashboardSmokeDocument),
			marker,
			`Expected SPA navigation to ${path}`,
		);
	}

	for (const ceremony of ['portal', 'provider']) {
		const source = ceremony === 'portal' ? '/dashboard' : '/dashboard/account';
		const other = ceremony === 'portal' ? '/dashboard/account' : '/dashboard';
		const endpoint =
			ceremony === 'portal' ? '/api/billing/portal' : '/auth/link-social';
		await navigateWithinDashboard(source);
		for (const leavePage of [true, false]) {
			const entered = page.waitForRequest(`${origin}${endpoint}`);
			const release = Promise.withResolvers();
			const destination = `${origin}/dashboard?smoke=${ceremony}`;
			const handler = async (route) => {
				await release.promise;
				await route.fulfill({
					json:
						ceremony === 'portal'
							? { portalUrl: destination }
							: { url: destination },
				});
			};
			await page.route(`${origin}${endpoint}`, handler);
			const response = page.waitForResponse(`${origin}${endpoint}`);
			try {
				if (ceremony === 'portal') {
					await page
						.getByRole('button', { name: 'Manage billing', exact: true })
						.click();
				} else {
					await page
						.getByRole('button', { name: 'Connect Google', exact: true })
						.click();
					await page
						.getByRole('button', { name: 'Connect', exact: true })
						.click();
				}
				const request = await entered;
				assert.equal(
					request.headers().authorization,
					`Bearer ${persisted.token}`,
				);
				if (ceremony === 'provider')
					assert.equal(request.headers()['x-epicenter-principal'], alice.id);
				if (leavePage) await navigateWithinDashboard(other);
				release.resolve();
				await (await response).finished();
				if (leavePage) {
					// Allow the response continuation and navigation task to run.
					await page.waitForTimeout(200);
					assert.equal(
						page.url(),
						`${origin}${other}`,
						`${ceremony} redirected after page disposal`,
					);
					await navigateWithinDashboard(source);
				} else {
					await page.waitForURL(destination);
					await page
						.getByRole('button', { name: 'Manage billing', exact: true })
						.waitFor();
				}
			} finally {
				release.resolve();
				await page.unroute(`${origin}${endpoint}`, handler);
			}
		}
	}

	await navigateWithinDashboard('/dashboard/account');
	// A confirmation belongs to the page that opened it, not a later remount.
	await page.getByTitle('Remove passkey').click();
	await navigateWithinDashboard('/dashboard');
	await navigateWithinDashboard('/dashboard/account');
	assert.equal(await page.getByRole('alertdialog').count(), 0);

	for (const status of [200, 403]) {
		const endpoint = `${origin}/auth/passkey/delete-passkey`;
		const release = Promise.withResolvers();
		const handler = async (route) => {
			await release.promise;
			await route.fulfill({
				status,
				json:
					status === 200
						? { status: true }
						: { message: 'Late passkey refusal' },
			});
		};
		await page.route(endpoint, handler);
		const entered = page.waitForRequest(endpoint);
		const response = page.waitForResponse(endpoint);
		try {
			await page.getByTitle('Remove passkey').click();
			await page.getByRole('button', { name: 'Remove', exact: true }).click();
			await entered;
			await navigateWithinDashboard('/dashboard');
			release.resolve();
			await (await response).finished();
			await page.waitForTimeout(200);
			assert.equal(
				await page.getByText('Passkey removed', { exact: true }).count(),
				0,
			);
			assert.equal(
				await page
					.getByText('Sign in again to change your sign-in methods.', {
						exact: true,
					})
					.count(),
				0,
			);
			await navigateWithinDashboard('/dashboard/account');
			assert.equal(await page.getByRole('alertdialog').count(), 0);
		} finally {
			release.resolve();
			await page.unroute(endpoint, handler);
		}
	}

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

	// Deletion retires the page during sign-out. Its late completion must not
	// replace a route chosen while the bounded revocation attempt is pending.
	const signOutEndpoint = `${origin}/auth/sign-out`;
	const releaseSignOut = Promise.withResolvers();
	const signOutHandler = async (route) => {
		await releaseSignOut.promise;
		await route.fulfill({ json: { success: true } });
	};
	await page.route(`${origin}/api/account`, (route) =>
		route.fulfill({ status: 204 }),
	);
	await page.route(signOutEndpoint, signOutHandler);
	const signingOut = page.waitForRequest(signOutEndpoint);
	const signedOut = page.waitForResponse(signOutEndpoint);
	try {
		await page
			.getByRole('button', { name: 'Delete account', exact: true })
			.click();
		await page
			.getByRole('button', { name: 'Delete forever', exact: true })
			.click();
		await signingOut;
		await page
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.waitFor();
		await page.evaluate(() => {
			const link = document.createElement('a');
			link.href = '/sign-in';
			document.body.append(link);
			link.click();
			link.remove();
		});
		await page.waitForURL(`${origin}/sign-in`);
		releaseSignOut.resolve();
		await signedOut;
		// The auth runtime cancels the response body, so response.finished() is
		// not a completion signal here. Cover its entire five-second deadline.
		await page.waitForTimeout(5_200);
		assert.equal(
			page.url(),
			`${origin}/sign-in`,
			'Disposed deletion callback redirected after sign-out',
		);
	} finally {
		releaseSignOut.resolve();
		await page.unroute(signOutEndpoint, signOutHandler);
		await page.unroute(`${origin}/api/account`);
	}
	assert.deepEqual(pageErrors, []);
	console.log(
		`PASS Chromium ${browser.version()}: built hosted sign-in, independent dashboard session, callback routing, cookie-independent profile/resources, virtual passkey registration and rename bound to Alice despite Bob's cookie; disposed pages suppress portal/provider redirects, passkey feedback, stale dialogs, and post-sign-out navigation; live pages retain redirects.`,
	);
} finally {
	await browser?.close();
	await server.stop(true);
}
