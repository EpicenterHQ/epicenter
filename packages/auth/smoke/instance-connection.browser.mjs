/**
 * Real Honeycrisp connection form against a disposable local self-host Worker.
 * Start `bun dev:honeycrisp:ui` and local Wrangler with matching trusted origin.
 * Run with APP_URL, INSTANCE_URL, and INSTANCE_TOKEN set for those fixtures:
 * bun packages/auth/smoke/instance-connection.browser.mjs
 * Refuses non-local fixtures. Creates a fresh Chromium profile; no saved user
 * credentials, deployed servers, or shared databases are used.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(
	new URL('../../app/package.json', import.meta.url),
)('playwright');
const appURL = process.env.APP_URL ?? 'http://localhost:5175';
const instanceURL = process.env.INSTANCE_URL ?? 'http://localhost:18879';
const token = process.env.INSTANCE_TOKEN;
assert(token, 'Set INSTANCE_TOKEN for the disposable local Worker');
for (const url of [appURL, instanceURL]) {
	assert(
		['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname),
		'Use local fixtures only',
	);
}
const browser = await chromium.launch({ headless: true });
try {
	const page = await browser.newPage();
	const errors = [];
	const requests = [];
	page.on('pageerror', (error) => errors.push(error.message));
	page.on('request', (request) =>
		requests.push({ url: request.url(), headers: request.headers() }),
	);
	await page.goto(appURL);
	await page
		.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
		.waitFor();
	await page.getByText('Connect to your server', { exact: true }).click();
	await page.getByLabel('Server URL').fill(instanceURL);
	await page.getByLabel('Server token').fill('invalid-token');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page
		.getByRole('alert')
		.filter({ hasText: 'Could not connect' })
		.waitFor();
	assert.equal(
		await page.evaluate(() =>
			localStorage.getItem('so.epicenter.honeycrisp.auth.server'),
		),
		null,
	);
	await page.getByLabel('Server token').fill(token);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page.getByText(/Synced/).waitFor({ timeout: 20_000 });
	assert.equal(
		await page.evaluate(() =>
			localStorage.getItem('so.epicenter.honeycrisp.auth.server'),
		),
		new URL(instanceURL).origin,
	);
	assert(
		requests.some(
			(r) =>
				r.url.includes('/api/data/') &&
				r.headers.authorization === `Bearer ${token}`,
		),
	);
	assert(
		requests.every((r) => !r.url.includes(token)),
		'No credential in a request URL',
	);
	await page.getByRole('button', { name: 'Account', exact: true }).click();
	assert.equal(
		await page.getByRole('link', { name: /Manage account/ }).count(),
		0,
	);
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await page.getByLabel('Server token').waitFor();
	assert.equal(
		await page
			.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
			.count(),
		0,
	);
	assert.equal(
		await page.getByLabel('Server URL').inputValue(),
		new URL(instanceURL).origin,
	);
	await page.getByLabel('Server token').fill(token);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page.getByText(/Synced/).waitFor({ timeout: 20_000 });
	await page.getByRole('button', { name: 'Account', exact: true }).click();
	await page
		.getByRole('button', { name: 'Change connection', exact: true })
		.click();
	await page
		.getByRole('button', { name: 'Use Epicenter Cloud', exact: true })
		.click();
	await page
		.getByRole('button', { name: 'Sign in with Epicenter', exact: true })
		.waitFor();
	assert.equal(
		await page.evaluate(() =>
			localStorage.getItem('so.epicenter.honeycrisp.auth.server'),
		),
		null,
	);
	assert.deepEqual(errors, []);
	console.log(
		'PASS: rejected enrollment, verified restart, real store sync, scoped restore, reconnect, hosted restart',
	);
} finally {
	await browser.close();
}
