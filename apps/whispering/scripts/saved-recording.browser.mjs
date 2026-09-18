/**
 * Actual Whispering UI, synthetic speech microphone, real native Whisper Tiny,
 * and optional real Ollama Polish. Requires an existing speech WAV and cached
 * native model. Run from root with EPICENTER_NATIVE_AUDIO=/path/speech.wav bun
 * apps/whispering/scripts/saved-recording.browser.mjs. No models are downloaded.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeAiFixture } from '../../../packages/app/scripts/native-ai-fixture.js';

const root = join(import.meta.dir, '../../..');
const { chromium } = createRequire(
	new URL('../../../packages/app/package.json', import.meta.url),
)('playwright');
const { getPlatformProxy } = createRequire(
	new URL('../../self-host/package.json', import.meta.url),
)('wrangler');
const audioPath =
	process.env.EPICENTER_NATIVE_AUDIO ??
	'/tmp/app-ai-baseline/native-speech.wav';
assert(
	await Bun.file(audioPath).exists(),
	'Set EPICENTER_NATIVE_AUDIO to an existing speech WAV',
);
const nativeModel =
	'handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf';
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
	`import config from ${JSON.stringify(join(root, 'apps/whispering/vite.config.ts'))};\nexport default { ...config, server: { ...config.server, watch: null, hmr: false, fs: { ...config.server?.fs, allow: [...(config.server?.fs?.allow ?? []), ${JSON.stringify(root)}, ${JSON.stringify(dependencyCache)}] } } };\n`,
);
const children = [];
const logs = [];
const pages = [];
const pageErrors = [];
const inferenceRequests = [];
const blockedExternalRequests = [];
const report = {
	kind: 'actual Whispering UI acceptance',
	at: new Date().toISOString(),
	recordings: {},
	checks: {},
	limits: [
		'Chromium uses a speech WAV as microphone input; MediaRecorder and saved recording controls are real.',
		'Transcription uses real native decoding and cached Whisper Tiny through a temporary authenticated endpoint and Tauri MockRuntime.',
		'Packaged native capture and S3 transfer are not exercised by this UI run.',
	],
};
let browser, proxy, inference, fixture;
function start(args, cwd = root) {
	const child = spawn('bun', args, {
		cwd,
		detached: true,
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
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
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {}
		assert.equal(child.exitCode, null, `Development server exited: ${url}`);
		await Bun.sleep(100);
	}
	throw new Error(`Development server did not start: ${url}`);
}
async function eventually(check, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
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
	fixture = await createNativeAiFixture({ audioPath, timeoutMs: 600_000 });
	let polishModel = null;
	try {
		const response = await fetch('http://127.0.0.1:11434/api/tags', {
			signal: AbortSignal.timeout(2000),
		});
		if (response.ok)
			polishModel =
				(await response.json()).models.find(
					(model) => model.name === 'qwen2.5vl:3b',
				)?.name ?? null;
	} catch {}
	report.polish = polishModel
		? { engine: 'real local Ollama', model: polishModel }
		: {
				engine: 'not exercised',
				reason: 'The expected existing Ollama model is unavailable.',
			};
	const apiKey = crypto.randomUUID();
	inference = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		idleTimeout: 180,
		async fetch(request) {
			const origin = request.headers.get('origin');
			if (origin !== null && origin !== appOrigin)
				return new Response('Origin refused', { status: 403 });
			const cors = {
				'access-control-allow-origin': appOrigin,
				'access-control-allow-headers':
					request.headers.get('access-control-request-headers') ??
					'authorization, content-type',
				'access-control-allow-methods': 'GET, POST, OPTIONS',
				vary: 'Origin',
			};
			if (request.method === 'OPTIONS')
				return new Response(null, { status: 204, headers: cors });
			if (request.headers.get('authorization') !== `Bearer ${apiKey}`)
				return new Response('Bearer refused', { status: 401, headers: cors });
			const path = new URL(request.url).pathname;
			let response;
			let observed;
			try {
				if (path === '/v1/chat/completions' && polishModel) {
					const body = await request.json();
					assert.equal(
						body.model,
						polishModel,
						'Polish retained its explicit model',
					);
					observed = {
						operation: 'polish',
						model: body.model,
						authenticated: true,
					};
					inferenceRequests.push(observed);
					response = await fetch(`http://127.0.0.1:11434${path}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						signal: request.signal,
					});
				} else {
					if (path === '/v1/audio/transcriptions') {
						const form = await request.clone().formData();
						const file = form.get('file');
						assert(file instanceof File, 'SDK uploaded actual audio');
						observed = {
							operation: 'transcription',
							model: form.get('model'),
							byteLength: file.size,
							contentType: file.type,
							sha256: new Bun.CryptoHasher('sha256')
								.update(await file.arrayBuffer())
								.digest('hex'),
							authenticated: true,
						};
						inferenceRequests.push(observed);
					}
					response = await fixture.transport.fetch(
						new Request(
							`${fixture.transport.baseURL}${path.replace(/^\/v1/, '')}`,
							request,
						),
					);
				}
			} catch (error) {
				response = Response.json(
					{ error: { message: error.message } },
					{ status: 500 },
				);
			}
			if (observed) {
				observed.status = response.status;
				if (!response.ok) observed.error = await response.clone().text();
			}
			const headers = new Headers(response.headers);
			for (const [key, value] of Object.entries(cors)) headers.set(key, value);
			return new Response(response.body, { status: response.status, headers });
		},
	});
	const inferenceUrl = `${inference.url.origin}/v1`;
	assert.equal((await fetch(`${inferenceUrl}/models`)).status, 401);
	assert.equal(
		(
			await fetch(`${inferenceUrl}/models`, {
				headers: {
					origin: 'https://foreign.invalid',
					authorization: `Bearer ${apiKey}`,
				},
			})
		).status,
		403,
	);
	report.checks.inferenceBearerAndOriginEnforced = true;
	browser = await chromium.launch({
		headless: true,
		args: [
			'--use-fake-device-for-media-stream',
			'--use-fake-ui-for-media-stream',
			`--use-file-for-fake-audio-capture=${audioPath}`,
			'--autoplay-policy=no-user-gesture-required',
		],
	});
	async function newPage(name) {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 1000 },
			permissions: ['clipboard-read', 'clipboard-write'],
		});
		const allowed = new Set([appOrigin, workerOrigin, inference.url.origin]);
		await context.route('**/*', (route) => {
			const url = new URL(route.request().url());
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				allowed.has(url.origin)
			)
				return route.continue();
			blockedExternalRequests.push(`${url.origin}${url.pathname}`);
			return route.abort();
		});
		await context.routeWebSocket('**/*', (socket) => {
			const url = new URL(socket.url());
			url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:';
			if (allowed.has(url.origin)) socket.connectToServer();
			else {
				blockedExternalRequests.push(`${url.origin}${url.pathname}`);
				socket.close();
			}
		});
		const page = await context.newPage();
		pages.push(page);
		page.setDefaultTimeout(45_000);
		page.on('pageerror', (error) =>
			pageErrors.push(`${name}: ${error.stack ?? error.message}`),
		);
		return { page, context };
	}
	async function opened(page, library) {
		const label = library === 'Local' ? 'On this device' : `${library} library`;
		await page
			.getByRole('button', { name: `Recording library: ${label}`, exact: true })
			.waitFor();
		await eventually(
			() =>
				page.evaluate(async (library) => {
					const { app, library: actual } = await import(
						'/src/lib/bootstrap.ts'
					);
					return (
						actual === library.toLowerCase() &&
						app !== null &&
						(await app.ready).error === null
					);
				}, library),
			`${library} App readiness`,
		);
	}
	async function savedAiChoices(page) {
		return page.evaluate(
			async ({ apiKey, nativeModel, polishModel }) => {
				const { app, selections } = await import('/src/lib/bootstrap.ts');
				const records = JSON.parse(
					localStorage.getItem('whispering.app-ai-connections'),
				);
				const choices = JSON.parse(
					localStorage.getItem('whispering.app-ai-selections'),
				);
				if (
					records?.version !== 1 ||
					choices?.version !== 1 ||
					Object.keys(records).sort().join() !== 'connections,version' ||
					Object.keys(choices).sort().join() !== 'selections,version' ||
					'configuration' in app.device.connections ||
					'configured' in app.device.connections
				)
					throw new Error(
						'AI settings did not use separate connection and selection owners.',
					);
				for (const [scope, model] of [
					['transcription', nativeModel],
					['completion', polishModel],
				]) {
					if (!model) continue;
					const target = choices.selections[scope];
					const saved = records.connections.find(
						(record) => record.id === target?.connectionId,
					);
					if (
						!saved ||
						target.model !== model ||
						saved.apiKey !== apiKey ||
						'client' in saved ||
						JSON.stringify(selections.get(scope)) !== JSON.stringify(target) ||
						!app.device.connections.custom.get(saved.id)?.client
					)
						throw new Error(
							'Saved AI choice does not identify its exact custom connection and model.',
						);
				}
				return choices.selections;
			},
			{ apiKey, nativeModel, polishModel },
		);
	}
	async function configure(page, reuse = false) {
		await page.goto(`${appOrigin}/settings/processing`);
		await page
			.getByText('Text connection and model', { exact: true })
			.waitFor();
		async function choose(index, model, name) {
			const trigger = page
				.locator('[data-slot="field"]')
				.filter({
					has: page.getByText(
						index === 0
							? 'Transcription connection and model'
							: 'Text connection and model',
						{ exact: true },
					),
				})
				.getByRole('combobox');
			await trigger.click();
			const popup = page.locator(
				'[data-slot="popover-content"][data-state="open"]',
			);
			if (reuse) {
				await popup
					.locator('[data-slot="command-group"]')
					.filter({ has: page.getByText(name, { exact: true }) })
					.getByRole('option', { name: model, exact: true })
					.click();
				return;
			}
			await popup
				.getByRole('option', { name: 'Connect a provider...', exact: true })
				.click();
			await popup
				.getByRole('option', { name: 'Custom URL', exact: true })
				.click();
			await popup.locator('#conn-name').fill(name);
			await popup.locator('#conn-url').fill(inferenceUrl);
			await popup.locator('#conn-key').fill(apiKey);
			await popup
				.getByRole('textbox', { name: 'Model ID', exact: true })
				.fill(model);
			await popup.getByRole('button', { name: 'Add', exact: true }).click();
		}
		await choose(0, nativeModel, 'Native speech acceptance');
		if (polishModel) await choose(1, polishModel, 'Local Polish acceptance');
		await savedAiChoices(page);
		console.log('Configured explicit transcription and text models');
		await page.getByRole('link', { name: 'Home', exact: true }).click();
		await page.getByRole('button', { name: /^Start recording/ }).waitFor();
	}
	async function snapshot(page) {
		return page.evaluate(async () => {
			const { app, data, library, account } = await import(
				'/src/lib/bootstrap.ts'
			);
			const row = data.tables.recordings.rows.toSorted((a, b) =>
				b.recordedAt.localeCompare(a.recordedAt),
			)[0];
			if (row?.transcriptionStatus === 'failed')
				throw new Error(row.transcriptionError ?? 'Saved transcription failed');
			if (!row) return null;
			const saved = await app.blobs.local.get(row.audioBlobId);
			if (saved.error) throw new Error(JSON.stringify(saved.error));
			const bytes = await saved.data.arrayBuffer();
			const hash = await crypto.subtle.digest('SHA-256', bytes);
			const context = new AudioContext();
			let decodedDuration;
			try {
				decodedDuration = (await context.decodeAudioData(bytes)).duration;
			} finally {
				await context.close();
			}
			return {
				row: {
					id: row.id,
					audioBlobId: row.audioBlobId,
					transcript: row.transcript,
					polishedTranscript: row.polishedTranscript,
					transcriptionStatus: row.transcriptionStatus,
				},
				library,
				actor: account?.principalId ?? null,
				byteLength: saved.data.size,
				contentType: saved.data.type,
				sha256: Array.from(new Uint8Array(hash), (byte) =>
					byte.toString(16).padStart(2, '0'),
				).join(''),
				decodedDuration,
			};
		});
	}
	async function capture(page, scope) {
		const beforeRequests = inferenceRequests.length;
		console.log('Starting actual recording', scope);
		await page.getByRole('button', { name: /^Start recording/ }).click();
		await page
			.getByRole('button', { name: /^Stop recording/, pressed: true })
			.waitFor();
		await Bun.sleep(4300);
		await page
			.getByRole('button', { name: /^Stop recording/, pressed: true })
			.click();
		console.log('Waiting for real inference', scope);
		await eventually(
			() =>
				page.evaluate(async (polish) => {
					const { data } = await import('/src/lib/bootstrap.ts');
					const row = data.tables.recordings.rows.toSorted((a, b) =>
						b.recordedAt.localeCompare(a.recordedAt),
					)[0];
					if (row?.transcriptionStatus === 'failed')
						throw new Error(
							row.transcriptionError ?? 'Saved transcription failed',
						);
					return (
						row?.transcript.trim().length > 0 &&
						(!polish || row.polishedTranscript?.trim().length > 0)
					);
				}, polishModel !== null),
			`${scope} saved transcript and Polish`,
			150_000,
		);
		const saved = await snapshot(page);
		assert(saved.row.transcript.trim().length > 0);
		assert(saved.byteLength > 1000);
		assert(saved.decodedDuration > 3);
		const visible = await page
			.getByRole('textbox', { name: 'Click to view transcript', exact: true })
			.inputValue();
		assert.equal(visible, saved.row.polishedTranscript ?? saved.row.transcript);
		const player = page.locator('audio').first();
		await player.waitFor();
		await player.evaluate((audio) => audio.play());
		await page.waitForFunction(
			() => document.querySelector('audio')?.currentTime > 0.1,
		);
		await player.evaluate((audio) => audio.pause());
		const transcription = inferenceRequests
			.slice(beforeRequests)
			.find((request) => request.operation === 'transcription');
		assert(
			transcription,
			'Actual UI reached the authenticated native endpoint',
		);
		assert.equal(transcription.model, nativeModel);
		assert.equal(
			transcription.sha256,
			saved.sha256,
			'SDK uploaded the exact saved recording bytes',
		);
		if (polishModel)
			assert(
				inferenceRequests
					.slice(beforeRequests)
					.some(
						(request) =>
							request.operation === 'polish' && request.model === polishModel,
					),
			);
		await page.mouse.move(1200, 20);
		await page.screenshot({
			path: join(evidence, `${scope}.png`),
			fullPage: true,
		});
		const choicesBeforeReload = await savedAiChoices(page);
		await page.evaluate(async () =>
			(await import('/src/lib/bootstrap.ts')).departure.close(),
		);
		await page.reload();
		await opened(page, scope);
		assert.deepEqual(await savedAiChoices(page), choicesBeforeReload);
		report.checks.separateAiStoresSurviveReload = true;
		await page
			.getByRole('textbox', { name: 'Click to view transcript', exact: true })
			.waitFor();
		const reopened = await snapshot(page);
		assert.equal(reopened.sha256, saved.sha256);
		assert.deepEqual(reopened.row, saved.row);
		report.recordings[scope.toLowerCase()] = {
			...saved,
			played: true,
			reopened: true,
		};
		console.log(
			`PASS actual Whispering ${scope}: record, native transcript${polishModel ? ', Ollama Polish' : ''}, playback, exact uploaded bytes and reopen`,
		);
	}
	const { page: local } = await newPage('local');
	await local.goto(appOrigin);
	await opened(local, 'Local');
	await configure(local);
	await capture(local, 'Local');
	assert.equal(report.recordings.local.actor, null);
	const grant = await proxy.env.OPERATOR.admit({ id: 'alice', name: 'Alice' });
	const { page: alice, context } = await newPage('alice');
	const cdp = await context.newCDPSession(alice);
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
	await alice.goto(grant.url);
	await alice.click('#continue');
	await alice.getByRole('heading', { name: 'You are signed in' }).waitFor();
	await alice.goto(`${appOrigin}/?connect`);
	await alice.getByText('Connect to your server', { exact: true }).click();
	await alice
		.getByPlaceholder('https://your-server.example')
		.fill(workerOrigin);
	await alice.getByRole('button', { name: 'Connect', exact: true }).click();
	await alice
		.getByRole('button', { name: 'Sign in to your server', exact: true })
		.click();
	await alice.waitForURL(`${appOrigin}/`);
	await opened(alice, 'Personal');
	await configure(alice);
	await capture(alice, 'Personal');
	assert.equal(report.recordings.personal.actor, 'alice');
	await alice.evaluate(async () => {
		const module = await import('/src/lib/bootstrap.ts');
		module.departure.onChange(() => {
			if (module.departure.state.phase === 'closed')
				sessionStorage.setItem('closed-library', module.library);
		});
	});
	await alice
		.getByRole('button', {
			name: 'Recording library: Personal library',
			exact: true,
		})
		.click();
	await alice
		.getByRole('menuitemradio', { name: 'Shared library', exact: true })
		.click();
	await opened(alice, 'Shared');
	assert.equal(
		await alice.evaluate(() => sessionStorage.getItem('closed-library')),
		'personal',
	);
	await configure(alice, true);
	await capture(alice, 'Shared');
	assert.equal(report.recordings.shared.actor, 'alice');
	report.checks.closedBeforeLibrarySwitch = true;
	report.inferenceRequests = inferenceRequests;
	report.blockedExternalRequests = blockedExternalRequests;
	report.nativeCommands = fixture.admitted;
	for (const page of pages)
		await page.evaluate(async () =>
			(await import('/src/lib/bootstrap.ts')).departure.close(),
		);
	assert.equal(
		pageErrors.length,
		0,
		'Unexpected browser errors; see failure.json',
	);
	report.nativeCleanup = await fixture.close();
	fixture = undefined;
	report.passed = true;
	writeFileSync(join(evidence, 'result.json'), JSON.stringify(report, null, 2));
	console.log(`Evidence: ${join(evidence, 'result.json')}`);
} catch (error) {
	for (const [index, page] of pages.entries()) {
		if (page.isClosed()) continue;
		writeFileSync(
			join(evidence, `failure-${index}.txt`),
			await page
				.locator('body')
				.innerText()
				.catch(() => 'unavailable'),
		);
		await page
			.screenshot({
				path: join(evidence, `failure-${index}.png`),
				fullPage: true,
			})
			.catch(() => {});
	}
	writeFileSync(
		join(evidence, 'failure.json'),
		JSON.stringify(
			{
				message: String(error),
				pageErrors,
				inferenceRequests,
				report,
				nativeCommands: fixture?.admitted,
			},
			null,
			2,
		),
	);
	console.error(
		`Failure evidence: ${evidence}; ${pageErrors.length} browser errors`,
	);
	if (process.env.SMOKE_VERBOSE) console.error(logs.join('\n'));
	throw error;
} finally {
	writeFileSync(join(evidence, 'servers.log'), logs.join('\n'));
	try {
		await browser?.close();
	} finally {
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
		try {
			await inference?.stop(true);
			await fixture?.close();
		} finally {
			try {
				await proxy?.dispose();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		}
	}
}
