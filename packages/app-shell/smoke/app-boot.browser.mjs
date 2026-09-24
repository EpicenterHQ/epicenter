/**
 * Real Svelte AppBoot and browser auth: interruption, boot-free recovery,
 * navigation failure, history restoration, and acquisition rollback.
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
const engine = engineName === 'chromium' ? chromium : webkit;
const browser = await engine.launch({
	headless: true,
	...(engineName === 'chromium'
		? { ignoreDefaultArgs: ['--disable-back-forward-cache'] }
		: {}),
});
const events = (page) =>
	page.evaluate(() => JSON.parse(sessionStorage.getItem('events') ?? '[]'));
const claims = async (page) =>
	(await events(page)).filter((event) => event === 'claim').length;
const working = (page) => page.getByRole('button', { name: 'Leave session' });
const stopped = (page) => page.getByRole('button', { name: 'Reopen Probe' });
let current;
let scenario;
const diagnostics = [];
const pageErrors = [];
async function page(query = '') {
	const next = await browser.newPage();
	current = next;
	next.setDefaultTimeout(8_000);
	next.setDefaultNavigationTimeout(8_000);
	next.on('pageerror', (error) => {
		pageErrors.push(error.message);
		diagnostics.push(`error: ${error.message}`);
	});
	next.on('console', (message) => {
		if (message.type() === 'error') diagnostics.push(message.text());
	});
	next.on('framenavigated', (frame) =>
		diagnostics.push(`navigation: ${frame.url()}`),
	);
	await next.goto(origin + query);
	return next;
}
async function accept(page) {
	await working(page).click();
	await page.getByRole('alertdialog').waitFor();
	await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
async function done(page, name) {
	assert.deepEqual(pageErrors, [], 'No unhandled page errors');
	await page.context().close();
	current = undefined;
	console.log(`AppBoot ${engineName}: ${name}`);
}
try {
	scenario = 'direct recovery opens no App';
	{
		const next = await page('?local&stopped');
		await stopped(next).waitFor();
		assert.equal(await claims(next), 0);
		assert.equal(
			await next.evaluate(() => window.observedBoot.opening),
			undefined,
		);
		await stopped(next).click();
		await working(next).waitFor();
		assert.equal(await claims(next), 1);
		assert(!new URL(next.url()).searchParams.has('stopped'));
		await done(next, scenario);
	}
	for (const local of [true, false]) {
		scenario = `${local ? 'local connect' : 'sign-out'} warning cancels without interrupting, then acceptance ignores pending work`;
		const next = await page(local ? '?local' : '');
		await working(next).waitFor();
		await next.getByLabel('Draft').fill('focused edit');
		await working(next).click();
		await next.getByRole('button', { name: 'Cancel', exact: true }).click();
		assert(await working(next).isVisible());
		assert.equal(await claims(next), 1);
		assert(!(await events(next)).includes('session-destroyed'));
		await accept(next);
		await next
			.getByText('Sign in to open your changes.', { exact: true })
			.waitFor();
		assert.equal(
			new URL(next.url()).pathname,
			local ? '/apps/probe/sign-in' : '/apps/probe/signed-out',
		);
		const observed = await events(next);
		assert(observed.includes('focused-edit-committed'));
		assert(observed.includes('session-destroyed'));
		assert(!observed.includes('commit-end'));
		assert(!observed.includes('producer-finished'));
		assert(!observed.includes('draft-beforeunload'));
		assert.equal(await claims(next), 1);
		await done(next, scenario);
	}
	scenario =
		'deliberate sign-out waits for auth despite synchronous retirement';
	{
		const next = await page('?hold-signout');
		await working(next).waitFor();
		await accept(next);
		await stopped(next).waitFor();
		await next.waitForFunction(() =>
			window.bootProbe?.events.includes('sign-out-started'),
		);
		assert(new URL(next.url()).searchParams.has('signout'));
		assert.equal(await working(next).count(), 0);
		assert.equal(await claims(next), 1);
		assert(!(await events(next)).includes('signed-out'));
		assert(await stopped(next).isDisabled());
		await next.evaluate(() => window.bootProbe.releaseSignOut());
		await next.waitForURL('**/apps/probe/signed-out?connect');
		assert((await events(next)).includes('signed-out'));
		assert.equal(await claims(next), 1);
		await done(next, scenario);
	}
	scenario =
		'desktop sign-out supersedes pending sign-in without navigating the document';
	{
		const next = await page('?desktop&hold-signout');
		await working(next).waitFor();
		await next
			.getByRole('button', { name: 'Change account', exact: true })
			.click();
		await next.getByRole('button', { name: 'Continue', exact: true }).click();
		await next.waitForFunction(() =>
			window.bootProbe.events.includes('sign-in-started'),
		);
		assert(await working(next).isVisible());
		await next
			.getByRole('button', { name: 'Change account', exact: true })
			.click();
		assert.equal(await next.getByRole('alertdialog').count(), 0);
		await accept(next);
		await stopped(next).waitFor();
		await next.waitForFunction(
			() =>
				window.bootProbe?.events.includes('sign-out-started') &&
				window.bootProbe.events.includes('sign-in-finished'),
		);
		assert(await stopped(next).isDisabled());
		assert.equal(new URL(next.url()).search, '?desktop&hold-signout');
		await next.evaluate(() => window.bootProbe.releaseSignOut());
		await next.waitForFunction(() =>
			window.bootProbe.events.includes('sign-out-action-finished'),
		);
		assert.equal(new URL(next.url()).search, '?desktop&hold-signout');
		assert.equal(await working(next).count(), 0);
		assert.equal(await claims(next), 1);
		await done(next, scenario);
	}
	scenario =
		'AccountPopover sign-out failure reaches the root toast after its own unmount';
	{
		const next = await page('?desktop&fail-signout&hold-signout');
		await working(next).waitFor();
		await next.getByRole('button', { name: 'Account', exact: true }).click();
		await next.getByRole('button', { name: 'Sign out', exact: true }).click();
		await next.getByRole('button', { name: 'Continue', exact: true }).click();
		await stopped(next).waitFor();
		await next.waitForFunction(() =>
			window.bootProbe?.events.includes('sign-out-started'),
		);
		assert.equal(
			await next.getByRole('button', { name: 'Account', exact: true }).count(),
			0,
		);
		assert.equal(await working(next).count(), 0);
		await next.evaluate(() => window.bootProbe.releaseSignOut());
		await next.getByText('Failed to sign out', { exact: true }).waitFor();
		assert(await stopped(next).isVisible());
		assert.equal(await claims(next), 1);
		assert.equal(
			new URL(next.url()).search,
			'?desktop&fail-signout&hold-signout',
		);
		await done(next, scenario);
	}
	scenario = 'unmount during held sign-out prevents late navigation';
	{
		const next = await page('?hold-signout');
		await working(next).waitFor();
		await accept(next);
		await next.waitForFunction(() =>
			window.bootProbe?.events.includes('sign-out-started'),
		);
		await next.evaluate(() => window.destroyBoot());
		await next.evaluate(() => window.bootProbe.releaseSignOut());
		await next.waitForFunction(() =>
			window.bootProbe.events.includes('signed-out'),
		);
		assert(new URL(next.url()).searchParams.has('signout'));
		assert.equal(await next.locator('#app').innerHTML(), '');
		assert.equal(await claims(next), 1);
		await done(next, scenario);
	}
	scenario =
		'unexpected retirement removes dirty-draft veto and recovery acquires no App';
	{
		const next = await page();
		await working(next).waitFor();
		await next.getByLabel('Draft').fill('unsaved explicit draft');
		await next.evaluate(() => {
			void import('/application.ts').then(({ auth }) => auth.signOut());
		});
		await next.waitForURL((url) => url.searchParams.has('stopped'));
		await stopped(next).waitFor();
		assert.equal(await claims(next), 1);
		assert.equal(
			await next.evaluate(() => window.observedBoot.opening),
			undefined,
		);
		assert(!(await events(next)).includes('draft-beforeunload'));
		await stopped(next).click();
		await working(next).waitFor();
		assert.equal(await claims(next), 2);
		await done(next, scenario);
	}
	scenario =
		'recovery navigation returning no document leaves original document inert';
	{
		const next = await page();
		await working(next).waitFor();
		await next.evaluate(() => {
			window.originalDocument = 'retained';
		});
		await next.route('**/*', (route) => {
			if (
				route.request().isNavigationRequest() &&
				new URL(route.request().url()).searchParams.has('stopped')
			)
				return route.fulfill({ status: 204 });
			return route.continue();
		});
		await next.evaluate(async () => {
			const { auth } = await import('/application.ts');
			void auth.signOut();
			window.wasInertAtRetirement =
				document.querySelector('#app .contents')?.inert;
		});
		await stopped(next).waitFor();
		assert.equal(
			await next.evaluate(() => window.originalDocument),
			'retained',
		);
		assert.equal(await next.evaluate(() => window.wasInertAtRetirement), true);
		assert.equal(
			await next.evaluate(
				async () => (await window.observedBoot.opening).signal.aborted,
			),
			true,
		);
		assert.equal(await working(next).count(), 0);
		assert.equal(await claims(next), 1);
		assert(!new URL(next.url()).searchParams.has('stopped'));
		await done(next, scenario);
	}
	scenario =
		'persisted pageshow replaces with recovery without acquiring an App';
	{
		const next = await page('?local');
		await working(next).waitFor();
		await next.evaluate(() =>
			dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
		);
		await next.waitForURL((url) => url.searchParams.has('stopped'));
		await stopped(next).waitFor();
		assert.equal(await claims(next), 1);
		assert.equal(
			await next.evaluate(() => window.observedBoot.opening),
			undefined,
		);
		await done(next, scenario);
	}
	scenario = 'actual history back never revives the departed App';
	{
		const next = await page('?local');
		await working(next).waitFor();
		await next.evaluate(() => {
			window.originalDocument = crypto.randomUUID();
			sessionStorage.setItem('original-document', window.originalDocument);
		});
		await accept(next);
		await next.waitForURL('**/apps/probe/sign-in?connect');
		await next.goBack();
		await next.waitForFunction(
			() => document.querySelector('button')?.textContent,
		);
		const restored = await next.evaluate(
			() =>
				window.originalDocument === sessionStorage.getItem('original-document'),
		);
		await stopped(next).waitFor();
		assert(new URL(next.url()).searchParams.has('stopped'));
		assert.equal(await claims(next), 1);
		assert.equal(
			await next.evaluate(() => window.observedBoot.opening),
			undefined,
		);
		console.log(
			`AppBoot ${engineName}: history returned by ${restored ? 'BFCache' : 'fresh document'}; pageshow events ${(await events(next)).filter((event) => event.startsWith('pageshow:')).join(', ')}`,
		);
		await done(next, scenario);
	}
	scenario = 'unmount while opening retains page roots without mounting UI';
	{
		const next = await page('?local&opening=held');
		await next.getByText('Opening your changes…').waitFor();
		await next.evaluate(() => window.destroyBoot());
		assert.equal(await next.locator('#app').innerHTML(), '');
		await next.evaluate(() => window.bootProbe.releaseOpening());
		await next.evaluate(() => window.observedBoot.opening);
		assert(!(await events(next)).includes('closed'));
		assert(!(await events(next)).includes('session-mounted'));
		await done(next, scenario);
	}
	scenario = 'failed acquisition shows reload without working UI';
	{
		const next = await page('?local&opening=failed');
		await next.getByRole('button', { name: 'Reload', exact: true }).waitFor();
		assert.equal(await working(next).count(), 0);
		await done(next, scenario);
	}
} catch (error) {
	console.error(`AppBoot ${engineName}: ${scenario}`, diagnostics.slice(-30));
	if (current)
		console.error(
			await current
				.locator('body')
				.innerText()
				.catch(() => 'document unavailable'),
		);
	throw error;
} finally {
	await browser.close();
	await server.close();
}
