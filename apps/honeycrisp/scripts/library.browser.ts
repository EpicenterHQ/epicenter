/** Actual Honeycrisp UI against a temporary local Worker. Run with Bun from the repository root. */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import type { PlatformProxy } from 'wrangler';
import {
	type LibraryTestOperator,
	proveRetirement,
} from './library-retirement.js';

// Use the same Wrangler installation as the self-hosted Worker below.
const { getPlatformProxy }: typeof import('wrangler') = createRequire(
	new URL('../../self-host/package.json', import.meta.url),
)('wrangler');
const root = join(import.meta.dir, '../../..');
const directory = mkdtempSync(join(tmpdir(), 'honeycrisp-library-'));
async function reserveOrigin() {
	const reservation = Bun.serve({
		hostname: 'localhost',
		port: 0,
		fetch: () => new Response(),
	});
	const origin = reservation.url.origin;
	await reservation.stop(true);
	return origin;
}
const origin = await reserveOrigin();
const appOrigin = await reserveOrigin();
const issuerEnvironment = {
	API_PUBLIC_ORIGIN: origin,
	SELF_HOST_CALLBACKS: JSON.stringify([`${appOrigin}/auth/callback`]),
	TRUSTED_BROWSER_ORIGINS: appOrigin,
};
const workerName = `application-smoke-${crypto.randomUUID()}`;
const workerConfig = join(directory, 'worker.json');
const operatorConfig = join(directory, 'operator.json');
writeFileSync(
	workerConfig,
	JSON.stringify({
		name: workerName,
		main: join(root, 'apps/honeycrisp/scripts/library.worker.ts'),
		compatibility_date: '2026-03-06',
		compatibility_flags: ['nodejs_compat'],
		send_metrics: false,
		vars: issuerEnvironment,
		durable_objects: {
			bindings: [
				{ name: 'SELF_HOST_AUTH', class_name: 'SelfHostAuthOwner' },
				{ name: 'STORE_AUTHORITY', class_name: 'StoreAuthority' },
				{ name: 'GENERATIONS_LEDGER', class_name: 'GenerationsLedger' },
			],
		},
		migrations: [
			{
				tag: 'smoke',
				new_sqlite_classes: [
					'SelfHostAuthOwner',
					'StoreAuthority',
					'GenerationsLedger',
				],
			},
		],
	}),
);
writeFileSync(
	operatorConfig,
	JSON.stringify({
		name: 'application-smoke-operator',
		compatibility_date: '2026-03-06',
		send_metrics: false,
		services: [
			{
				binding: 'OPERATOR',
				service: workerName,
				entrypoint: 'SelfHostOperator',
				remote: false,
			},
			{
				binding: 'LIBRARY_TEST',
				service: workerName,
				entrypoint: 'LibraryTestOperator',
				remote: false,
			},
		],
	}),
);

const logs: string[] = [];
const children: ChildProcess[] = [];
function start(args: string[], cwd = root) {
	const child = spawn('bun', args, {
		cwd,
		detached: true,
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (d) => {
		logs.push(String(d));
		if (process.env.SMOKE_VERBOSE) process.stdout.write(d);
	});
	child.stderr.on('data', (d) => {
		logs.push(String(d));
		if (process.env.SMOKE_VERBOSE) process.stderr.write(d);
	});
	children.push(child);
	return child;
}
const worker = start(
	[
		'x',
		'--no-install',
		'wrangler',
		'dev',
		'--local',
		'--config',
		workerConfig,
		'--port',
		new URL(origin).port,
		'--inspector-port',
		'0',
		'--persist-to',
		join(directory, 'worker-state'),
	],
	join(root, 'apps/self-host'),
);
// A smoke run keeps one compiled document while other sessions edit the checkout.
// Disabling dev file watching does not replace application or auth behavior.
const viteConfig = join(directory, 'vite.config.mts');
writeFileSync(
	viteConfig,
	`import config from ${JSON.stringify(join(root, 'apps/honeycrisp/vite.config.ts'))};\nexport default { ...config, server: { ...config.server, watch: null, hmr: false } };\n`,
);
const vite = start([
	'dev:honeycrisp:ui',
	'--config',
	viteConfig,
	'--port',
	new URL(appOrigin).port,
	'--strictPort',
]);
async function ready(url: string, child: ChildProcess) {
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {}
		assert.equal(child.exitCode, null, 'Development server exited');
		await Bun.sleep(100);
	}
	throw new Error(`Timed out starting ${url}`);
}
type TestBindings = {
	OPERATOR: {
		admit(input: { id: string; name: string }): Promise<{ url: string }>;
		remove(id: string): Promise<void>;
	};
	LIBRARY_TEST: LibraryTestOperator & { ready(): Promise<boolean> };
};
let browser: Browser | undefined;
let proxy: PlatformProxy<TestBindings> | undefined;
let passed = false;
const pages: Page[] = [];
const errors: string[] = [];
const sharedDownloads: Array<
	Promise<{
		generation: string | undefined;
		position: string | undefined;
		bytes: number[];
	}>
