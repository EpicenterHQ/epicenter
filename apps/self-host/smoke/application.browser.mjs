/**
 * Chromium enrollment to application Account using the actual Bun or Worker self-host entry.
 * Run from the repository root: bun apps/self-host/smoke/application.browser.mjs
 * Add --worker to exercise local Worker operator RPC and SQLite.
 * Uses temporary SQLite and a virtual authenticator; no deployment or existing data.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';

const { chromium } = createRequire(
	new URL('../../../packages/data/package.json', import.meta.url),
)('playwright');
const workerMode = process.argv.slice(2).includes('--worker');
const root = join(import.meta.dir, '../../..');
const directory = mkdtempSync(join(tmpdir(), 'self-host-application-'));
const path = join(directory, 'auth.sqlite');
const bundle = await Bun.build({
	entrypoints: [join(import.meta.dir, 'application-page.ts')],
	target: 'browser',
});
assert(bundle.success, bundle.logs.map(String).join('\n'));
const script = await bundle.outputs[0].text();
const reservation = Bun.serve({
	hostname: 'localhost',
	port: 0,
	fetch: () => new Response(),
});
const origin = reservation.url.origin;
await reservation.stop(true);
const app = Bun.serve({
	hostname: 'localhost',
	port: 0,
	fetch(request) {
		if (new URL(request.url).pathname === '/fixture.js')
			return new Response(script, {
				headers: { 'content-type': 'text/javascript' },
			});
		return new Response(
			`<!doctype html><meta charset="utf-8"><body data-issuer="${origin}"><button id="connect">Connect</button><button id="sign-in">Sign in</button><button id="check">Check</button><output></output><script type="module" src="/fixture.js"></script>`,
			{ headers: { 'content-type': 'text/html' } },
		);
	},
});
const callbacks = [`${app.url.origin}/auth/callback`];
const issuerEnvironment = {
	API_PUBLIC_ORIGIN: origin,
	SELF_HOST_CALLBACKS: JSON.stringify(callbacks),
	TRUSTED_BROWSER_ORIGINS: app.url.origin,
};
const workerName = `application-smoke-${crypto.randomUUID()}`;
const workerConfig = join(directory, 'worker.json');
const operatorConfig = join(directory, 'operator.json');
if (workerMode) {
	writeFileSync(
		workerConfig,
		JSON.stringify({
			name: workerName,
			main: join(root, 'apps/self-host/worker/index.ts'),
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
			],
		}),
	);
}
const child = spawn(
	'bun',
	workerMode
		? [
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
			]
		: ['dev:self-host'],
	{
		detached: true,
		// Resolve the same installed Wrangler as getPlatformProxy.
		cwd: workerMode ? join(root, 'apps/self-host') : root,
		env: {
			...process.env,
			...issuerEnvironment,
			PORT: String(new URL(origin).port),
			AUTH_DB_PATH: path,
			WRANGLER_SEND_METRICS: 'false',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	},
);
const logs = [];
child.stdout.on('data', (data) => logs.push(String(data)));
child.stderr.on('data', (data) => logs.push(String(data)));
const exited = new Promise((resolve) => child.on('exit', () => resolve()));
let browser;
let passed = false;
let page;
let operator;
let operatorAuth;
let proxy;
function grantUrl(grant) {
	return grant.url ?? `${origin}/sign-in#enroll=${grant.token}`;
}
try {
	for (let i = 0; ; i++) {
		try {
			if ((await fetch(origin)).ok) break;
		} catch {}
		if (child.exitCode !== null) throw new Error('Self-host process exited');
		if (i === 100) throw new Error('Self-host did not start');
		await Bun.sleep(100);
	}
	if (workerMode) {
		const { getPlatformProxy } = await import('wrangler');
		proxy = await getPlatformProxy({
			configPath: operatorConfig,
			persist: false,
			remoteBindings: false,
		});
		operatorAuth = proxy.env.OPERATOR;
	} else {
		operator = openSelfHostAuth({ path, origin, callbacks });
		operatorAuth = operator.auth;
	}
	const grant = await operatorAuth.admit({ id: 'alice', name: 'Alice' });
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	page = await context.newPage();
	const errors = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const cdp = await context.newCDPSession(page);
	await cdp.send('WebAuthn.enable');
	const { authenticatorId } = await cdp.send(
		'WebAuthn.addVirtualAuthenticator',
		{
			options: {
				protocol: 'ctap2',
				transport: 'internal',
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
			},
		},
	);
	const link = grantUrl(grant);
	const grantToken = new URLSearchParams(new URL(link).hash.slice(1)).get(
		'enroll',
	);
	assert(grantToken);
	await page.goto(link);
	await page.click('#continue');
	await page.waitForFunction(
		() => document.querySelector('h1')?.textContent === 'You are signed in',
	);
	assert(!page.url().includes(grantToken));
	await page.goto(app.url.origin);
	await page.click('#connect');
	await page.waitForURL(`${app.url.origin}/`);
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === 'alice',
	);
	await page.click('#check');
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === '200:alice',
	);
	// A reload restores cached identity even without any network to the issuer.
	await page.route(`${origin}/**`, (route) => route.abort());
	await page.reload();
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === 'alice',
	);
	await page.unroute(`${origin}/**`);
	await page.click('#check');
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === '200:alice',
	);
	const recovery = await operatorAuth.recover('alice');
	await page.click('#check');
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === '401:alice',
	);
	await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
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
	await page.goto(grantUrl(recovery));
	await page.click('#continue');
	await page.waitForFunction(
		() => document.querySelector('h1')?.textContent === 'You are signed in',
	);
	await page.goto(app.url.origin);
	await page.click('#sign-in');
	await page.waitForURL(`${origin}/sign-in?**`);
	await page.click('#continue');
	await page.waitForURL(`${app.url.origin}/`);
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === 'alice',
	);
	await page.click('#check');
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === '200:alice',
	);
	await operatorAuth.remove('alice');
	await page.click('#check');
	await page.waitForFunction(
		() => document.querySelector('output')?.textContent === '401:alice',
	);
	assert.deepEqual(errors, []);
	passed = true;
	console.log(
		`Chromium (${workerMode ? 'Worker' : 'Bun'}): enrollment, application handoff, offline identity, same-user recovery, fresh passkey sign-in, and removal passed.`,
	);
} finally {
	if (!passed && page)
		console.error(
			'Browser failure at',
			page.url(),
			await page.locator('body').innerText(),
		);
	await browser?.close();
	operator?.close();
	await proxy?.dispose();
	if (child.pid) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch (error) {
			if (error?.code !== 'ESRCH') throw error;
		}
		await Bun.sleep(250);
		// The development watcher can outlive its server and wrapper processes.
		try {
			process.kill(-child.pid, 'SIGKILL');
		} catch (error) {
			if (
				!(
					error &&
					typeof error === 'object' &&
					'code' in error &&
					error.code === 'ESRCH'
				)
			)
				throw error;
		}
	}
	await exited;
	if (!passed) console.error(logs.join('\n'));
	await app.stop(true);
	rmSync(directory, { recursive: true, force: true });
}
