/**
 * A real Svelte AppBoot cannot expose navigation while a UI producer or durable
 * commit is held. Covers account-backed and signed-out local sessions, then
 * verifies the actual browser credential selection reloads only after closure.
 * Destroying unresolved opening must close the eventual App without mounting UI.
 * Run: bun packages/app-shell/smoke/app-boot.browser.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Give each engine its own browser and dev-server process. The parent also
// bounds protocol calls such as browser.close, which can outlive page timeouts.
const engineName = process.env.APP_BOOT_BROWSER;
if (!engineName) {
	for (const name of ['chromium', 'webkit']) {
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
				env: { ...process.env, APP_BOOT_BROWSER: name },
				stdio: 'inherit',
				detached: process.platform !== 'win32',
			});
			const timeout = setTimeout(() => {
				if (child.pid) {
					if (process.platform === 'win32') child.kill('SIGKILL');
					else process.kill(-child.pid, 'SIGKILL');
				}
				reject(
					new Error(
						`AppBoot ${name} exceeded 60 seconds; its process tree was stopped.`,
					),
				);
			}, 60_000);
			child.once('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once('exit', (code, signal) => {
				clearTimeout(timeout);
				if (code === 0) resolve();
				else
					reject(new Error(`AppBoot ${name} exited with ${signal ?? code}.`));
			});
		});
	}
	process.exit(0);
}
assert(
	['chromium', 'webkit'].includes(engineName),
	'Unknown AppBoot browser engine',
);

const fixture = fileURLToPath(new URL('./app-boot', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appRequire = createRequire(
	new URL('../../../apps/honeycrisp/package.json', import.meta.url),
);
const dataRequire = createRequire(
	new URL('../../app/package.json', import.meta.url),
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
	server: {
		host: '127.0.0.1',
		port: 0,
		watch: null,
		hmr: false,
		fs: { allow: [repo] },
	},
});
await server.listen();
const origin = server.resolvedUrls.local[0];
try {
	const engine = engineName === 'chromium' ? chromium : webkit;
	const browser = await engine.launch({ headless: true });
	try {
		for (const opening of ['held', 'failed']) {
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			page.setDefaultNavigationTimeout(10_000);
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(`${origin}?local&opening=${opening}`);
			if (opening === 'held') {
				await page.getByText('Opening your changes…').waitFor();
				assert.equal(
					await page.getByRole('button', { name: 'Choose connection' }).count(),
					0,
				);
				await page.evaluate(() => window.bootProbe.releaseOpening());
				await page.getByRole('button', { name: 'Choose connection' }).waitFor();
			} else {
				await page.getByRole('button', { name: 'Reload' }).waitFor();
				assert.equal(
					await page.getByRole('button', { name: 'Choose connection' }).count(),
					0,
				);
				await Promise.all([
					page.waitForNavigation(),
					page.getByRole('button', { name: 'Reload' }).click(),
				]);
				await page.getByRole('button', { name: 'Reload' }).waitFor();
			}
			assert.deepEqual(errors, []);
			await page.close();
			console.log(`AppBoot ${engine.name()}: ${opening} readiness verified.`);
		}
		{
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(`${origin}?local&opening=held`);
			await page.getByText('Opening your changes…').waitFor();
			await page.evaluate(() => window.destroyBoot());
			assert.equal(await page.locator('#app').innerHTML(), '');
			assert.equal(
				await page.evaluate(() => window.bootProbe.events.includes('closed')),
				false,
			);
			await page.evaluate(() => {
				window.bootProbe.releaseOpening();
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
			});
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('closed'),
			);
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(!events.includes('session-mounted'));
			assert(events.includes('producer-done'));
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			assert(events.indexOf('closed') > events.indexOf('commit-end'));
			assert.deepEqual(errors, []);
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: unresolved opening closes after unmount.`,
			);
		}
		for (const local of [false, true]) {
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			page.setDefaultNavigationTimeout(10_000);
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
			assert(events.includes('session-destroyed'));
			assert(
				events.indexOf('producer-done') > events.indexOf('session-destroyed'),
			);
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
				await page
					.getByRole('button', { name: 'Change server', exact: true })
					.click();
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
				await page.evaluate(
					() => JSON.parse(localStorage.getItem('probe.auth.server')).origin,
				),
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
} finally {
	server.httpServer?.closeAllConnections();
	await server.close();
}
