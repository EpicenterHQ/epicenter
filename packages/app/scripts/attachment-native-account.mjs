/** Disposable authenticated self-host fixture for native attachment acceptance.
 * The HTTP object fixture is not a conforming S3 provider or a SigV4 verifier.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
	connect as connectTcp,
	createServer as createTcpServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { recordingObjectFixture } from './recording-object-fixture.mjs';

const root = resolve(import.meta.dir, '../../..');
const { getPlatformProxy } = createRequire(
	new URL('../../../apps/self-host/package.json', import.meta.url),
)('wrangler');

async function reserveOrigin() {
	const server = Bun.serve({
		hostname: 'localhost',
		port: 0,
		fetch: () => new Response(),
	});
	const origin = server.url.origin;
	await server.stop(true);
	return origin;
}

/** Real passkey enrollment and two independent session handoffs for one principal.
 * Credentials stay in memory. The caller owns any native keychain installation.
 */
export async function startNativeAccountFixture({ directory } = {}) {
	const ownedDirectory = !directory;
	directory ??= await mkdtemp(join(tmpdir(), 'attachment-account-'));
	await mkdir(directory, { recursive: true });
	const workerOrigin = await reserveOrigin();
	const browserOrigin = await reserveOrigin();
	const objects = recordingObjectFixture(directory, browserOrigin);
	const objectRequests = [];
	const heldDownloads = new Set();
	let downloadsHeld = false;
	const objectFront = Bun.serve({
		hostname: 'localhost',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const entry = {
				method: request.method,
				path: url.pathname,
				held: downloadsHeld && request.method === 'GET',
				aborted: false,
				uploadContentType: request.headers.get('content-type'),
				responseStatus: null,
				responseContentType: null,
			};
			objectRequests.push(entry);
			if (entry.held) {
				await new Promise((resolve) => {
					const release = () => {
						heldDownloads.delete(release);
						request.signal.removeEventListener('abort', abort);
						resolve();
					};
					const abort = () => {
						entry.aborted = true;
						release();
					};
					heldDownloads.add(release);
					request.signal.addEventListener('abort', abort, { once: true });
					if (request.signal.aborted) abort();
				});
			}
			if (request.signal.aborted) {
				entry.responseStatus = 499;
				return new Response(null, { status: 499 });
			}
			const destination = new URL(
				url.pathname + url.search,
				objects.server.url,
			);
			try {
				const response = await fetch(new Request(destination, request), {
					redirect: 'manual',
				});
				entry.responseStatus = response.status;
				entry.responseContentType = response.headers.get('content-type');
				return response;
			} catch {
				entry.responseStatus = 503;
				return new Response(null, { status: 503 });
			}
		},
	});
	function holdDownloads(value) {
		downloadsHeld = value;
		if (!value) for (const release of heldDownloads) release();
	}
	const authorityRequests = [];
	const sockets = new Set();
	let offline = false;
	let worker, operator, browser, vite;
	let workerExited;
	let closed = false;
	let phase = 'Worker startup';
	// Keep the wire unchanged. Observe HTTP framing on each connection until
	// its WebSocket upgrade; bodies must never be mistaken for new requests.
	const front = createTcpServer((socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		let pending = Buffer.alloc(0);
		let framing = 'headers';
		let remaining = 0;
		function observe(chunk) {
			if (framing === 'websocket') return;
			pending = Buffer.concat([pending, chunk]);
			while (pending.length) {
				if (framing === 'body' || framing === 'chunk-body') {
					const consumed = Math.min(remaining, pending.length);
					pending = pending.subarray(consumed);
					remaining -= consumed;
					if (remaining) return;
					framing = framing === 'body' ? 'headers' : 'chunk-end';
					continue;
				}
				if (framing === 'chunk-end') {
					if (pending.length < 2) return;
					pending = pending.subarray(2);
					framing = 'chunk-size';
					continue;
				}
				if (framing === 'chunk-size') {
					const end = pending.indexOf('\r\n');
					if (end < 0) return;
					remaining = Number.parseInt(
						pending.subarray(0, end).toString().split(';')[0],
						16,
					);
					if (!Number.isSafeInteger(remaining) || remaining < 0) {
						socket.destroy();
						return;
					}
					pending = pending.subarray(end + 2);
					framing = remaining ? 'chunk-body' : 'trailers';
					continue;
				}
				if (framing === 'trailers') {
					const end = pending.indexOf('\r\n');
					if (end < 0) return;
					pending = pending.subarray(end + 2);
					if (end === 0) framing = 'headers';
					continue;
				}
				const boundary = pending.indexOf('\r\n\r\n');
				if (boundary < 0) {
					if (pending.length > 64 * 1024) socket.destroy();
					return;
				}
				const lines = pending.subarray(0, boundary).toString().split('\r\n');
				pending = pending.subarray(boundary + 4);
				const [method, path] = lines[0].split(' ');
				authorityRequests.push({
					method,
					path: new URL(path, workerOrigin).pathname,
					offline,
				});
				if (offline) {
					socket.end(
						'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
					);
					framing = 'websocket';
					pending = Buffer.alloc(0);
					return;
				}
				if (lines.some((line) => /^upgrade:\s*websocket$/i.test(line))) {
					framing = 'websocket';
					pending = Buffer.alloc(0);
					return;
				}
				if (lines.some((line) => /^transfer-encoding:.*chunked/i.test(line)))
					framing = 'chunk-size';
				else {
					remaining = Number(
						lines
							.find((line) => /^content-length:/i.test(line))
							?.split(':')[1] ?? 0,
					);
					if (!Number.isSafeInteger(remaining) || remaining < 0) {
						socket.destroy();
						return;
					}
					framing = remaining ? 'body' : 'headers';
				}
			}
		}
		socket.on('data', observe);
		if (offline) return;
		const peer = connectTcp({
			host: 'localhost',
			port: Number(new URL(workerOrigin).port),
		});
		sockets.add(peer);
		peer.on('close', () => {
			sockets.delete(peer);
			socket.destroy();
		});
		peer.on('error', () => socket.destroy());
		socket.on('close', () => peer.destroy());
		peer.pipe(socket);
		socket.pipe(peer);
	});
	await new Promise((resolve, reject) => {
		front.once('error', reject);
		front.listen(0, 'localhost', resolve);
	});
	const serverUrl = `http://localhost:${front.address().port}`;
	function setOffline(value) {
		offline = value;
		if (value) for (const socket of sockets) socket.destroy();
	}

	async function close() {
		if (closed) return;
		closed = true;
		setOffline(true);
		holdDownloads(false);
		const failures = [];
		for (const cleanup of [
			() => browser?.close(),
			() => vite?.close(),
			() => operator?.dispose(),
		]) {
			try {
				await cleanup();
			} catch (error) {
				failures.push(error);
			}
		}
		if (worker?.pid && worker.exitCode === null && worker.signalCode === null) {
			try {
				process.kill(-worker.pid, 'SIGTERM');
			} catch (error) {
				if (error.code !== 'ESRCH') failures.push(error);
			}
			await Promise.race([workerExited, Bun.sleep(1000)]);
			if (worker.exitCode === null && worker.signalCode === null) {
				try {
					process.kill(-worker.pid, 'SIGKILL');
				} catch (error) {
					if (error.code !== 'ESRCH') failures.push(error);
				}
			}
		}
		await workerExited;

		await new Promise((resolve, reject) =>
			front.close((error) => (error ? reject(error) : resolve())),
		);
		await objectFront.stop(true);
		await objects.server.stop(true);
		if (ownedDirectory) await rm(directory, { recursive: true, force: true });
		if (failures.length)
			throw new AggregateError(failures, 'Account fixture cleanup failed');
	}
	try {
		const workerName = `native-attachment-${crypto.randomUUID()}`;
		const workerConfig = join(directory, 'worker.json');
		const operatorConfig = join(directory, 'operator.json');
		await writeFile(
			workerConfig,
			JSON.stringify({
				name: workerName,
				main: join(root, 'apps/self-host/worker/index.ts'),
				compatibility_date: '2026-03-06',
				compatibility_flags: ['nodejs_compat', 'enable_request_signal'],
				send_metrics: false,
				vars: {
					API_PUBLIC_ORIGIN: serverUrl,
					SELF_HOST_CALLBACKS: JSON.stringify([
						`${browserOrigin}/auth/callback`,
					]),
					TRUSTED_BROWSER_ORIGINS: browserOrigin,
					BLOBS_S3_ENDPOINT: objectFront.url.origin,
					BLOBS_S3_ACCESS_KEY_ID: 'acceptance-key',
					BLOBS_S3_SECRET_ACCESS_KEY: 'acceptance-secret',
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
		await writeFile(
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
				stdio: ['ignore', 'ignore', 'ignore'],
			},
		);
		workerExited = new Promise((resolve) => {
			worker.once('exit', resolve);
			worker.once('error', resolve);
		});
		let ready = false;
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				if (
					(await fetch(serverUrl, { signal: AbortSignal.timeout(1000) })).ok
				) {
					ready = true;
					break;
				}
			} catch {}
			assert.equal(
				worker.exitCode,
				null,
				'Disposable Worker exited before readiness',
			);
			await Bun.sleep(100);
		}
		assert(ready, 'Disposable Worker did not become ready');
		operator = await getPlatformProxy({
			configPath: operatorConfig,
			persist: false,
			remoteBindings: false,
		});
		const appId = 'so.epicenter.native-account-enrollment';
		const html = `<!doctype html><title>Disposable account enrollment</title><script type="module">
			import { createBrowserRedirectAuth } from '/packages/auth/src/browser-redirect-auth.ts';
			import { normalizeInstanceServer } from '/packages/auth/src/index.ts';
			window.auth = createBrowserRedirectAuth({ appId: ${JSON.stringify(appId)}, ...normalizeInstanceServer(${JSON.stringify(serverUrl)}) });
			if (location.pathname === '/auth/callback') { const result = await auth.completeSignIn(); if(result.error) throw result.error; location.replace('/'); }
			else document.documentElement.dataset.ready = 'true';
		</script>`;
		vite = await createServer({
			configFile: false,
			root,
			server: {
				host: 'localhost',
				port: Number(new URL(browserOrigin).port),
				strictPort: true,
				watch: null,
			},
			plugins: [
				{
					name: 'native-account-enrollment',
					configureServer(server) {
						server.middlewares.use((request, response, next) => {
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
		await vite.listen();
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext();
		const page = await context.newPage();
		page.setDefaultTimeout(30_000);
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
		phase = 'passkey enrollment';
		const grant = await operator.env.OPERATOR.admit({
			id: 'native-acceptance',
			name: 'Native acceptance',
		});
		await page.goto(grant.url);
		await page.click('#continue');
		await page.getByRole('heading', { name: 'You are signed in' }).waitFor();
		const authCells = {};
		for (const client of ['A', 'B']) {
			phase = `session handoff ${client}`;
			await page.goto(browserOrigin);
			await page.waitForFunction(
				() => document.documentElement.dataset.ready === 'true',
			);
			// Remove only this disposable app's cached credential. A new handoff
			// issues a separate session without revoking the first native client.
			await page.evaluate(
				(key) => localStorage.removeItem(key),
				`${appId}.auth.persisted:${serverUrl}`,
			);
			await page.reload();
			await page.waitForFunction(
				() => document.documentElement.dataset.ready === 'true',
			);
			await page.evaluate(async () => {
				const result = await auth.startSignIn();
				if (result.error) throw result.error;
			});
			await page.waitForURL(`${browserOrigin}/`);
			await page.waitForFunction(
				() => window.auth?.state.status === 'signed-in',
			);
			const serialized = await page.evaluate(
				(key) => localStorage.getItem(key),
				`${appId}.auth.persisted:${serverUrl}`,
			);
			assert(serialized, 'Real auth handoff did not persist a session');
			const auth = JSON.parse(serialized);
			assert.equal(auth.principalId, 'native-acceptance');
			const response = await fetch(`${serverUrl}/api/session`, {
				headers: { authorization: `Bearer ${auth.token}` },
			});
			assert.equal(
				response.status,
				200,
				'Real session bearer must be accepted',
			);
			assert.equal((await response.json()).principalId, auth.principalId);
			authCells[client] = JSON.stringify({
				method: 'issuer',
				origin: serverUrl,
				auth,
			});
		}
		assert.notEqual(
			JSON.parse(authCells.A).auth.token,
			JSON.parse(authCells.B).auth.token,
			'Clients must have independently issued sessions',
		);
		await browser.close();
		browser = undefined;
		await vite.close();
		vite = undefined;
		return {
			serverUrl,
			objectOrigin: objectFront.url.origin,
			authCell: authCells.A,
			authCells,
			requests: objectRequests,
			authorityRequests,
			setOffline,
			holdDownloads,
			close,
		};
	} catch (error) {
		await close();
		// Playwright errors include enrollment and callback URLs. Never include
		// their messages or causes in console output or retained evidence.
		throw new Error(
			`Native account fixture failed during ${phase} (${error.name})`,
		);
	}
}

if (import.meta.main) {
	const fixture = await startNativeAccountFixture();
	const { createDesktopAuthAuthority } = await import(
		'../../../apps/epicenter/src/desktop-auth-authority.ts'
	);
	const { CURRENT_ROUTE, STORE_SYNC_ROUTE } = await import('@epicenter/sync');
	const authority = createDesktopAuthAuthority({
		authCell: fixture.authCell,
		nativeAuthPort: {
			completed: new Promise(() => {}),
			onAuthCallback: () => () => {},
			storeAuth: async () => {},
			openAuthUrl: async () => {},
			closeApplications: async () => {},
			resumeApplications: async () => {},
			relaunch() {},
		},
	});
	try {
		assert.equal(authority.bootSnapshot.recovery, false);
		assert.equal(authority.account?.principalId, 'native-acceptance');
		const dataId = 'so.epicenter.native-account-probe';
		const initialized = await authority.account.fetch(
			CURRENT_ROUTE.url(fixture.serverUrl, dataId, 'personal', dataId),
			{
				method: 'POST',
				body: new Uint8Array([0, 0]),
			},
		);
		assert.equal(initialized.status, 200);
		await initialized.arrayBuffer();
		async function connect() {
			const socket = await authority.account.openWebSocket(
				STORE_SYNC_ROUTE.address(fixture.serverUrl, {
					dataId,
					appId: dataId,
					library: 'personal',
					generation: 1,
					cursor: 0,
				}),
			);
			await new Promise((resolve, reject) => {
				const timeout = setTimeout(
					() =>
						reject(
							new Error('Native account socket did not receive initial sync'),
						),
					10_000,
				);
				socket.addEventListener(
					'message',
					() => {
						clearTimeout(timeout);
						resolve();
					},
					{ once: true },
				);
				socket.addEventListener(
					'error',
					() => {
						clearTimeout(timeout);
						reject(new Error('Native account socket failed'));
					},
					{ once: true },
				);
			});
			return socket;
		}
		const socket = await connect();
		const disconnected = new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error('Outage did not close existing sync socket')),
				5_000,
			);
			socket.addEventListener(
				'close',
				() => {
					clearTimeout(timeout);
					resolve();
				},
				{ once: true },
			);
		});
		fixture.setOffline(true);
		await disconnected;
		assert.equal((await fetch(fixture.serverUrl)).status, 503);
		fixture.setOffline(false);
		assert.equal((await fetch(fixture.serverUrl)).status, 200);
		(await connect()).close();
		async function until(predicate) {
			for (let attempt = 0; attempt < 100; attempt++) {
				if (predicate()) return;
				await Bun.sleep(20);
			}
			throw new Error('Held-download fixture condition timed out');
		}
		const ledgerStart = fixture.authorityRequests.length;
		const probe = connectTcp({
			host: 'localhost',
			port: Number(new URL(fixture.serverUrl).port),
		});
		const responseBytes = [];
		probe.on('data', (bytes) => responseBytes.push(bytes));
		const finished = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				probe.destroy();
				reject(new Error('Reused HTTP connection probe timed out'));
			}, 10_000);
			probe.on('end', () => {
				clearTimeout(timeout);
				resolve();
			});
			probe.on('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
		await new Promise((resolve) => probe.once('connect', resolve));
		const falseHeader = 'GET /not-a-request HTTP/1.1\r\n\r\n';
		const fixedPath =
			'/api/libraries/so.epicenter.ledger-fixed/personal/data/so.epicenter.ledger-fixed/current';
		const chunkedPath =
			'/api/libraries/so.epicenter.ledger-chunked/personal/data/so.epicenter.ledger-chunked/current';
		const bearer = JSON.parse(fixture.authCell).auth.token;
		const wire =
			`POST ${fixedPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${bearer}\r\nContent-Length: ${Buffer.byteLength(falseHeader)}\r\n\r\n${falseHeader}` +
			'GET /ledger-third HTTP/1.1\r\nHost: localhost\r\n\r\n' +
			'GET /ledger-fourth HTTP/1.1\r\nHost: localhost\r\n\r\n' +
			`POST ${chunkedPath} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${bearer}\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(falseHeader).toString(16)};probe=yes\r\n${falseHeader}\r\n0\r\nX-Probe: trailer\r\n\r\n`;

		for (let offset = 0; offset < wire.length; offset += 17) {
			probe.write(wire.slice(offset, offset + 17));
			await Bun.sleep(1);
		}
		await finished;
		assert.deepEqual(
			fixture.authorityRequests
				.slice(ledgerStart)
				.map(({ method, path }) => ({ method, path })),
			[
				{ method: 'POST', path: fixedPath },
				{ method: 'GET', path: '/ledger-third' },
				{ method: 'GET', path: '/ledger-fourth' },
				{ method: 'POST', path: chunkedPath },
			],
		);
		assert.equal(
			Buffer.concat(responseBytes)
				.toString()
				.match(/HTTP\/1\.1 \d{3}/g)?.length,
			4,
			'Every request on the reused connection reached the Worker',
		);
		fixture.setOffline(true);
		const offlineProbe = connectTcp({
			host: 'localhost',
			port: Number(new URL(fixture.serverUrl).port),
		});
		let offlineResponse = '';
		offlineProbe.on('data', (bytes) => {
			offlineResponse += bytes.toString();
		});
		const offlineFinished = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				offlineProbe.destroy();
				reject(new Error('Fragmented offline request timed out'));
			}, 5_000);
			offlineProbe.on('end', () => {
				clearTimeout(timeout);
				resolve();
			});
			offlineProbe.on('error', (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
		await new Promise((resolve) => offlineProbe.once('connect', resolve));
		offlineProbe.write('POST /ledger-offline HTTP/1.1\r\nHost: localhost\r\n');
		await Bun.sleep(30);
		assert.equal(
			offlineResponse,
			'',
			'Offline response waits for complete request headers',
		);
		offlineProbe.write('Content-Length: 0\r\n\r\n');
		await offlineFinished;
		assert(offlineResponse.startsWith('HTTP/1.1 503'));
		assert.deepEqual(fixture.authorityRequests.at(-1), {
			method: 'POST',
			path: '/ledger-offline',
			offline: true,
		});
		fixture.setOffline(false);
		fixture.holdDownloads(true);
		const aborted = new AbortController();
		const held = fetch(
			`${fixture.objectOrigin}/hold-probe?X-Amz-Signature=fixture`,
			{ signal: aborted.signal },
		).catch(() => null);
		await until(() =>
			fixture.requests.some(
				(request) => request.path === '/hold-probe' && request.held,
			),
		);
		aborted.abort();
		assert.equal(await held, null);
		await until(() =>
			fixture.requests.some(
				(request) => request.path === '/hold-probe' && request.aborted,
			),
		);
		const released = fetch(
			`${fixture.objectOrigin}/release-probe?X-Amz-Signature=fixture`,
		);
		await until(() =>
			fixture.requests.some(
				(request) => request.path === '/release-probe' && request.held,
			),
		);
		fixture.holdDownloads(false);
		assert.equal(
			(await released).status,
			404,
			'Released GET reaches the empty object fixture',
		);
		assert.equal(
			fixture.requests.find((request) => request.path === '/release-probe')
				.responseStatus,
			404,
		);
	} finally {
		authority[Symbol.dispose]();
		await fixture.close();
	}
	console.log(
		'PASS real passkey enrollment, independent sessions, production desktop authority, authenticated HTTP/WebSocket, outage/reconnect, reused HTTP and fragmented offline request accounting, held GET abort/release and cleanup',
	);
}
