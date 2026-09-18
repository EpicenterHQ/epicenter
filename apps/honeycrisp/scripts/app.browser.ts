/** Actual Honeycrisp UI against a temporary local Worker. Run with Bun from the repository root. */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import type { PlatformProxy } from 'wrangler';
import { type AppTestOperator, proveRetirement } from './app-retirement.js';

// Use the same Wrangler installation as the self-hosted Worker below.
const { getPlatformProxy }: typeof import('wrangler') = createRequire(
	new URL('../../self-host/package.json', import.meta.url),
)('wrangler');
const root = join(import.meta.dir, '../../..');
const directory = mkdtempSync(join(tmpdir(), 'honeycrisp-app-'));
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
		main: join(root, 'apps/honeycrisp/scripts/app.worker.ts'),
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
				binding: 'APP_TEST',
				service: workerName,
				entrypoint: 'AppTestOperator',
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
	`import config from ${JSON.stringify(join(root, 'apps/honeycrisp/vite.config.ts'))};\nexport default { ...config, resolve: { ...config.resolve, alias: { ...config.resolve?.alias, "#platform/auth": ${JSON.stringify(join(root, 'apps/honeycrisp/scripts/app-auth.ts'))} } }, define: { ...config.define, "import.meta.env.VITE_HONEYCRISP_TEST_ORIGIN": ${JSON.stringify(JSON.stringify(origin))} }, server: { ...config.server, watch: null, hmr: false } };\n`,
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
	APP_TEST: AppTestOperator & { ready(): Promise<boolean> };
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
async function select(page: Page, name: 'Local' | 'Personal') {
	const before = await page.evaluate(() => ({
		documents: sessionStorage.getItem('journey.documents'),
		claims: sessionStorage.getItem('journey.claims'),
	}));
	await page.getByRole('link', { name, exact: true }).first().click();
	await page.waitForURL(`**/${name.toLowerCase()}`);
	if (name === 'Local')
		await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
	assert.deepEqual(
		await page.evaluate(() => ({
			documents: sessionStorage.getItem('journey.documents'),
			claims: sessionStorage.getItem('journey.claims'),
		})),
		before,
		'Notes navigation must preserve the document and acquire no replacement App',
	);
}

async function observeOwnership(page: Page) {
	await page.addInitScript(() => {
		sessionStorage.setItem(
			'journey.documents',
			String(Number(sessionStorage.getItem('journey.documents') ?? 0) + 1),
		);
		const request = navigator.locks.request.bind(navigator.locks);
		navigator.locks.request = ((
			...args: Parameters<LockManager['request']>
		) => {
			if (args[0].startsWith('epicenter.store:')) {
				sessionStorage.setItem(
					'journey.claims',
					String(Number(sessionStorage.getItem('journey.claims') ?? 0) + 1),
				);
			}
			return Reflect.apply(request, navigator.locks, args);
		}) as LockManager['request'];
	});
}

async function assertNoStores(page: Page) {
	assert.equal(
		await page.evaluate(
			async () =>
				(await navigator.locks.query()).held?.some((lock) =>
					lock.name?.startsWith('epicenter.store:'),
				) ?? false,
		),
		false,
	);
	assert.equal(
		await page.evaluate(() =>
			Number(sessionStorage.getItem('journey.claims') ?? 0),
		),
		0,
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
	page.on('response', (response) => {
		if (
			response.request().method() !== 'POST' ||
			!response.url().includes('/shared/data/so.epicenter.honeycrisp/current')
		)
			return;
		sharedDownloads.push(
			(async () => {
				assert.equal(response.status(), 200);
				return {
					generation: response.headers()['epicenter-generation'],
					position: response.headers()['epicenter-log-position'],
					bytes: [...(await response.body())],
				};
			})(),
		);
	});

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
	await observeOwnership(page);
	await page.goto(`${appOrigin}/connect`);
	await assertNoStores(page);
	await page
		.getByRole('button', { name: 'Sign in to your server', exact: true })
		.click();
	await page.waitForURL(`${appOrigin}/personal`);
	await page.getByRole('button', { name: 'New note', exact: true }).waitFor();
	console.log('Opened Honeycrisp', id);

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
			assert.equal(await proxy.env.APP_TEST.ready(), true);
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

	const canonical = await Promise.all(sharedDownloads);
	assert.equal(canonical.length, 2);
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
	await proveRetirement({
		alice,
		bob,
		origin,
		operator: proxy.env.APP_TEST,
		openNote,
	});
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	await select(alice, 'Local');
	await note(alice, 'Alice device note');
	await select(alice, 'Personal');
	await alice
		.getByText('Alice private note', { exact: true })
		.first()
		.waitFor();
	assert.equal(
		await alice.getByText('Alice device note', { exact: true }).count(),
		0,
	);
	for (let visit = 0; visit < 3; visit++) {
		await select(alice, 'Local');
		await alice
			.getByText('Alice device note', { exact: true })
			.first()
			.waitFor();
		await select(alice, 'Personal');
		await alice
			.getByText('Alice private note', { exact: true })
			.first()
			.waitFor();
	}

	await openNote(alice, 'Alice private note');
	await alice.locator('.ProseMirror').fill('Alice final edit');
	await select(alice, 'Local');
	await select(alice, 'Personal');
	await alice.getByText('Alice final edit', { exact: true }).first().waitFor();

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
	await alice.getByText('Alice final edit', { exact: true }).first().waitFor();

	outage = false;
	await alice.unroute(`${origin}/**`);
	const localContext = await browser.newContext();
	const local = await localContext.newPage();
	pages.push(local);
	local.setDefaultTimeout(30_000);
	await observeOwnership(local);
	await local.goto(`${appOrigin}/connect`);
	await local
		.getByRole('button', { name: 'Sign in to your server', exact: true })
		.waitFor();
	await assertNoStores(local);
	for (const path of ['/local', '/personal']) {
		await local.evaluate((path) => {
			const link = document.createElement('a');
			link.href = path;
			link.textContent = `Preload ${path}`;
			link.dataset.sveltekitPreloadCode = 'hover';
			link.dataset.sveltekitPreloadData = 'off';
			document.body.append(link);
		}, path);
		const hovered = local.getByRole('link', {
			name: `Preload ${path}`,
			exact: true,
		});
		if (path === '/local') {
			await Promise.all([
				local.waitForResponse(
					(response) =>
						response.url().includes('notes') &&
						response.url().includes('page.svelte'),
				),
				hovered.hover(),
			]);
		} else await hovered.hover();
	}
	// Let imported route modules finish evaluating before checking acquisition.
	await local.waitForTimeout(500);
	await assertNoStores(local);
	await local.goto(`${appOrigin}/auth/callback`);
	await local.waitForTimeout(250);
	await assertNoStores(local);
	await local.goto(appOrigin);
	await local.waitForURL(`${appOrigin}/personal`);
	assert.equal(
		await local.getByRole('button', { name: 'New note', exact: true }).count(),
		0,
	);
	await select(local, 'Local');
	await note(local, 'Only on this device');
	await local.reload();
	await local
		.getByText('Only on this device', { exact: true })
		.first()
		.waitFor();
	await select(local, 'Personal');
	assert.equal(
		await local.getByRole('button', { name: 'New note', exact: true }).count(),
		0,
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
		await alice.getByText('Alice final edit', { exact: true }).count(),
		0,
	);

	assert.deepEqual(errors, []);
	passed = true;
	console.log(
		'PASS: route preloading and auxiliary pages acquire nothing; Local/Personal navigation preserves one App; separate stores retain notes; Personal isolation, account-wide retirement and cached outage reopening.',
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
