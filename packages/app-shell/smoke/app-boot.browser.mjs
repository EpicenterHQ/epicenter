/**
 * A real Svelte AppBoot cannot expose navigation while a UI producer or durable
 * commit is held. Covers account-backed and signed-out local sessions, then
 * verifies sign-out and fixed-server sign-in run only after closure.
 * Destroying unresolved opening must close the eventual App without mounting UI.
 * Run: bun packages/app-shell/smoke/app-boot.browser.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { observeBoot } from './observe-boot.mjs';

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
	plugins: [observeBoot(), svelte({ configFile: false })],
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
					await page.getByRole('button', { name: 'Leave session' }).count(),
					0,
				);
				await page.evaluate(() => window.bootProbe.releaseOpening());
				await page
					.getByRole('button', { name: 'Leave session' })
					.waitFor()
					.catch(async (error) => {
						console.error(await page.locator('body').innerText(), errors);
						throw error;
					});
			} else {
				await page.getByRole('button', { name: 'Reload' }).waitFor();
				assert.equal(
					await page.getByRole('button', { name: 'Leave session' }).count(),
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
			await page.evaluate(() => {
				window.bootProbe.refuse = true;
				return window.destroyBoot();
			});
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
			assert(!events.includes('producer-stop'));
			assert.deepEqual(errors, []);
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: unresolved opening closes after unmount.`,
			);
		}
		{
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			await page.goto(`${origin}?local`);
			await page.getByRole('button', { name: 'Leave session' }).waitFor();
			await page.evaluate(() => {
				window.bootProbe.refuse = true;
				return window.destroyBoot();
			});
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('producer-stop'),
			);
			assert.equal(
				await page.evaluate(() => window.bootProbe.events.includes('closed')),
				false,
			);
			await page.evaluate(() => {
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
			});
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('closed'),
			);
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: mounted producer drains after unmount.`,
			);
		}

		{
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			await page.goto(`${origin}?local&opening=held`);
			await page.getByText('Opening your changes…').waitFor();
			await page.evaluate(() => {
				window.bootProbe.refuse = true;
				window.observedBoot.lifetime.close().catch((error) => {
					window.closeRefusal = error.message;
				});
				window.bootProbe.releaseOpening();
			});
			await page.waitForFunction(
				() => window.closeRefusal === 'Stop recording first.',
			);
			assert(
				await page.getByRole('button', { name: 'Leave session' }).isVisible(),
			);
			assert.equal(
				await page.evaluate(() =>
					window.bootProbe.events.includes('producer-stop'),
				),
				false,
			);
			await page.evaluate(async () => {
				window.bootProbe.refuse = false;
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
				const input = document.createElement('input');
				input.addEventListener('blur', () => {
					window.bootProbe.events.push('focused-edit-committed');
				});
				document.body.append(input);
				input.focus();
				await window.observedBoot.lifetime.close();
			});
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(events.includes('focused-edit-committed'));
			assert(
				events.indexOf('focused-edit-committed') < events.indexOf('producer-stop'),
			);
			assert(
				await page.evaluate(() => window.bootProbe.events.includes('closed')),
			);
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: close during opening awaits mounted preflight.`,
			);
		}

		for (const forced of ['account', 'unmount']) {
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(origin);
			await page.getByRole('button', { name: 'Leave session' }).waitFor();
			await page.evaluate(() => {
				window.bootProbe.holdConfirmation = true;
				window.observedBoot.lifetime
					.go(() => {
						window.bootProbe.events.push('auth-action');
					})
					.catch(() => {
						window.bootProbe.events.push('action-refused');
					});
			});
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('preflight'),
			);
			await page.evaluate(async (forced) => {
				if (forced === 'unmount') await window.destroyBoot();
				else {
					const { auth } = await import('/application.ts');
					const result = await auth.signOut();
					if (result.error) throw result.error;
				}
			}, forced);
			await page.waitForFunction(() =>
				window.bootProbe.events.includes('producer-stop'),
			);
			assert.equal(
				await page.evaluate(() => window.bootProbe.events.includes('closed')),
				false,
			);
			await page.evaluate(() => {
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
			});
			await page.waitForFunction(
				() =>
					window.bootProbe.events.includes('closed') &&
					window.bootProbe.events.includes('action-refused'),
			);
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(!events.includes('auth-action'));
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			// A late confirmation must not blur an input in the replacement UI.
			await page.evaluate(async () => {
				const input = document.createElement('input');
				input.id = 'replacement-input';
				document.body.append(input);
				input.focus();
				window.bootProbe.releaseConfirmation();
				await window.bootProbe.confirmation;
			});
			assert.equal(
				await page.evaluate(() => document.activeElement?.id),
				'replacement-input',
			);
			assert.deepEqual(errors, []);
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: ${forced} interrupts unanswered confirmation and drains registered work.`,
			);
		}
		{
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			const duplicate = new Promise((resolve) =>
				page.on('pageerror', (error) => {
					if (error.message.includes('already has a cleanup owner')) resolve();
				}),
			);
			await page.goto(`${origin}?local&duplicate`);
			await duplicate;
			await page.close();
			console.log(
				`AppBoot ${engine.name()}: duplicate cleanup ownership refuses initialization.`,
			);
		}

		{
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			await page.goto(`${origin}?reauth`);
			await page.getByRole('button', { name: 'Leave session' }).waitFor();
			assert.equal(await page.evaluate(async () => {
				const { auth } = await import('/application.ts');
				await auth.getState().account.fetch('/refuse');
				return auth.getState().status;
			}), 'reauth-required');
			await page.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click();
			await page.getByText('Closing your changes…').waitFor();
			assert.equal(new URL(page.url()).search, '?reauth');
			await page.evaluate(() => window.bootProbe.releaseProducer());
			await page.waitForFunction(() => window.bootProbe.events.includes('producer-done'));
			assert.equal(new URL(page.url()).search, '?reauth');
			await page.evaluate(() => window.bootProbe.releaseCommit());
			await page.getByText('Sign in to open your changes.').waitFor();
			assert.equal(new URL(page.url()).search, '?connect');
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			assert(events.indexOf('closed') > events.indexOf('commit-end'));
			assert(!events.includes('signed-out'));
			await page.close();
			console.log(`AppBoot ${engine.name()}: browser reauthentication awaits producer shutdown and durable close.`);
		}

		for (const local of [false, true]) {
			const page = await browser.newPage();
			page.setDefaultTimeout(10_000);
			page.setDefaultNavigationTimeout(10_000);
			const errors = [];
			page.on('pageerror', (error) => errors.push(error.message));
			await page.goto(origin + (local ? '?local' : ''));
			await page
				.getByRole('button', { name: 'Leave session' })
				.waitFor()
				.catch(async (error) => {
					console.error(await page.locator('body').innerText(), errors);
					throw error;
				});
			await page.evaluate(() => {
				window.bootProbe.refuse = true;
			});
			await page.getByRole('button', { name: 'Leave session' }).click();
			await page
				.getByRole('alert')
				.filter({ hasText: 'Stop recording first.' })
				.waitFor();
			assert.equal(
				await page.getByRole('button', { name: 'Leave session' }).count(),
				1,
			);
			assert.equal(await page.getByLabel('Server URL').count(), 0);
			await page.evaluate(() => {
				window.bootProbe.refuse = false;
			});
			await page.getByRole('button', { name: 'Leave session' }).click();
			await page.getByText('Closing your changes…').waitFor();
			assert.equal(await page.getByLabel('Server URL').count(), 0);
			assert.equal(
				await page
					.getByRole('button', { name: 'Sign in to your server' })
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
			await page.getByText('Sign in to open your changes.').waitFor();
			const events = await page.evaluate(() => window.bootProbe.events);
			assert(events.includes('session-destroyed'));
			assert(
				events.indexOf('producer-done') > events.indexOf('session-destroyed'),
			);
			assert(events.indexOf('closed') > events.indexOf('producer-done'));
			assert(events.indexOf('closed') > events.indexOf('commit-end'));
			if (!local) {
				assert(events.indexOf('signed-out') > events.indexOf('closed'));
			}
			assert.equal(
				await page.evaluate(() =>
					localStorage.getItem('probe.auth.persisted:https://old.example'),
				),
				null,
			);
			await page.getByRole('button', { name: 'Back to Probe' }).click();
			await page
				.getByRole('button', { name: 'Leave session' })
				.waitFor()
				.catch(async (error) => {
					console.error(await page.locator('body').innerText(), errors);
					throw error;
				});
			await page.evaluate(() => {
				window.bootProbe.releaseProducer();
				window.bootProbe.releaseCommit();
			});
			await page.getByRole('button', { name: 'Leave session' }).click();
			await page.getByText('Sign in to open your changes.').waitFor();
			await page.route('https://old.example/sign-in**', (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: '<p>Configured issuer</p>',
				}),
			);
			await Promise.all([
				page.waitForURL('https://old.example/sign-in**'),
				page
					.getByRole('button', { name: 'Sign in to your server', exact: true })
					.click(),
			]);
			const destination = new URL(page.url());
			assert.equal(destination.origin, 'https://old.example');
			assert.equal(
				destination.searchParams.get('callback'),
				new URL('/auth/callback', origin).href,
			);
			assert.equal(destination.searchParams.get('challenge').length, 43);
			assert.equal(destination.searchParams.has('token'), false);
			await page.getByText('Configured issuer', { exact: true }).waitFor();
			assert.deepEqual(errors, []);
			await page.close();
		}
		console.log(
			'AppBoot: account and local sessions await producer shutdown and durable close before sign-out and fixed-server sign-in.',
		);
	} finally {
		await browser.close();
	}
} finally {
	server.httpServer?.closeAllConnections();
	await server.close();
}
