/** Run from the repository root: bun packages/app/scripts/recording-libraries.browser.mjs */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = join(import.meta.dir, '../../..');
const pageModule = '/packages/app/scripts/recording-libraries.page.ts';
const appId = 'so.epicenter.recording-acceptance';
const directory = mkdtempSync(join(tmpdir(), 'app-recording-state-'));
const evidence = mkdtempSync(join(tmpdir(), 'app-recording-evidence-'));
const { getPlatformProxy } = createRequire(
	new URL('../../../apps/self-host/package.json', import.meta.url),
)('wrangler');

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
const workerOrigin = await reserveOrigin();
const browserOrigin = await reserveOrigin();
const workerName = `recording-acceptance-${crypto.randomUUID()}`;
const workerConfig = join(directory, 'worker.json');
const operatorConfig = join(directory, 'operator.json');
writeFileSync(
	workerConfig,
	JSON.stringify({
		name: workerName,
		main: join(root, 'apps/self-host/worker/index.ts'),
		compatibility_date: '2026-03-06',
		compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
		send_metrics: false,
		vars: {
			API_PUBLIC_ORIGIN: workerOrigin,
			SELF_HOST_CALLBACKS: JSON.stringify([`${browserOrigin}/auth/callback`]),
			TRUSTED_BROWSER_ORIGINS: browserOrigin,
		},
		durable_objects: {
			bindings: [
				{ name: 'SELF_HOST_AUTH', class_name: 'SelfHostAuthOwner' },
				{ name: 'STORE_AUTHORITY', class_name: 'StoreAuthority' },
				{ name: 'GENERATIONS_LEDGER', class_name: 'GenerationsLedger' },
			],
		},
		migrations: [
			{
				tag: 'acceptance',
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
		name: `${workerName}-operator`,
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

let browser, server, proxy, worker;
const logs = [];
const errors = [];
const cleanupFailures = [];
const report = {
	kind: 'package browser acceptance',
	at: new Date().toISOString(),
	recordings: {},
	checks: {},
	limits: [
		'Synthetic microphone input through real Chromium MediaRecorder.',
		'Package test page; does not mount Whispering UI.',
		'Shared row convergence is verified; S3 blob transfer and native capture are not exercised.',
	],
};
try {
	worker = spawn(
		'bun',
		[
			'x',
			'--no-install',
			'wrangler',
			'dev',
			'--local',
			'--config',
			workerConfig,
			'--port',
			new URL(workerOrigin).port,
			'--inspector-port',
			'0',
			'--persist-to',
			join(directory, 'worker-state'),
		],
		{
			cwd: join(root, 'apps/self-host'),
			detached: true,
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	for (const stream of [worker.stdout, worker.stderr])
		stream.on('data', (chunk) => {
			logs.push(String(chunk));
			if (process.env.SMOKE_VERBOSE) process.stderr.write(chunk);
		});
	const html = `<!doctype html><meta charset="utf-8"><title>App recording acceptance</title><h1>App recording acceptance</h1><p>Opening library</p><script type="module">import { boot } from '${pageModule}'; await boot(${JSON.stringify(workerOrigin)});</script>`;
	server = await createServer({
		configFile: false,
		root,
		optimizeDeps: {
			entries: [
				'packages/app/scripts/recording-libraries.page.ts',
				'packages/device/src/browser-sqlite.worker.ts',
			],
		},
		server: {
			host: 'localhost',
			port: Number(new URL(browserOrigin).port),
			strictPort: true,
			watch: null,
		},
		plugins: [
			{
				name: 'recording-acceptance-page',
				configureServer(vite) {
					vite.middlewares.use((request, response, next) => {
						if (
							!['/', '/auth/callback'].includes(
								new URL(request.url, browserOrigin).pathname,
							)
						)
							return next();
						response.setHeader('content-type', 'text/html');
						response.end(html);
					});
				},
			},
		],
	});
	await server.listen();
	let workerReady = false;
	for (let i = 0; i < 200; i++) {
		try {
			if (
				(await fetch(workerOrigin, { signal: AbortSignal.timeout(1000) })).ok
			) {
				workerReady = true;
				break;
			}
		} catch {}
		assert.equal(worker.exitCode, null, 'Worker exited before readiness');
		await Bun.sleep(100);
	}
	assert(workerReady, 'Worker did not become ready');
	proxy = await getPlatformProxy({
		configPath: operatorConfig,
		persist: false,
		remoteBindings: false,
	});
	browser = await chromium.launch({
		headless: true,
		args: [
			'--use-fake-device-for-media-stream',
			'--use-fake-ui-for-media-stream',
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	async function pageFor(name) {
		const context = await browser.newContext();
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
		page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
		return { context, page };
	}
	async function ready(page, library) {
		await page.waitForFunction(
			(library) => document.body.dataset.ready === library,
			library,
		);
	}
	async function invoke(page, method, argument) {
		return page.evaluate(
			async ({ path, method, argument }) =>
				(await import(path))[method](argument),
			{ path: pageModule, method, argument },
		);
	}
	async function reload(page, library) {
		await page.evaluate(
			async (path) => (await import(path)).app.close(),
			pageModule,
		);
		await page.reload();
		await ready(page, library);
	}
	async function select(page, library, previous) {
		await invoke(page, 'select', library);
		await page.reload();
		await ready(page, library);
		assert.equal(
			await page.evaluate(() => sessionStorage.getItem('closed-library')),
			previous,
		);
	}
	async function enroll(id) {
		const grant = await proxy.env.OPERATOR.admit({
			id,
			name: id === 'alice' ? 'Alice' : 'Bob',
		});
		const { context, page } = await pageFor(id);
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
		await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
		await page.goto(browserOrigin);
		await ready(page, 'local');
		await invoke(page, 'signIn');
		await page.waitForURL(`${browserOrigin}/`);
		await ready(page, 'personal');
		const actor = await page.evaluate(async (path) => {
			const { auth, app } = await import(path);
			const response = await auth.state.account.fetch('/api/session');
			return {
				status: response.status,
				session: await response.json(),
				captured: app.account,
			};
		}, pageModule);
		assert.equal(actor.status, 200);
		assert.equal(actor.session.principalId, id);
		assert.equal(actor.captured.principalId, id);
		return page;
	}
	const { page: local } = await pageFor('local');
	let localAuthorityRequests = 0;
	local.on('request', (request) => {
		if (request.url().startsWith(workerOrigin)) localAuthorityRequests++;
	});
	await local.goto(browserOrigin);
	await ready(local, 'local');
	report.recordings.local = await invoke(local, 'capture', 'Local recording');
	assert.equal(report.recordings.local.replica.library, 'local');
	assert.equal(
		await local.evaluate(
			async (path) => (await import(path)).app.ai.account,
			pageModule,
		),
		null,
	);
	report.checks.localClosure = await invoke(
		local,
		'closeWithCapture',
		report.recordings.local.rowId,
	);
	await local.reload();
	await ready(local, 'local');
	await invoke(local, 'absent', report.checks.localClosure.cancelled);
	await invoke(local, 'absent', report.checks.localClosure.closedCapture);
	assert.equal(
		(await invoke(local, 'read', report.recordings.local.rowId)).sha256,
		report.recordings.local.sha256,
	);
	assert.equal(localAuthorityRequests, 0);
	report.checks.localAuthorityRequests = localAuthorityRequests;
	console.log(
		'PASS Local: capture, saved attachment, playback, decoding, cancellation, close and byte-identical reopen',
	);
	const alice = await enroll('alice');
	const bob = await enroll('bob');
	report.recordings.alicePersonal = await invoke(
		alice,
		'capture',
		'Alice Personal recording',
	);
	report.recordings.bobPersonal = await invoke(
		bob,
		'capture',
		'Bob Personal recording',
	);
	await invoke(bob, 'absent', report.recordings.alicePersonal.rowId);
	await invoke(alice, 'absent', report.recordings.bobPersonal.rowId);
	for (const [page, recording] of [
		[bob, report.recordings.alicePersonal],
		[alice, report.recordings.bobPersonal],
	]) {
		assert.equal(
			await page.evaluate(
				async ({ path, rowId }) =>
					(await import(path)).app.tables.recordings.get(rowId),
				{ path: pageModule, rowId: recording.rowId },
			),
			undefined,
		);
	}
	report.checks.personalRowsIsolated = true;
	const refused = await bob.evaluate(
		async ({ path, appId }) => {
			const { auth } = await import(path);
			return (
				await auth.state.account.fetch(
					`/api/libraries/${appId}/personal/data/${appId}/current?owner=alice`,
					{ method: 'POST', body: new Uint8Array() },
				)
			).status;
		},
		{ path: pageModule, appId },
	);
	assert.equal(refused, 403);
	report.checks.personalOwnerOverride = refused;
	await reload(alice, 'personal');
	assert.equal(
		(await invoke(alice, 'read', report.recordings.alicePersonal.rowId)).sha256,
		report.recordings.alicePersonal.sha256,
	);
	console.log(
		'PASS Personal: real Alice/Bob Accounts, independent bytes, refused owner override and byte-identical reopen',
	);
	await Promise.all([
		select(alice, 'shared', 'personal'),
		select(bob, 'shared', 'personal'),
	]);
	await invoke(alice, 'absent', report.recordings.alicePersonal.rowId);
	await invoke(bob, 'absent', report.recordings.bobPersonal.rowId);
	report.recordings.aliceShared = await invoke(
		alice,
		'capture',
		'Alice Shared recording',
	);
	report.recordings.bobShared = await invoke(
		bob,
		'capture',
		'Bob Shared recording',
	);
	async function sharedRow(page, recording, actor) {
		for (let attempt = 0; attempt < 300; attempt++) {
			const observed = await page.evaluate(
				async ({ path, rowId, actor }) =>
					(await import(path)).app.tables.recordings.get(rowId)?.actor ===
					actor,
				{ path: pageModule, rowId: recording.rowId, actor },
			);
			if (observed) return;
			await Bun.sleep(100);
		}
		throw new Error(`Shared recording from ${actor} did not converge`);
	}
	await Promise.all([
		sharedRow(bob, report.recordings.aliceShared, 'alice'),
		sharedRow(alice, report.recordings.bobShared, 'bob'),
	]);
	assert.equal(
		report.recordings.aliceShared.replica.account.principalId,
		'alice',
	);
	assert.equal(report.recordings.bobShared.replica.account.principalId, 'bob');
	assert.equal(report.recordings.aliceShared.replica.library, 'shared');
	assert.equal(report.recordings.bobShared.replica.library, 'shared');
	await invoke(bob, 'absent', report.recordings.aliceShared.rowId);
	report.checks.sharedRowsConverged = true;
	report.checks.sharedClosure = await invoke(
		alice,
		'closeWithCapture',
		report.recordings.aliceShared.rowId,
	);
	await alice.reload();
	await ready(alice, 'shared');
	await invoke(alice, 'absent', report.checks.sharedClosure.closedCapture);
	assert.equal(
		(await invoke(alice, 'read', report.recordings.aliceShared.rowId)).sha256,
		report.recordings.aliceShared.sha256,
	);
	await select(alice, 'personal', 'shared');
	await invoke(alice, 'absent', report.recordings.aliceShared.rowId);
	assert.equal(
		(await invoke(alice, 'read', report.recordings.alicePersonal.rowId)).sha256,
		report.recordings.alicePersonal.sha256,
	);
	await select(alice, 'local', 'personal');
	await invoke(alice, 'absent', report.recordings.alicePersonal.rowId);
	await invoke(alice, 'absent', report.recordings.local.rowId);
	console.log(
		'PASS Shared: Alice/Bob actor identity, recording rows converge, scope isolation, playback, closure and byte-identical reopen',
	);
	for (const page of [local, alice, bob])
		await page.evaluate(
			async (path) => (await import(path)).app.close(),
			pageModule,
		);
	assert.deepEqual(errors, []);
	report.passed = true;
	writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
	console.log(`Evidence: ${join(evidence, 'result.json')}`);
} catch (error) {
	console.error(errors, logs.join('\n'));
	throw error;
} finally {
	const cleanup = [];
	for (const close of [() => browser?.close(), () => server?.close()]) {
		try {
			await close();
		} catch (cause) {
			cleanup.push(cause);
		}
	}
	if (worker?.pid) {
		try {
			process.kill(-worker.pid, 'SIGTERM');
		} catch {}
		await Bun.sleep(250);
		try {
			process.kill(-worker.pid, 'SIGKILL');
		} catch {}
	}
	try {
		await proxy?.dispose();
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
	cleanupFailures.push(...cleanup);
}
if (cleanupFailures.length)
	throw new AggregateError(
		cleanupFailures,
		'Browser acceptance cleanup failed',
	);
