/**
 * A real Svelte AppBoot cannot expose navigation while a UI producer or durable
 * commit is held. Covers account-backed and signed-out local sessions, then
 * verifies the actual browser credential selection reloads only after closure.
 * Run: bun packages/app-shell/smoke/app-boot.browser.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./app-boot', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appRequire = createRequire(
	new URL('../../../apps/honeycrisp/package.json', import.meta.url),
);
const dataRequire = createRequire(
	new URL('../../data/package.json', import.meta.url),
);
const { createServer } = await import(appRequire.resolve('vite'));
const { svelte } = await import(
	appRequire.resolve('@sveltejs/vite-plugin-svelte')
);
const { chromium, webkit } = dataRequire('playwright');
const server = await createServer({
	configFile: false,
	root: fixture,
	plugins: [svelte({ configFile: false })],
	resolve: { dedupe: ['svelte'] },
	server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } },
});
await server.listen();
const origin = server.resolvedUrls.local[0];
for (const engine of [chromium, webkit]) {
	const browser = await engine.launch({ headless: true });
	try {
		for (const local of [false, true]) {
			const page = await browser.newPage();
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(origin + (local ? '?local' : ''));
			await page.getByRole('button', { name: 'Choose connection' }).waitFor();
			await page.evaluate(() => {
				window.bootProbe.refuse = true;
			});
			await page.getByRole('button', { name: 'Choose connection' }).click();
			await page
				.getByRole('alert')
				.filter({ hasText: 'Stop recording first.' })
				.waitFor();
			assert.equal(
				await page.getByRole('button', { name: 'Choose connection' }).count(),
				1,
			);
			assert.equal(await page.getByLabel('Server URL').count(), 0);
			await page.evaluate(() => {
				window.bootProbe.refuse = false;
			});
			await page.getByRole('button', { name: 'Choose connection' }).click();
			await page.getByText('Closing your changes…').waitFor();
			assert.equal(await page.getByLabel('Server URL').count(), 0);
			assert.equal(
				await page
					.getByRole('button', { name: 'Sign in with Epicenter' })
					.count(),
				0,
			);
			await page.evaluate(() => window.bootProbe.releaseProducer());
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('producer-done'),
			);
			assert.equal(await page.getByLabel('Server URL').count(), 0);
			assert.equal(
				await page.evaluate(() => window.bootProbe.events.includes('closed')),
				false,
			);
			await page.evaluate(() => window.bootProbe.releaseCommit());
			await page.getByText('Choose where to connect.').waitFor();
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			assert(events.indexOf('closed') > events.indexOf('commit-end'));
			assert(!events.includes('candidate-verified'));
			await page.getByRole('button', { name: 'Back to Probe' }).click();
			await page.getByRole('button', { name: 'Choose connection' }).waitFor();
			await page.evaluate(() => {
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
			});
			await page.getByRole('button', { name: 'Choose connection' }).click();
			await page.getByText('Choose where to connect.').waitFor();
			if (local)
				await page.getByText('Connect to your server', { exact: true }).click();
			else
				await page.getByRole('button', { name: 'Change server', exact: true }).click();
			await page.getByLabel('Server URL').fill('https://next.example');
			await page.evaluate(() => {
				const original = Storage.prototype.setItem;
				let fail = true;
				Storage.prototype.setItem = function (key, value) {
					if (
						key === 'probe.auth.server' &&
						JSON.parse(value).origin === 'https://next.example' &&
						fail
					) {
						fail = false;
						throw new Error('Disposable selection-write failure');
					}
					return original.call(this, key, value);
				};
			});
			await page.getByRole('button', { name: 'Connect', exact: true }).click();
			await page
				.getByRole('alert')
				.filter({ hasText: 'Could not connect.' })
				.waitFor();
			assert.equal(new URL(page.url()).search, '?connect');
			await Promise.all([
				page.waitForNavigation(),
				page.getByRole('button', { name: 'Connect', exact: true }).click(),
			]);
			assert.equal(
				await page.evaluate(() => JSON.parse(localStorage.getItem('probe.auth.server')).origin),
				'https://next.example',
			);
			assert.deepEqual(errors, []);
			await page.close();
		}
		console.log(
			'AppBoot: account and local sessions await producer shutdown and durable close before connection/reload.',
		);
	} finally {
		await browser.close();
	}
}
server.httpServer?.closeAllConnections();
await server.close();