> = [];
async function select(page: Page, name: 'Local' | 'Personal' | 'Shared') {
	await page.evaluate(async () => {
		const path = '/src/lib/application.ts';
		const module: typeof import('../src/lib/application.js') = await import(
			path
		);
		module.departure.onChange(() => {
			if (module.departure.state.phase === 'closed')
				sessionStorage.setItem('closed-library', module.library);
		});
	});
	const previous = await page
		.locator('nav[aria-label="Library"] button[aria-pressed="true"]')
		.innerText();
	await page
		.getByRole('navigation', { name: 'Library' })
		.getByRole('button', { name, exact: true })
		.click();
	await page.waitForFunction(
		(name) => localStorage.getItem('honeycrisp.library') === name,
		name.toLowerCase(),
	);
	await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
	console.log('Selected library', name);
	assert.equal(
		await page.evaluate(() => sessionStorage.getItem('closed-library')),
		previous.toLowerCase(),
	);
	assert.equal(
		await page
			.getByRole('navigation', { name: 'Library' })
			.getByRole('button', { name, exact: true })
			.getAttribute('aria-pressed'),
		'true',
	);
}
async function note(page: Page, text: string) {
	await page.getByRole('button', { name: 'New note', exact: true }).click();
	await page.locator('.ProseMirror').fill(text);
	await page.locator('.ProseMirror').blur();
	await page.getByText(text, { exact: true }).first().waitFor();
}
async function openNote(page: Page, text: string) {
	await page.getByText(text, { exact: true }).first().click();
	await page.locator('.ProseMirror').waitFor();
}
async function enroll(id: string) {
	assert(proxy);
	assert(browser);
	const grant = await proxy.env.OPERATOR.admit({
		id,
		name: id === 'alice' ? 'Alice' : 'Bob',
	});
	console.log('Enrolling', id);
	const context = await browser.newContext();
	const page = await context.newPage();
	pages.push(page);
	page.setDefaultTimeout(30_000);
	// One App opens Personal and Shared together during bootstrap.
	sharedDownloads.push(
		page
			.waitForResponse(
				(response) =>
					response.request().method() === 'POST' &&
					response
						.url()
						.includes('/shared/data/so.epicenter.honeycrisp/current'),
			)
			.then(async (response) => {
				assert.equal(response.status(), 200);
				return {
					generation: response.headers()['epicenter-generation'],
					position: response.headers()['epicenter-log-position'],
					bytes: [...(await response.body())],
				};
			}),
	);
	page.on('pageerror', (error) => errors.push(`${id}: ${error.message}`));
	const cdp = await context.newCDPSession(page);
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
	await page.goto(grant.url);
	await page.click('#continue');
	await page.waitForFunction(
		() => document.querySelector('h1')?.textContent === 'You are signed in',
	);
	console.log('Enrolled', id, 'connecting Honeycrisp');
	await page.goto(`${appOrigin}/?connect`);
	await page.getByText('Connect to your server', { exact: true }).click();
	await page.getByPlaceholder('https://your-server.example').fill(origin);
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	await page
		.getByRole('button', { name: 'Sign in to your server', exact: true })
		.click();
	await page.waitForURL(`${appOrigin}/`);
	await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
	console.log('Opened Honeycrisp', id);
	assert.equal(
		await page.evaluate(async () => {
			const path = '/src/lib/application.ts';
			const { account }: typeof import('../src/lib/application.js') =
				await import(path);
			return account?.principalId;
		}),
		id,
	);
	return page;
}
try {
	await Promise.all([ready(origin, worker), ready(appOrigin, vite)]);
	console.log('Development servers ready', origin, appOrigin);
	proxy = await getPlatformProxy<TestBindings>({
		configPath: operatorConfig,
		persist: false,
		remoteBindings: false,
	});
	// Probe without side effects before issuing a non-repeatable enrollment grant.
	for (let attempt = 0; ; attempt++) {
		try {
			assert.equal(await proxy.env.LIBRARY_TEST.ready(), true);
			break;
		} catch (cause) {
			if (attempt === 100) throw cause;
			assert.equal(worker.exitCode, null, 'Development server exited');
			await Bun.sleep(100);
		}
	}
	browser = await chromium.launch({ headless: true });
	const alice = await enroll('alice');
	const bob = await enroll('bob');
	await note(alice, 'Alice private note');
	assert.equal(
		await bob.getByText('Alice private note', { exact: true }).count(),
		0,
	);
	await note(bob, 'Bob private note');
	assert.equal(
		await alice.getByText('Bob private note', { exact: true }).count(),
		0,
	);
	const refusedPersonal = await bob.evaluate(async () => {
		const modulePath = '/src/lib/application.ts';
		const { account }: typeof import('../src/lib/application.js') =
			await import(modulePath);
		if (!account) throw new Error('Expected an authenticated account');
		const path =
			'/api/libraries/so.epicenter.honeycrisp/personal/data/so.epicenter.honeycrisp/current?owner=alice';
		return (
			await account.fetch(path, { method: 'POST', body: new Uint8Array() })
		).status;
	});
	assert.equal(refusedPersonal, 403);
	console.log('Bob cannot select Alice as Personal owner:', refusedPersonal);
	await Promise.all([select(alice, 'Shared'), select(bob, 'Shared')]);
	const canonical = await Promise.all(sharedDownloads);
	assert(canonical[0]);
	assert(canonical[0].generation);
	assert(canonical[0].bytes.length > 0);
	assert.deepEqual(canonical[0], canonical[1]);
	console.log(
		'Concurrent fresh Shared clients selected generation',
		canonical[0].generation,
		'at position',
		canonical[0].position,
		'with identical snapshot bytes',
	);
	await note(alice, 'Shared note from Alice');
	await openNote(bob, 'Shared note from Alice');
	await bob.locator('.ProseMirror').fill('Shared note edited by Bob');
	await bob.locator('.ProseMirror').blur();
	await alice
		.getByText('Shared note edited by Bob', { exact: true })
		.first()
		.waitFor();
	await bob.screenshot({ path: '/tmp/honeycrisp-shared-bob.png' });
	await proveRetirement({
		alice,
		bob,
		origin,
		operator: proxy.env.LIBRARY_TEST,
		openNote,
	});
	await select(alice, 'Personal');
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	assert.equal(
		await alice.getByText('Replacement from Bob', { exact: true }).count(),
		0,
	);
	await alice.screenshot({ path: '/tmp/honeycrisp-personal-alice.png' });
	let outage = true;
	await alice.routeWebSocket(
		`${origin.replace('http:', 'ws:')}/**`,
		(socket) => {
			if (outage) socket.close();
			else socket.connectToServer();
		},
	);
	await alice.route(`${origin}/**`, (route) => route.abort());
	await alice.reload();
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	assert.equal(
		await alice.evaluate(async () => {
			const path = '/src/lib/application.ts';
			const { account }: typeof import('../src/lib/application.js') =
				await import(path);
			return account?.principalId;
		}),
		'alice',
	);
	await select(alice, 'Shared');
	await alice
		.getByText('Replacement from Bob', { exact: true })
		.first()
		.waitFor();
	outage = false;
	await alice.unroute(`${origin}/**`);
	const localContext = await browser.newContext();
	const local = await localContext.newPage();
	pages.push(local);
	local.setDefaultTimeout(30_000);
	await local.goto(appOrigin);
	await note(local, 'Only on this device');
	assert.equal(
		await local.evaluate(async () => {
			const path = '/src/lib/application.ts';
			const { account }: typeof import('../src/lib/application.js') =
				await import(path);
			return account;
		}),
		undefined,
	);
	await local.reload();
	await local
		.getByText('Only on this device', { exact: true })
		.first()
		.waitFor();
	await local
		.getByRole('navigation', { name: 'Library' })
		.getByRole('button', { name: 'Personal', exact: true })
		.click();
	await local.getByText('Choose where to connect.', { exact: true }).waitFor();
	await local.reload();
	await local.getByText('Choose where to connect.', { exact: true }).waitFor();
	assert.equal(
		await local.getByRole('button', { name: 'New note', exact: true }).count(),
		0,
	);
	assert.equal(
		await local.evaluate(() => localStorage.getItem('honeycrisp.library')),
		'personal',
	);
	await select(local, 'Local');
	await local
		.getByText('Only on this device', { exact: true })
		.first()
		.waitFor();
	await select(alice, 'Local');
	assert.equal(
		await alice.getByText('Only on this device', { exact: true }).count(),
		0,
	);
	assert.equal(
		await alice.getByText('Alice private note', { exact: true }).count(),
		0,
	);
	await proxy.env.OPERATOR.remove('bob');
	const removed = await bob.evaluate(async () => {
		const modulePath = '/src/lib/application.ts';
		const { account }: typeof import('../src/lib/application.js') =
			await import(modulePath);
		if (!account) throw new Error('Expected an authenticated account');
		const result = await account.fetch('/api/session');
		return result.status;
	});
	assert.equal(removed, 401);
	console.log('Removal subsequent protected request:', JSON.stringify(removed));
	assert.deepEqual(errors, []);
	passed = true;
	console.log(
		'PASS: actual Honeycrisp UI, independent Alice/Bob browser storage, Personal isolation, Shared edit convergence and replacement retirement, Local signed-out isolation, remembered selection, cached Worker-outage reopening, and close-before-switch. Existing socket removal is not proven here.',
	);
} finally {
	if (!passed) {
		for (const page of pages)
			if (!page.isClosed())
				console.error(
					'Page',
					page.url(),
					await page
						.locator('body')
						.innerText()
						.catch(() => 'unavailable'),
				);
		console.error(errors, logs.join('\n'));
	}
	console.log('Closing Chromium');
	try {
		await browser?.close();
	} finally {
		try {
			console.log('Disposing operator proxy');
			await proxy?.dispose();
		} finally {
			console.log('Stopping development servers');
			for (const child of children)
				if (child.pid) {
					try {
						process.kill(-child.pid, 'SIGTERM');
					} catch {}
				}
			await Bun.sleep(250);
			for (const child of children)
				if (child.pid) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch {}
				}
			rmSync(directory, { recursive: true, force: true });
		}
	}
}
