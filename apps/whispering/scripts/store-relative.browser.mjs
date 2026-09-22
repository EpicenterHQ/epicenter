/** Isolated actual Whispering UI with synthetic capture and a local S3 fixture.
 * Run from root: bun apps/whispering/scripts/store-relative.browser.mjs
 * No production network, physical microphone, or real inference is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');
const { chromium } = createRequire(
	new URL('../../../packages/app/package.json', import.meta.url),
)('playwright');
const { getPlatformProxy } = createRequire(
	new URL('../../self-host/package.json', import.meta.url),
)('wrangler');
const directory = mkdtempSync(join(tmpdir(), 'whispering-recording-state-'));
const evidence = mkdtempSync(join(tmpdir(), 'whispering-recording-evidence-'));
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
const objects = new Map();
const s3 = Bun.serve({
	hostname: 'localhost',
	port: 0,
	async fetch(request) {
		const key = new URL(request.url).pathname;
		if (request.method === 'PUT') {
			if (objects.has(key)) return new Response('', { status: 412 });
			objects.set(key, new Uint8Array(await request.arrayBuffer()));
			return new Response(null, { headers: { etag: '"fixture-etag"' } });
		}
		const bytes = objects.get(key);
		if (!bytes) return new Response('missing', { status: 404 });
		const headers = {
			etag: '"fixture-etag"',
			'content-length': String(bytes.length),
			'content-type': 'application/octet-stream',
			'accept-ranges': 'bytes',
		};
		const range = request.headers.get('range')?.match(/bytes=(\d+)-(\d*)/);
		if (range) {
			const start = Number(range[1]);
			const end = range[2]
				? Math.min(Number(range[2]), bytes.length - 1)
				: bytes.length - 1;
			const part = bytes.slice(start, end + 1);
			return new Response(part, {
				status: 206,
				headers: {
					...headers,
					'content-length': String(part.length),
					'content-range': `bytes ${start}-${end}/${bytes.length}`,
				},
			});
		}
		return new Response(request.method === 'HEAD' ? null : bytes, { headers });
	},
});
const workerOrigin = await reserveOrigin();
const appOrigin = await reserveOrigin();
const workerName = `whispering-recording-${crypto.randomUUID()}`;
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
			BLOBS_S3_ENDPOINT: s3.url.origin,
			BLOBS_S3_ACCESS_KEY_ID: 'fixture',
			BLOBS_S3_SECRET_ACCESS_KEY: 'fixture',
			TRUSTED_BROWSER_ORIGINS: appOrigin,
			SELF_HOST_CALLBACKS: JSON.stringify([`${appOrigin}/auth/callback`]),
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
const viteConfig = join(directory, 'vite.config.mts');
const dependencyCache = realpathSync(join(root, 'node_modules/.bun'));
writeFileSync(
	viteConfig,
	`import config from ${JSON.stringify(join(root, 'apps/whispering/vite.config.ts'))};\nimport { observeBoot } from ${JSON.stringify(join(root, 'packages/app-shell/smoke/observe-boot.mjs'))};\nexport default { ...config, plugins: [...config.plugins, observeBoot(), { name: 'observe-whispering', enforce: 'pre', transform(code,id) { if (!id.endsWith('/whispering/ui-session.ts')) return; return code.replace('const queryRuntime =', 'Reflect.set(globalThis, "observedWhispering", { app, local }); const queryRuntime ='); } }], server: { ...config.server, watch: null, hmr: false, fs: { ...config.server?.fs, allow: [...(config.server?.fs?.allow ?? []), ${JSON.stringify(root)}, ${JSON.stringify(dependencyCache)}] } } };\n`,
);
const inferenceRequests = [];
const inference = Bun.serve({
	hostname: 'localhost',
	port: 0,
	async fetch(request) {
		const headers = {
			'access-control-allow-origin': '*',
			'access-control-allow-headers': '*',
			'access-control-allow-methods': 'GET,POST,OPTIONS',
		};
		if (request.method === 'OPTIONS') return new Response(null, { headers });
		if (new URL(request.url).pathname.endsWith('/audio/transcriptions')) {
			const form = await request.formData();
			const file = form.get('file');
			inferenceRequests.push({
				prompt: form.get('prompt'),
				size: file.size,
				bytes: new Uint8Array(await file.arrayBuffer()),
			});
			return Response.json(
				{ text: 'Deterministic fixture transcript' },
				{ headers },
			);
		}
		return Response.json(
			{ data: [{ id: 'fixture-model', object: 'model' }] },
			{ headers },
		);
	},
});
const children = [],
	logs = [],
	pageErrors = [];
let browser, proxy;
function start(args, cwd = root) {
	const child = spawn('bun', args, {
		cwd,
		detached: true,
		env: {
			...process.env,
			WRANGLER_SEND_METRICS: 'false',
			VITE_EPICENTER_SERVER: workerOrigin,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	children.push(child);
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk) => {
			logs.push(String(chunk));
			if (process.env.SMOKE_VERBOSE) process.stderr.write(chunk);
		});
	return child;
}
async function ready(url, child) {
	for (let i = 0; i < 300; i++) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		assert.equal(child.exitCode, null);
		await Bun.sleep(100);
	}
	throw new Error(`Server not ready: ${url}`);
}
async function eventually(check, label) {
	for (let i = 0; i < 450; i++) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}
async function opened(page) {
	await page.waitForFunction(() => !!globalThis.observedWhispering);
	await page.evaluate(async () => {
		await globalThis.observedWhispering.app.playbackReady;
	});
}
async function newPage(storageState) {
	const context = await browser.newContext({
		viewport: { width: 1280, height: 1000 },
		permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
		storageState,
	});
	const allowed = new Set([appOrigin, workerOrigin, inference.url.origin]);
	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());
		return !['http:', 'https:'].includes(url.protocol) ||
			allowed.has(url.origin)
			? route.continue()
			: route.abort();
	});
	await context.routeWebSocket('**/*', (socket) => {
		const url = new URL(socket.url());
		url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
		if (allowed.has(url.origin)) socket.connectToServer();
		else socket.close();
	});
	await context.addInitScript(() => {
		globalThis.fiveMinuteTimers = [];
		const schedule = window.setTimeout;
		window.setTimeout = function (handler, delay, ...args) {
			if (delay === 300000 && typeof handler === 'function')
				globalThis.fiveMinuteTimers.push(handler);
			return schedule(handler, delay, ...args);
		};
	});
	const page = await context.newPage();
	page.setDefaultTimeout(45000);
	page.on('dialog', (dialog) => dialog.accept());
	page.on('pageerror', (error) =>
		pageErrors.push(error.stack ?? error.message),
	);
	return { context, page };
}
async function capture(page) {
	const before = await page.evaluate(
		() => globalThis.observedWhispering.local.tables.recordings.rows.length,
	);
	await page.getByRole('button', { name: /^Start recording/ }).click();
	await page
		.getByRole('button', { name: /^Stop recording/ })
		.first()
		.waitFor();
	await page.waitForTimeout(500);
	await page
		.getByRole('button', { name: /^Stop recording/ })
		.first()
		.click();
	await eventually(
		() =>
			page.evaluate(
				(n) =>
					globalThis.observedWhispering.local.tables.recordings.rows.length ===
					n + 1,
				before,
			),
		'Local capture row',
	);
	return page.evaluate(async () => {
		const { local } = globalThis.observedWhispering;
		await local.persistence.flush();
		assertSaved(local);
		const row = local.tables.recordings.rows.at(-1);
		const bytes = await local.blobs.get(row.audioBlobId);
		if (bytes.error) throw bytes.error;
		return { id: row.id, audioBlobId: row.audioBlobId, size: bytes.data.size };
		function assertSaved(store) {
			if (store.persistence.get() !== 'saved') throw Error('not durable');
		}
	});
}
try {
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
			new URL(workerOrigin).port,
			'--inspector-port',
			'0',
			'--persist-to',
			join(directory, 'worker-state'),
		],
		join(root, 'apps/self-host'),
	);
	const vite = start([
		'dev:whispering:ui',
		'--config',
		viteConfig,
		'--port',
		new URL(appOrigin).port,
		'--strictPort',
	]);
	await Promise.all([ready(workerOrigin, worker), ready(appOrigin, vite)]);
	proxy = await getPlatformProxy({
		configPath: operatorConfig,
		persist: false,
		remoteBindings: false,
	});
	browser = await chromium.launch({
		channel: 'chrome',
		headless: true,
		args: [
			'--use-fake-device-for-media-stream',
			'--use-fake-ui-for-media-stream',
		],
	});
	const localClient = await newPage();
	await localClient.page.goto(appOrigin);
	await opened(localClient.page);
	const captured = await capture(localClient.page);
	assert(captured.size > 0);
	console.log(
		'PASS actual signed-out synthetic capture saves Local bytes and durable row',
	);
	await localClient.page.reload();
	await opened(localClient.page);
	assert(
		await localClient.page.evaluate(
			(id) => !!globalThis.observedWhispering.local.tables.recordings.get(id),
			captured.id,
		),
	);
	await localClient.page
		.getByRole('link', { name: 'Local recordings', exact: true })
		.click();
	await localClient.page
		.getByRole('heading', { name: 'Local recordings', exact: true })
		.waitFor();
	console.log('PASS Local reload and owner-explicit recordings page');
	const grant = await proxy.env.OPERATOR.admit({ id: 'alice', name: 'Alice' });
	const alice = await newPage();
	const cdp = await alice.context.newCDPSession(alice.page);
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
	await alice.page.goto(grant.url);
	await alice.page.click('#continue');
	await alice.page
		.getByRole('heading', { name: 'You are signed in' })
		.waitFor();
	await alice.page.goto(`${appOrigin}/?connect`);
	await alice.page
		.getByRole('button', { name: 'Sign in', exact: true })
		.click();
	await alice.page.waitForURL(`${appOrigin}/`);
	await opened(alice.page);
	const personalOpened = await alice.page.evaluate(async () => {
		try {
			const p = await globalThis.observedWhispering.app.personalReady;
			return p ? { ok: true } : { ok: false };
		} catch (error) {
			return {
				ok: false,
				error: JSON.stringify(error, Object.getOwnPropertyNames(error)),
			};
		}
	});
	console.log('Personal acquisition', personalOpened);
	assert(personalOpened.ok);
	await alice.page.getByRole('link', { name: 'Personal', exact: true }).click();
	await alice.page
		.getByRole('heading', { name: 'Personal recordings', exact: true })
		.waitFor();
	console.log(
		'PASS actual Personal provider mounts before consumers and root worker controls page',
	);
	assert.equal(new URL(alice.page.url()).pathname, '/personal');
	const aliceRecording = await capture(alice.page);
	assert.equal(
		await alice.page.evaluate(
			async () =>
				(await globalThis.observedWhispering.app.personalReady).tables
					.recordings.rows.length,
		),
		0,
	);
	console.log('PASS signed-in capture stays Local without automatic upload');

	// Hold the actual upload while Local fields change.
	await alice.page.evaluate(
		(id) =>
			globalThis.observedWhispering.local.tables.recordings.update(id, {
				title: 'Before transfer',
				transcript: 'Original scalar text',
			}),
		aliceRecording.id,
	);
	await alice.page
		.getByRole('link', { name: 'Local recordings', exact: true })
		.click();
	const uploadEntered = Promise.withResolvers();
	const uploadRelease = Promise.withResolvers();
	await alice.page.route('**/blobs', async (route) => {
		if (route.request().method() === 'POST') {
			uploadEntered.resolve();
			await uploadRelease.promise;
		}
		await route.continue();
	});
	await alice.page
		.getByRole('button', { name: 'Save to Personal', exact: true })
		.click();
	await uploadEntered.promise;
	await alice.page.evaluate(
		(id) =>
			globalThis.observedWhispering.local.tables.recordings.update(id, {
				title: 'Edited during transfer',
				transcript: 'New Local text',
			}),
		aliceRecording.id,
	);
	uploadRelease.resolve();
	await eventually(
		() =>
			alice.page.evaluate(
				async () =>
					(await globalThis.observedWhispering.app.personalReady).tables
						.recordings.rows.length === 1,
			),
		'Personal copy',
	);
	const copied = await alice.page.evaluate(async () => {
		const p = await globalThis.observedWhispering.app.personalReady;
		await p.persistence.flush();
		const row = p.tables.recordings.rows[0];
		return {
			id: row.id,
			audioBlobId: row.audioBlobId,
			title: row.title,
			transcript: row.transcript,
		};
	});
	assert.notEqual(copied.id, aliceRecording.id);
	assert.notEqual(copied.audioBlobId, aliceRecording.audioBlobId);
	assert.equal(copied.title, 'Before transfer');
	assert.equal(copied.transcript, 'Original scalar text');
	await alice.page.unroute('**/blobs');
	console.log(
		'PASS UI Save to Personal creates fresh independent IDs and captures values before upload',
	);
	// Abort real IndexedDB writes, then retry through document-owned UI on Home.
	await alice.page.evaluate(() => {
		const put = IDBObjectStore.prototype.put;
		globalThis.blockWrites = true;
		IDBObjectStore.prototype.put = function (...args) {
			if (globalThis.blockWrites && this.name === 'updates')
				throw new DOMException('Fixture disk full', 'QuotaExceededError');
			return put.apply(this, args);
		};
	});
	await alice.page
		.getByRole('button', { name: 'Save to Personal', exact: true })
		.click();
	await alice.page
		.getByRole('button', { name: 'Finish saving', exact: true })
		.waitFor();
	const pendingIds = await alice.page.evaluate(async () =>
		(
			await globalThis.observedWhispering.app.personalReady
		).tables.recordings.ids(),
	);
	const uploads = objects.size;
	await alice.page.getByRole('link', { name: 'Home', exact: true }).click();
	await alice.page.evaluate(() => {
		globalThis.blockWrites = false;
	});
	await alice.page
		.getByRole('button', { name: 'Finish saving', exact: true })
		.click();
	await eventually(
		() =>
			alice.page
				.getByRole('button', { name: 'Finish saving', exact: true })
				.count()
				.then((n) => n === 0),
		'retained copy persistence',
	);
	assert.deepEqual(
		await alice.page.evaluate(async () =>
			(
				await globalThis.observedWhispering.app.personalReady
			).tables.recordings.ids(),
		),
		pendingIds,
	);
	assert.equal(objects.size, uploads);
	console.log(
		'PASS actual IDB refusal and Finish saving after initiator unmount: no duplicate bytes or row',
	);
	await alice.page.getByRole('link', { name: 'Personal', exact: true }).click();
	await alice.page
		.locator('audio[src*="/_epicenter/blob-presentation/"]')
		.first()
		.waitFor();
	await alice.page
		.locator('audio[src*="/_epicenter/blob-presentation/"]')
		.first()
		.evaluate(async (audio) => {
			await audio.play();
		});
	await eventually(
		() =>
			alice.page
				.locator('audio[src*="/_epicenter/blob-presentation/"]')
				.first()
				.evaluate((audio) => audio.currentTime > 0),
		'Personal playback',
	);
	// Expire the window-owned transport, then force a new media read of that URL.
	await alice.page.evaluate(() => {
		for (const expire of globalThis.fiveMinuteTimers) expire();
	});
	assert.equal(
		await alice.page
			.locator('audio[src*="/_epicenter/blob-presentation/"]')
			.first()
			.evaluate(
				async (audio) => (await fetch(audio.src, { cache: 'no-store' })).status,
			),
		410,
	);
	await alice.page
		.locator('audio[src*="/_epicenter/blob-presentation/"]')
		.first()
		.evaluate((audio) => {
			const url = audio.src;
			audio.pause();
			audio.removeAttribute('src');
			audio.load();
			audio.src = url;
			audio.load();
		});
	await alice.page
		.getByRole('button', { name: 'Reopen audio', exact: true })
		.first()
		.waitFor();
	await alice.page
		.getByRole('button', { name: 'Reopen audio', exact: true })
		.first()
		.click();
	await eventually(
		() =>
			alice.page
				.locator('audio[src*="/_epicenter/blob-presentation/"]')
				.first()
				.evaluate((audio) => audio.readyState >= 2),
		'reacquired Personal playback',
	);
	console.log('PASS actual Personal playback and expired-source recovery');
	await alice.page.reload();
	await opened(alice.page);
	await alice.page.evaluate(async () => {
		await globalThis.observedWhispering.app.personalReady;
	});
	// A second browser profile imports auth only, with no Local/Personal IndexedDB.
	const authState = await alice.context.storageState();
	const second = await newPage(authState);
	await second.page.goto(`${appOrigin}/personal`);
	await opened(second.page);
	await eventually(
		() =>
			second.page.evaluate(
				async () =>
					(await globalThis.observedWhispering.app.personalReady)?.tables
						.recordings.rows.length === 2,
			),
		'isolated second-client Personal read',
	);
	assert.equal(
		await second.page.evaluate(
			() => globalThis.observedWhispering.local.tables.recordings.rows.length,
		),
		0,
	);
	await second.page
		.locator('audio[src*="/_epicenter/blob-presentation/"]')
		.first()
		.waitFor();
	await second.page
		.locator('audio[src*="/_epicenter/blob-presentation/"]')
		.first()
		.evaluate((audio) => audio.play());
	console.log(
		'PASS reload and isolated second-client Personal rows/audio without Local recordings',
	);
	await second.page
		.getByRole('textbox', { name: 'Click to open this recording', exact: true })
		.first()
		.click();
	const downloaded = second.page.waitForEvent('download');
	await second.page
		.getByRole('button', { name: 'Download recording', exact: true })
		.click();
	const file = await downloaded;
	assert((await Bun.file(await file.path()).arrayBuffer()).byteLength > 0);
	await second.page.keyboard.press('Escape');
	console.log('PASS actual Personal download in a profile with no Local bytes');
	// Delayed Personal still admits Local capture. Prompt-dependent inference waits.
	await alice.page.evaluate(async () => {
		const p = await globalThis.observedWhispering.app.personalReady;
		p.kv.update({
			transcriptionPrompt: 'Captured account prompt',
			dictionary: ['Ephemeris'],
		});
		await p.persistence.flush();
	});
	const delayed = await newPage(authState);
	const currentEntered = Promise.withResolvers();
	const currentRelease = Promise.withResolvers();
	await delayed.page.route('**/current', async (route) => {
		currentEntered.resolve();
		await currentRelease.promise;
		await route.continue();
	});
	await delayed.page.goto(appOrigin);
	await opened(delayed.page);
	await currentEntered.promise;
	await delayed.page.evaluate(async (baseUrl) => {
		const { app, local } = globalThis.observedWhispering;
		const { connections } = await app.inference;
		const id = await connections.add({
			name: 'Deterministic fixture',
			baseUrl,
			models: ['fixture-model'],
		});
		await app.catalog.ready;
		local.kv.update({
			transcriptionConnection: id,
			transcriptionModel: 'fixture-model',
		});
	}, `${inference.url.origin}/v1`);
	const inferenceBefore = inferenceRequests.length;
	const delayedRecording = await capture(delayed.page);
	assert.equal(inferenceRequests.length, inferenceBefore);
	currentRelease.resolve();
	await eventually(
		() => inferenceRequests.length > inferenceBefore,
		'inference after Personal readiness',
	);
	assert.equal(
		inferenceRequests.at(-1).prompt,
		'Captured account prompt Ephemeris',
	);
	await eventually(
		() =>
			delayed.page.evaluate(
				(id) =>
					globalThis.observedWhispering.local.tables.recordings.get(id)
						?.transcript === 'Deterministic fixture transcript',
				delayedRecording.id,
			),
		'Local transcript persistence',
	);
	console.log(
		'PASS Local capture during delayed Personal; inference waits for captured account prompt/dictionary',
	);

	// The deliberate Personal transcription reads Personal bytes and retries only text persistence.
	await second.page.evaluate(async (baseUrl) => {
		const { app, local } = globalThis.observedWhispering;
		const { connections } = await app.inference;
		const id = await connections.add({
			name: 'Fixture',
			baseUrl,
			models: ['fixture-model'],
		});
		await app.catalog.ready;
		local.kv.update({
			transcriptionConnection: id,
			transcriptionModel: 'fixture-model',
		});
		await local.persistence.flush();
	}, `${inference.url.origin}/v1`);
	const secondTextBefore = inferenceRequests.length;
	await second.page.evaluate(() => {
		const put = IDBObjectStore.prototype.put;
		globalThis.blockWrites = true;
		IDBObjectStore.prototype.put = function (...args) {
			if (globalThis.blockWrites && this.name === 'updates')
				throw new DOMException('Fixture disk full', 'QuotaExceededError');
			return put.apply(this, args);
		};
	});
	await second.page
		.getByRole('button', {
			name: 'Start transcribing this recording',
			exact: true,
		})
		.first()
		.click();
	await second.page
		.getByRole('button', { name: 'Finish saving', exact: true })
		.waitFor();
	assert.equal(inferenceRequests.length, secondTextBefore + 1);
	await second.page
		.getByRole('link', { name: 'Local recordings', exact: true })
		.click();
	await second.page.evaluate(() => {
		globalThis.blockWrites = false;
	});
	await second.page
		.getByRole('button', { name: 'Finish saving', exact: true })
		.click();
	await eventually(
		() =>
			second.page
				.getByRole('button', { name: 'Finish saving', exact: true })
				.count()
				.then((n) => n === 0),
		'transcript persistence retry',
	);
	assert.equal(inferenceRequests.length, secondTextBefore + 1);
	assert.equal(
		await second.page.evaluate(
			() => globalThis.observedWhispering.local.tables.recordings.rows.length,
		),
		0,
	);
	assert(
		await second.page.evaluate(async () =>
			(
				await globalThis.observedWhispering.app.personalReady
			).tables.recordings.rows.some(
				(row) => row.transcript === 'Deterministic fixture transcript',
			),
		),
	);
	console.log(
		'PASS actual Personal transcription persists to Personal, text retry survives route change without inference',
	);
	// Import through the actual Home file input with Personal unavailable.
	const failed = await newPage(authState);
	await failed.page.route('**/current', (route) =>
		route.fulfill({ status: 503, body: 'fixture unavailable' }),
	);
	await failed.page.goto(appOrigin);
	await opened(failed.page);
	const failedCaptured = await capture(failed.page);
	const wav = new Uint8Array(44 + 3200);
	const wavView = new DataView(wav.buffer);
	const ascii = (offset, text) => {
		for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i);
	};
	ascii(0, 'RIFF');
	wavView.setUint32(4, wav.length - 8, true);
	ascii(8, 'WAVEfmt ');
	wavView.setUint32(16, 16, true);
	wavView.setUint16(20, 1, true);
	wavView.setUint16(22, 1, true);
	wavView.setUint32(24, 16000, true);
	wavView.setUint32(28, 32000, true);
	wavView.setUint16(32, 2, true);
	wavView.setUint16(34, 16, true);
	ascii(36, 'data');
	wavView.setUint32(40, 3200, true);
	await failed.page
		.getByRole('radio', { name: 'Switch to upload file', exact: true })
		.click();
	await failed.page.locator('input[type=file]').setInputFiles({
		name: 'isolated-import.wav',
		mimeType: 'audio/wav',
		buffer: Buffer.from(wav),
	});
	await eventually(
		() =>
			failed.page.evaluate(
				() =>
					globalThis.observedWhispering.local.tables.recordings.rows.length ===
					2,
			),
		'Local import with failed Personal',
	);
	console.log(
		'PASS actual capture and file import remain Local when Personal acquisition fails',
	);
	// Deliberate sign-out fences an upload before a held navigation completes.
	await alice.page
		.getByRole('link', { name: 'Local recordings', exact: true })
		.click();
	const lateEntered = Promise.withResolvers();
	const lateRelease = Promise.withResolvers();
	await alice.page.route('**/blobs', async (route) => {
		if (route.request().method() === 'POST') {
			lateEntered.resolve();
			await lateRelease.promise;
		}
		await route.continue().catch(() => {});
	});
	const countBeforeDeparture = await alice.page.evaluate(
		async () =>
			(await globalThis.observedWhispering.app.personalReady).tables.recordings
				.rows.length,
	);
	await alice.page
		.getByRole('button', { name: 'Save to Personal', exact: true })
		.first()
		.click();
	await Promise.race([
		lateEntered.promise,
		Bun.sleep(15000).then(() => {
			throw Error('Held upload did not start');
		}),
	]);
	console.log('Sign-out fixture: upload held');
	const departureObserved = alice.page.waitForEvent('console', {
		predicate: (message) => message.text() === 'fixture:departure-aborted',
		timeout: 15000,
	});
	await alice.page.evaluate(() => {
		globalThis.observedWhispering.app.signal.addEventListener(
			'abort',
			() => {
				console.log('fixture:departure-aborted');
			},
			{ once: true },
		);
	});
	const navigationEntered = Promise.withResolvers();
	const navigationRelease = Promise.withResolvers();
	await alice.page.route('**/*signout*', async (route) => {
		navigationEntered.resolve();
		await navigationRelease.promise;
		await route.fulfill({ status: 204 });
	});
	await alice.page
		.getByRole('button', { name: 'Account', exact: true })
		.click();
	await alice.page
		.getByRole('button', { name: 'Sign out', exact: true })
		.click();
	await alice.page
		.getByRole('button', { name: 'Continue', exact: true })
		.click({ noWaitAfter: true });
	await Promise.race([
		navigationEntered.promise,
		Bun.sleep(15000).then(() => {
			throw Error('Held sign-out navigation did not start');
		}),
	]);
	console.log('Sign-out fixture: navigation held');
	await departureObserved;
	lateRelease.resolve();
	// Chrome suspends evaluation while a document navigation is pending. Observe
	// abort synchronously before navigation, hold it, then refuse navigation with
	// 204 so the same retired document can expose its final row count.
	await Bun.sleep(300);
	navigationRelease.resolve();
	await alice.page.waitForTimeout(300);
	assert(
		await alice.page.evaluate(
			() => globalThis.observedWhispering.app.signal.aborted,
		),
	);
	assert.equal(
		await alice.page.evaluate(
			async () =>
				(await globalThis.observedWhispering.app.personalReady).tables
					.recordings.rows.length,
		),
		countBeforeDeparture,
	);

	console.log(
		'PASS actual sign-out aborts before stalled navigation and fences late copy publication',
	);
	writeFileSync(
		join(evidence, 'result.json'),
		JSON.stringify(
			{
				captured,
				aliceRecording,
				copied,
				pendingIds,
				pageErrors,
				limits: [
					'Synthetic microphone, not physical',
					'S3 fixture, not production',
					'Deterministic inference fixture, not model accuracy',
				],
				checks:
					'Local capture/import/reload with Personal absent/delayed/failed; Personal provider/copy/playback/expiry/transcription/retry/second client; sign-out with held upload/navigation',
			},
			null,
			2,
		),
	);
	assert.deepEqual(pageErrors, []);
	console.log(`Evidence: ${evidence}`);
} catch (error) {
	writeFileSync(join(evidence, 'failure.txt'), String(error.stack ?? error));
	for (const [i, context] of (browser?.contexts() ?? []).entries())
		for (const page of context.pages()) {
			writeFileSync(
				join(evidence, `page-${i}.txt`),
				await page
					.locator('body')
					.innerText()
					.catch(() => ''),
			);
		}
	throw error;
} finally {
	writeFileSync(join(evidence, 'servers.log'), logs.join(''));
	await browser?.close();
	await proxy?.dispose();
	await s3.stop(true);
	await inference.stop(true);
	for (const child of children) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {}
	}
	rmSync(directory, { recursive: true, force: true });
	console.log(`Evidence directory: ${evidence}`);
}
