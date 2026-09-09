/**
 * Built dashboard and hosted sign-in smoke with real Chromium/WebAuthn.
 * Run `bun run --cwd apps/api/ui build` first, then
 * `bun packages/auth/smoke/dashboard.browser.mjs` from the repository root.
 * Seeds disposable Better Auth memory state and local billing responses.
 * No provider or production payment calls. DASHBOARD_FIXTURE_ONLY=1 keeps the
 * fixture server open for visual inspection; visit its printed /fixture/login
 * URL, then /dashboard and use the seeded Alice sign-in.
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
import { mountAuthRoutes } from '../../server/src/routes/auth.js';
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
let balanceUnavailable = false;
let remainingCredits = 1_250;
let grantedCredits = 2_000;
let previewUnavailable = false;
const app = new Hono();
let browser;
let popoverFixture;
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
		socialProviders: {
			google: {
				clientId: 'disposable-fixture',
				clientSecret: 'disposable-fixture',
			},
			github: {
				clientId: 'disposable-fixture',
				clientSecret: 'disposable-fixture',
			},
			microsoft: {
				clientId: 'disposable-fixture',
				clientSecret: 'disposable-fixture',
			},
		},
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
	const providerLabels = {
		google: 'Google',
		github: 'GitHub',
		microsoft: 'Microsoft',
	};
	const providerCodes = new Map();
	let providerExchanges = 0;
	for (const provider of context.socialProviders) {
		assert(Object.hasOwn(providerLabels, provider.id));
		provider.createAuthorizationURL = async ({ state }) =>
			new URL(
				`/fixture/provider/${provider.id}?${new URLSearchParams({ state })}`,
				origin,
			);
		provider.validateAuthorizationCode = async ({ code }) => {
			providerExchanges += 1;
			const selected = providerCodes.get(code);
			providerCodes.delete(code);
			assert(
				selected?.provider === provider.id,
				'Provider code must be unused and belong to this provider',
			);
			return { accessToken: `fixture-${selected.identity}` };
		};
		provider.getUserInfo = async ({ accessToken }) => {
			const identity =
				accessToken === 'fixture-alice'
					? alice
					: accessToken === 'fixture-bob'
						? bob
						: null;
			assert(identity, 'Unknown disposable provider identity');
			return {
				user: {
					id: `${provider.id}-${identity.id}`,
					name: identity.name,
					email: identity.email,
					emailVerified: true,
				},
				data: {},
			};
		};
	}
	const hosted = await context.internalAdapter.createSession(alice.id, false);
	const signed = `${hosted.token}.${await makeSignature(hosted.token, secret)}`;
	const shell = () =>
		new Response(Bun.file(`${build}fallback.html`), {
			headers: { 'content-type': 'text/html' },
		});
	if (process.env.ACCOUNT_POPOVER_SMOKE === '1') {
		const { createAccountPopoverFixture } = await import(
			'../../../apps/honeycrisp/smoke/account-popover/fixture.mjs'
		);
		let popoverSession;
		popoverFixture = await createAccountPopoverFixture(async () => {
			popoverSession ??= await context.internalAdapter.createSession(
				alice.id,
				false,
			);
			return {
				baseURL: origin,
				session: {
					token: `${popoverSession.token}.${await makeSignature(popoverSession.token, secret)}`,
					principalId: alice.id,
				},
			};
		});
		const { cors } = createRequire(
			new URL('../../server/package.json', import.meta.url),
		)('hono/cors');
		app.use('*', cors({ origin: popoverFixture.origin, credentials: true }));
	}
	app.use('*', async (c, next) => {
		requests.push({
			path: c.req.path,
			method: c.req.method,
			cookie: c.req.raw.headers.has('cookie'),
			bearer: c.req.raw.headers.has('authorization'),
			principal: c.req.raw.headers.get('x-epicenter-principal'),
		});
		c.set('auth', auth);
		await next();
	});
	app.get(
		'/fixture/login',
		() =>
			new Response('Disposable hosted login', {
				headers: {
					'content-type': 'text/plain',
					'set-cookie': `${context.authCookies.sessionToken.name}=${encodeURIComponent(signed)}; Path=/; HttpOnly; SameSite=Lax`,
				},
			}),
	);
	app.get('/fixture/provider/:provider', (c) => {
		const provider = c.req.param('provider');
		const state = c.req.query('state');
		if (!Object.hasOwn(providerLabels, provider) || !state)
			return c.text('Unknown simulated provider or missing OAuth state.', 400);
		const callback = (identity) => {
			const code = crypto.randomUUID();
			if (identity) providerCodes.set(code, { provider, identity });
			return `/auth/callback/${provider}?${new URLSearchParams({ state, ...(identity ? { code } : { error: 'access_denied' }) }).toString().replaceAll('&', '&amp;')}`;
		};
		return c.html(
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated ${providerLabels[provider]} sign-in</title><main style="max-width:40rem;margin:5rem auto;padding:1.5rem;font:1rem/1.6 system-ui"><h1>Simulated ${providerLabels[provider]} sign-in</h1><p>Local test only. This is not ${providerLabels[provider]}. No real provider is contacted, and no password or provider credentials are requested.</p><p>Choose a disposable account to complete the real Epicenter sign-in callback.</p><p><a href="${callback('alice')}">Continue as Alice (alice@example.test)</a></p><p><a href="${callback('bob')}">Continue as Bob (bob@example.test)</a></p><p><a href="${callback(null)}">Cancel simulated sign-in</a></p></main></html>`,
		);
	});
	mountAuthRoutes(app, {
		setup: async (_c, next) => next(),
		serveAuthUiShell: shell,
	});
	mountSessionApp(app, {
		auth: requireBearerPrincipal(resolveRequestSessionPrincipal),
	});
	// Disposable DTOs exercise the built UI behind the real bearer gate.
	app.use(
		'/api/billing/*',
		requireBearerPrincipal(resolveRequestSessionPrincipal),
	);
	app.get('/api/billing/overview', (c) => {
		if (balanceUnavailable)
			return c.json({ message: 'Balance fixture unavailable' }, 503);
		return c.json({
			planDisplayName: 'Free',
			trial: null,
			credits: {
				remaining: remainingCredits,
				granted: grantedCredits,
				monthlyRemaining: remainingCredits,
				rolloverRemaining: 0,
				nextResetAtMs: Date.now() + 10 * 86_400_000,
			},
			storage: { usedBytes: 0, includedBytes: 1_000_000_000 },
		});
	});
	const plan = (id, displayName, cta, price) => ({
		id,
		displayName,
		cta,
		displayedPrice: price,
		displayedPricePerMonth: price,
		displayedCreditsPerCycle: '2,000 credits/mo',
		displayedOverage: null,
		rollover: false,
		isRecommended: false,
		isTrialing: false,
	});
	app.get('/api/billing/plans', (c) =>
		c.json({
			cards: {
				monthly: [
					plan('free', 'Free', 'Current', '$0/mo'),
					plan('pro', 'Pro', 'Upgrade', '$20/mo'),
				],
				annual: [plan('pro-annual', 'Pro', 'Upgrade', '$16/mo')],
			},
			topUp: { creditsPerPurchase: 1_000, priceUsd: 10 },
		}),
	);
	app.post('/api/billing/usage', (c) =>
		c.json({
			totalCredits: 95,
			totalCalls: 12,
			buckets: [
				{
					periodIso: new Date(Date.now() - 2 * 86_400_000).toISOString(),
					groupedCredits: { 'fixture-small': 10, 'fixture-large': 15 },
				},
				{
					periodIso: new Date(Date.now() - 86_400_000).toISOString(),
					groupedCredits: { 'fixture-small': 30, 'fixture-large': 40 },
				},
			],
		}),
	);
	app.post('/api/billing/events', (c) => c.json({ events: [] }));
	app.post('/api/billing/preview', (c) =>
		previewUnavailable
			? c.json({ message: 'Preview fixture unavailable' }, 503)
			: c.json({ displayedSummary: 'Your new plan costs $20 per month.' }),
	);
	app.post('/api/billing/checkout/top-up', async (c) => {
		const { successUrl } = await c.req.json();
		const returnTo = new URL(successUrl);
		assert.equal(returnTo.origin, origin, 'Fixture checkout must stay local');
		assert.equal(returnTo.pathname, '/dashboard');
		remainingCredits += 1_000;
		grantedCredits += 1_000;
		return c.json({
			checkoutUrl: `${origin}/fixture/checkout?returnTo=${encodeURIComponent(returnTo.href)}`,
		});
	});
	app.get('/fixture/checkout', (c) => {
		const returnTo = new URL(c.req.query('returnTo'));
		assert.equal(returnTo.origin, origin);
		return c.redirect(returnTo.href);
	});
	function fixtureReturnUrl(value) {
		try {
			const url = new URL(value);
			if (url.origin !== origin || url.username || url.password) return null;
			if (
				!['/dashboard', '/dashboard/account', '/dashboard/usage'].includes(
					url.pathname,
				)
			)
				return null;
			return url;
		} catch {
			return null;
		}
	}
	app.get('/api/billing/portal', (c) => {
		const returnTo = fixtureReturnUrl(c.req.query('returnUrl'));
		if (!returnTo)
			return c.text('The fixture requires a local dashboard return URL.', 400);
		return c.json({
			portalUrl: `${origin}/fixture/billing-portal?returnTo=${encodeURIComponent(returnTo.href)}`,
		});
	});
	app.get('/fixture/billing-portal', (c) => {
		const returnTo = fixtureReturnUrl(c.req.query('returnTo'));
		if (!returnTo)
			return c.text('The fixture requires a local dashboard return URL.', 400);
		return c.html(
			`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulated billing portal</title><main style="max-width:40rem;margin:5rem auto;padding:1.5rem;font:1rem/1.6 system-ui"><h1>Simulated billing portal</h1><p>Local test only. No payment provider is connected and no charges can occur.</p><p>The real billing portal manages payment methods and invoices. This fixture only demonstrates leaving the dashboard and returning to the same account.</p><a href="/fixture/billing-portal/return?returnTo=${encodeURIComponent(returnTo.href)}">Return to Epicenter</a></main></html>`,
		);
	});
	app.get('/fixture/billing-portal/return', (c) => {
		const returnTo = fixtureReturnUrl(c.req.query('returnTo'));
		return returnTo
			? c.redirect(returnTo.href)
			: c.text('The fixture requires a local dashboard return URL.', 400);
	});
	app.get('/dashboard', shell);
	app.get('/dashboard/*', shell);
	app.get('/*', async (c) => {
		const path = c.req.path;
		if (!path.startsWith('/_app/') && path !== '/favicon.ico')
			return c.notFound();
		const file = Bun.file(`${build}${path.slice(1)}`);
		return (await file.exists())
			? new Response(file, { headers: { 'content-type': file.type } })
			: c.notFound();
	});
	if (process.env.DASHBOARD_FIXTURE_ONLY === '1') {
		console.log(`Disposable dashboard fixture: ${origin}/fixture/login`);
		if (popoverFixture)
			console.log(
				`Shared account menu fixture: ${popoverFixture.origin}/?locked=1`,
			);
		await new Promise(() => {});
	}

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
	const continuation = `/dashboard/usage?expectedPrincipal=${encodeURIComponent(alice.id)}`;
	await page.goto(`${origin}${continuation}`);
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
	await page.waitForURL(`${origin}${continuation}`);
	assert.equal(db.session.length, 2);
	const persisted = await page.evaluate(() =>
		JSON.parse(localStorage.getItem(`so.epicenter.dashboard.auth.persisted:${location.origin}`)),
	);
	assert.equal(persisted.principalId, alice.id);
	assert(persisted.token && persisted.token !== signed);
	assert.equal(
		await page.evaluate(() =>
			sessionStorage.getItem('epicenter.dashboard.return-to'),
		),
		null,
	);

	// A shared entry point must not show or fetch another account's billing.
	const beforeMismatch = requests.filter((request) =>
		request.path.startsWith('/api/billing/'),
	).length;
	await page.goto(
		`${origin}/dashboard?expectedPrincipal=${encodeURIComponent(bob.id)}`,
	);
	await page
		.getByText('This link is for a different account', { exact: true })
		.waitFor();
	await page.waitForTimeout(200);
	assert.equal(
		requests.filter((request) => request.path.startsWith('/api/billing/'))
			.length,
		beforeMismatch,
	);
	// A failed sign-in handoff retains its guarded destination for retry.
	await page.evaluate((path) => {
		sessionStorage.setItem('epicenter.dashboard.return-to', path);
	}, continuation);
	await page.goto(`${origin}/session/callback`);
	const callbackReturn = page.getByRole('link', {
		name: 'Return to account',
		exact: true,
	});
	await callbackReturn.waitFor();
	assert.equal(await callbackReturn.getAttribute('href'), continuation);
	await callbackReturn.click();
	await page.waitForURL(`${origin}${continuation}`);

	// An explicit retry recovers an unavailable balance without a reload.
	balanceUnavailable = true;
	await page.goto(
		`${origin}/dashboard?expectedPrincipal=${encodeURIComponent(alice.id)}`,
	);
	const retryBalance = page.getByRole('button', {
		name: 'Retry balance',
		exact: true,
	});
	await retryBalance.waitFor();
	balanceUnavailable = false;
	await retryBalance.click();
	await page.getByText('1,250', { exact: true }).waitFor();

	// Returning from another application refreshes the displayed balance.
	remainingCredits = 1_100;
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'hidden',
		});
		document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
		Object.defineProperty(document, 'visibilityState', {
			configurable: true,
			value: 'visible',
		});
		document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
	});
	await page.getByText('1,100', { exact: true }).waitFor();
	// Desktop app switching can restore focus without changing visibility.
	remainingCredits = 1_050;
	await page.evaluate(() => window.dispatchEvent(new Event('focus')));
	await page.getByText('1,050', { exact: true }).waitFor();

	// A failed cost preview must never enable a blind plan purchase.
	previewUnavailable = true;
	await page
		.getByRole('button', { name: 'Upgrade to Pro', exact: true })
		.click();
	await page
		.getByText('Could not preview this plan change.', { exact: true })
		.waitFor();
	assert.equal(
		await page
			.getByRole('button', { name: 'Confirm', exact: true })
			.isDisabled(),
		true,
	);
	assert.equal(
		requests.filter((request) => request.path === '/api/billing/checkout/plan')
			.length,
		0,
	);
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	previewUnavailable = false;

	// Local checkout simulates leaving the website and returning to its credits.
	const checkout = page.waitForRequest(`${origin}/api/billing/checkout/top-up`);
	const purchaseReturn = page.url();
	await page
		.getByRole('button', { name: 'Buy 1,000 credits ($10)', exact: true })
		.click();
	assert.equal((await checkout).postDataJSON().successUrl, purchaseReturn);
	await page.getByText('2,050', { exact: true }).waitFor();
	assert.equal(
		new URL(page.url()).searchParams.get('expectedPrincipal'),
		alice.id,
	);
	const portalReturn = page.url();
	await page
		.getByRole('button', { name: 'Manage billing', exact: true })
		.click();
	await page
		.getByRole('heading', { name: 'Simulated billing portal', exact: true })
		.waitFor();
	await page
		.getByText(
			'Local test only. No payment provider is connected and no charges can occur.',
			{ exact: true },
		)
		.waitFor();
	await page.screenshot({
		path: '/tmp/epicenter-account-simulated-portal.png',
		fullPage: true,
	});
	await page
		.getByRole('link', { name: 'Return to Epicenter', exact: true })
		.click();
	await page.waitForURL(portalReturn);
	await page.getByText('2,050', { exact: true }).waitFor();
	assert.equal(
		(
			await fetch(
				`${origin}/fixture/billing-portal/return?returnTo=${encodeURIComponent('https://example.test/dashboard')}`,
				{ redirect: 'manual' },
			)
		).status,
		400,
	);

	// Theme is a persistent menu preference: toggling must not dismiss its menu.
	const accountMenuTrigger = page.getByRole('button', {
		name: 'Account menu',
		exact: true,
	});
	await accountMenuTrigger.focus();
	await page.keyboard.press('Enter');
	const startedDark = await page
		.locator('html')
		.evaluate((element) => element.classList.contains('dark'));
	for (const dark of [!startedDark, startedDark]) {
		await page
			.getByRole('menuitem', {
				name: dark ? 'Dark mode' : 'Light mode',
				exact: true,
			})
			.click();
		await page
			.getByRole('menuitem', {
				name: dark ? 'Light mode' : 'Dark mode',
				exact: true,
			})
			.waitFor();
		await page.waitForFunction(
			(expectedDark) =>
				document.documentElement.classList.contains('dark') === expectedDark,
			dark,
		);
		assert.equal(
			await page
				.locator('html')
				.evaluate((element) => element.classList.contains('dark')),
			dark,
		);
		await page.waitForTimeout(200);
		await page.screenshot({
			path: `/tmp/epicenter-account-menu-${dark ? 'dark' : 'light'}.png`,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(200);
		for (const element of [accountMenuTrigger, page.getByRole('menu')]) {
			const bounds = await element.boundingBox();
			assert(
				bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390,
				'Account trigger and menu must fit the mobile viewport',
			);
		}
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
			true,
		);
		await page.screenshot({
			path: `/tmp/epicenter-account-menu-mobile-${dark ? 'dark' : 'light'}.png`,
		});
		await page.setViewportSize({ width: 1280, height: 720 });
	}
	await page.keyboard.press('Escape');
	await page.screenshot({
		path: '/tmp/epicenter-account-credits.png',
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: '/tmp/epicenter-account-mobile.png',
		fullPage: true,
	});
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.getByRole('link', { name: 'Usage', exact: true }).click();
	await page
		.getByRole('link', { name: 'Usage', exact: true })
		.and(page.locator('[aria-current="page"]'))
		.waitFor();
	assert.equal(
		await page
			.getByRole('link', { name: 'Credits', exact: true })
			.getAttribute('aria-current'),
		null,
	);
	await page.getByText('Total: 95 credits', { exact: true }).waitFor();
	await page
		.getByRole('row')
		.filter({ hasText: 'fixture-large' })
		.getByRole('cell', { name: '55', exact: true })
		.waitFor();
	await page
		.getByRole('row')
		.filter({ hasText: 'fixture-small' })
		.getByRole('cell', { name: '40', exact: true })
		.waitFor();
	const chartAreas = page.locator('[data-chart] path.lc-area-path');
	await chartAreas.first().waitFor();
	assert.equal(await chartAreas.count(), 2);
	for (const area of await chartAreas.all()) {
		const path = await area.getAttribute('d');
		assert(
			path && !path.includes('NaN'),
			'Each usage series must render finite chart geometry',
		);
	}
	await page.screenshot({
		path: '/tmp/epicenter-account-usage.png',
		fullPage: true,
	});
	await page.locator('[data-chart]').hover({ position: { x: 750, y: 130 } });
	const chartTooltip = page.locator('.cn-chart-tooltip');
	await chartTooltip.getByText('fixture-large', { exact: true }).waitFor();
	await chartTooltip.getByText('fixture-small', { exact: true }).waitFor();
	await chartTooltip.getByText('40', { exact: true }).waitFor();
	await chartTooltip.getByText('30', { exact: true }).waitFor();
	// Let the tooltip's entrance transition finish before recording its appearance.
	await page.waitForTimeout(250);
	await page.screenshot({
		path: '/tmp/epicenter-account-usage-hover.png',
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.locator('[data-chart]').hover({ position: { x: 230, y: 40 } });
	await chartTooltip.waitFor();
	await page.waitForTimeout(250);
	const tooltipBounds = await chartTooltip.boundingBox();
	assert(
		tooltipBounds &&
			tooltipBounds.x >= 0 &&
			tooltipBounds.x + tooltipBounds.width <= 390,
	);
	await page.screenshot({
		path: '/tmp/epicenter-account-usage-hover-mobile.png',
		fullPage: true,
	});
	await page.setViewportSize({ width: 1280, height: 900 });

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
	await page
		.getByRole('main')
		.getByText('alice@example.test', { exact: true })
		.waitFor();
	await page.getByText('No passkeys yet.', { exact: true }).waitFor();
	const connectedAccountsCard = page
		.locator('[data-slot="card"]')
		.filter({ has: page.getByText('Connected accounts', { exact: true }) });
	await connectedAccountsCard
		.getByText('No connected accounts yet.', { exact: true })
		.waitFor();
	assert.equal(await connectedAccountsCard.locator('ul').count(), 0);
	assert.equal(
		await connectedAccountsCard.locator('[data-slot="separator"]').count(),
		0,
	);
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
						? /Manage billing|Opening billing/
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
		const endpointUrl = `${origin}${endpoint}${ceremony === 'portal' ? '?**' : ''}`;
		await navigateWithinDashboard(source);
		for (const leavePage of [true, false]) {
			const entered = page.waitForRequest(endpointUrl);
			const ceremonyReturn = page.url();
			const release = Promise.withResolvers();
			const destination = `${origin}/dashboard?smoke=${ceremony}`;
			let ceremonyRequests = 0;
			const handler = async (route) => {
				ceremonyRequests += 1;
				await release.promise;
				await route.fulfill({
					json:
						ceremony === 'portal'
							? { portalUrl: destination }
							: { url: destination },
				});
			};
			await page.route(endpointUrl, handler);
			const response = page.waitForResponse(endpointUrl);
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
				if (ceremony === 'portal') {
					const pending = page.getByRole('button', { name: /Opening billing/ });
					assert.equal(await pending.isDisabled(), true);
					await pending.evaluate((button) => button.click());
					assert.equal(ceremonyRequests, 1);
				}
				assert.equal(
					request.headers().authorization,
					`Bearer ${persisted.token}`,
				);
				if (ceremony === 'provider')
					assert.equal(request.headers()['x-epicenter-principal'], alice.id);
				else
					assert.equal(
						new URL(request.url()).searchParams.get('returnUrl'),
						ceremonyReturn,
					);
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
				await page.unroute(endpointUrl, handler);
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

	// Account deletion is intentionally unavailable until hosted erasure is complete.
	assert.equal(
		await page
			.getByRole('button', { name: 'Delete account', exact: true })
			.isDisabled(),
		true,
	);
	assert.equal(
		requests.filter((request) => request.path === '/api/account').length,
		0,
	);
	assert.deepEqual(pageErrors, []);
	// Actual provider buttons traverse Better Auth's state/callback/session flow.
	// Only the upstream provider interaction is simulated on the local chooser.
	const exchangesBeforeInvalidState = providerExchanges;
	const invalidState = await fetch(
		`${origin}/auth/callback/google?code=not-issued&state=not-issued`,
		{ redirect: 'manual' },
	);
	assert.equal(invalidState.status, 302);
	assert((invalidState.headers.get('location') ?? '').includes('error='));
	assert.equal(
		providerExchanges,
		exchangesBeforeInvalidState,
		'Better Auth must reject invalid state before provider exchange',
	);
	for (const [provider, label] of Object.entries(providerLabels)) {
		const providerContext = await browser.newContext();
		const providerPage = await providerContext.newPage();
		providerPage.setDefaultTimeout(10_000);
		const providerErrors = [];
		providerPage.on('pageerror', (error) => providerErrors.push(error.message));
		const destination = `${origin}/dashboard/account?expectedPrincipal=${encodeURIComponent(alice.id)}`;
		await providerPage.goto(destination);
		await providerPage
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.click();
		await providerPage
			.getByRole('button', { name: `Continue with ${label}`, exact: true })
			.click();
		await providerPage
			.getByRole('heading', { name: `Simulated ${label} sign-in`, exact: true })
			.waitFor();
		await providerPage.screenshot({
			path: `/tmp/epicenter-simulated-${provider}-sign-in.png`,
			fullPage: true,
		});
		await providerPage
			.getByRole('link', {
				name: 'Continue as Alice (alice@example.test)',
				exact: true,
			})
			.click();
		await providerPage
			.getByRole('button', {
				name: 'Continue as alice@example.test',
				exact: true,
			})
			.click();
		await providerPage.waitForURL(destination);
		await providerPage
			.getByRole('main')
			.getByText('alice@example.test', { exact: true })
			.waitFor();
		assert(
			db.account.some(
				(account) =>
					account.providerId === provider && account.userId === alice.id,
			),
		);
		if (provider === 'google') {
			await providerPage
				.getByRole('button', { name: 'Connect GitHub', exact: true })
				.click();
			await providerPage
				.getByRole('button', { name: 'Connect', exact: true })
				.click();
			await providerPage
				.getByRole('heading', { name: 'Simulated GitHub sign-in', exact: true })
				.waitFor();
			await providerPage
				.getByRole('link', {
					name: 'Continue as Alice (alice@example.test)',
					exact: true,
				})
				.click();
			await providerPage.waitForURL(destination);
			await providerPage
				.getByRole('main')
				.getByText('alice@example.test', { exact: true })
				.waitFor();
			assert(
				db.account.some(
					(account) =>
						account.providerId === 'github' && account.userId === alice.id,
				),
			);
		}
		await providerPage
			.getByRole('button', { name: 'Account menu', exact: true })
			.click();
		await providerPage
			.getByRole('menuitem', { name: 'Sign out', exact: true })
			.click();
		await providerPage
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.click();
		await providerPage
			.getByRole('button', {
				name: 'Continue as alice@example.test',
				exact: true,
			})
			.click();
		await providerPage.waitForURL(destination);
		await providerPage
			.getByRole('main')
			.getByText('alice@example.test', { exact: true })
			.waitFor();
		assert.deepEqual(providerErrors, []);
		await providerContext.close();
	}
	if (popoverFixture) {
		const menuContext = await browser.newContext();
		const source = await menuContext.newPage();
		source.setDefaultTimeout(10_000);
		const menuErrors = [];
		source.on('pageerror', (error) => menuErrors.push(error.message));
		menuContext.on('page', (opened) =>
			opened.on('pageerror', (error) => menuErrors.push(error.message)),
		);
		await source.goto(`${origin}/fixture/login`);
		await source.goto(`${popoverFixture.origin}/?signedOut=1`);
		await source.getByRole('button', { name: 'Account', exact: true }).click();
		assert.equal(
			await source.getByRole('link', { name: /^Manage account/ }).count(),
			0,
		);
		await source.goto(`${popoverFixture.origin}/?locked=1`);
		await source
			.getByRole('textbox', { name: 'Work in progress' })
			.fill('Keep this unfinished note while I manage my account.');
		const documentMarker = await source.evaluate(
			() => (window.accountMenuSmokeDocument = crypto.randomUUID()),
		);
		await source.getByRole('button', { name: 'Account', exact: true }).click();
		assert.equal(
			await source
				.getByRole('button', { name: 'Sign out', exact: true })
				.isDisabled(),
			true,
		);
		await source.getByText('alice@example.test', { exact: true }).waitFor();
		const manage = source.getByRole('link', { name: /^Manage account/ });
		const destination = `${origin}/dashboard/account?expectedPrincipal=${encodeURIComponent(alice.id)}`;
		assert.equal(await manage.getAttribute('href'), destination);
		const opened = menuContext.waitForEvent('page');
		await manage.click();
		const accountPage = await opened;
		accountPage.setDefaultTimeout(10_000);
		await accountPage.waitForURL(destination);
		assert.equal(await accountPage.evaluate(() => window.opener), null);
		await accountPage
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.click();
		await accountPage
			.getByRole('button', {
				name: 'Continue as alice@example.test',
				exact: true,
			})
			.click();
		await accountPage.waitForURL(destination);
		await accountPage
			.getByRole('main')
			.getByText('alice@example.test', { exact: true })
			.waitFor();
		await accountPage.screenshot({
			path: '/tmp/epicenter-account-menu-destination.png',
			fullPage: true,
		});
		assert.equal(
			await source.evaluate(() => window.accountMenuSmokeDocument),
			documentMarker,
		);
		assert.equal(
			await source
				.getByRole('textbox', { name: 'Work in progress' })
				.inputValue(),
			'Keep this unfinished note while I manage my account.',
		);
		assert.equal(source.url(), `${popoverFixture.origin}/?locked=1`);
		await source.screenshot({
			path: '/tmp/epicenter-account-menu-source.png',
			fullPage: true,
		});
		const otherDashboardSession = await context.internalAdapter.createSession(
			bob.id,
			false,
		);
		await accountPage.evaluate(
			(session) =>
				localStorage.setItem(
					`so.epicenter.dashboard.auth.persisted:${location.origin}`,
					JSON.stringify(session),
				),
			{
				token: `${otherDashboardSession.token}.${await makeSignature(otherDashboardSession.token, secret)}`,
				principalId: bob.id,
			},
		);
		await accountPage.reload();
		await accountPage
			.getByText('This link is for a different account', { exact: true })
			.waitFor();
		await accountPage.screenshot({
			path: '/tmp/epicenter-account-menu-mismatch.png',
			fullPage: true,
		});
		assert.equal(
			await source
				.getByRole('textbox', { name: 'Work in progress' })
				.inputValue(),
			'Keep this unfinished note while I manage my account.',
		);
		assert.deepEqual(menuErrors, []);
		await menuContext.close();
		console.log(
			'PASS shared AccountPopover: signed-out absence, recording lock preserves Manage account, independent tab has no opener, real hosted sign-in returns to the captured account, mismatch refused, originating work survives.',
		);
	}
	console.log(
		`PASS Chromium ${browser.version()}: built hosted sign-in, dashboard continuation and identity guard, balance retry and focus refresh, failed preview blocks purchase, disposable checkout returns to credits; independent dashboard session, cookie-independent profile/resources, virtual passkey registration and rename bound to Alice despite Bob's cookie; disposed pages suppress portal/provider redirects, passkey feedback, stale dialogs; live pages retain redirects, and unavailable deletion issues no request.`,
	);
} finally {
	await browser?.close();
	await popoverFixture?.close();
	await server.stop(true);
}
