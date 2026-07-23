/**
 * Home Server Tests
 *
 * Verifies the loopback shell around one host session (ADR-0084): the
 * exact Host and Origin checks protect the loopback boundary, Tauri bootstraps
 * HttpOnly browser sessions without a URL token, Home is served at its final
 * route, and the WebSocket drives the single shared chat session.
 *
 * Key behaviors:
 * - The launch token is accepted only by the bootstrap route
 * - Home APIs and WebSockets require an HttpOnly browser session
 * - Home and Whispering serve their builds; Mail and Books stay placeholders
 * - Unknown, non-canonical, and traversal-shaped surface paths stay closed
 * - Host, Origin, CSP, frame, and referrer policies are enforced
 * - Malformed WebSocket frames drop silently without killing the socket
 * - The real vite build emits one document with no external asset references
 * - The spawned `main.ts` sidecar announces versioned readiness, serves the
 *   built SPA, and drives a tool-calling turn against an OpenAI-compatible endpoint
 *
 * See also:
 * - `host.test.ts` for tool catalog composition and turn execution
 * - `packages/client/src/openai-provider.test.ts` for the SSE frame shapes
 *   the fake inference endpoint below reuses
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEngine, EngineChunk } from '@epicenter/agent';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	DESKTOP_RECORD_ATTACHMENT_ROUTE,
	EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
} from '@epicenter/data/desktop-record-owner';
import type { HomeHost, HomeHostInputs } from './host.ts';
import {
	ACCOUNT_INSTANCE_ROUTE,
	ACCOUNT_PROFILE_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	BOOKS_ROUTE,
	BOOTSTRAP_ROUTE,
	HOME_DATA_OVERVIEW_ROUTE,
	HOME_PROPOSALS_ROUTE,
	HOME_ROUTE,
	homeDataCollectionPath,
	homeProposalApplyPath,
	homeProposalCompilePath,
	homeProposalPath,
	MAIL_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SURFACE_ROUTES,
	WHISPERING_ROUTE,
} from './routes.ts';
import {
	createHomeServer,
	DESKTOP_AI_TRANSCRIPTIONS_ROUTE,
	DESKTOP_WHISPERING_AUDIO_ROUTE,
	type HomeServerEvent,
	type HomeServerOptions,
	type HomeSessionResponse,
	NATIVE_WHISPERING_AUDIO_ROUTE,
} from './server.ts';
import type { ReadyFrame } from './sidecar-runtime.ts';
import { loadStaticAssets } from './static-assets.ts';
import {
	createOwnedTestHomeHost,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'per-launch-secret';
const SIGNED_AUTH_CELL = JSON.stringify({
	grant: {
		accessToken: 'host-owned-access-token',
		refreshToken: 'host-owned-refresh-token',
		accessTokenExpiresAt: Date.now() + 3_600_000,
	},
	principalId: 'alice',
});

function createSignedTestDesktopAuth() {
	return createTestDesktopAuth({
		authCell: SIGNED_AUTH_CELL,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				return Response.json({ principalId: 'alice' });
			}
			throw new Error(`Unexpected auth request: ${String(input)}`);
		},
	});
}

/** A stand-in for the built SPA document; `/` must return it byte-for-byte. */
const PAGE = '<!doctype html><html><body>Home test page</body></html>';
const WHISPERING_PAGE =
	'<!doctype html><html><body>Whispering test application</body></html>';

function withoutAuthBootstrap(page: string): string {
	return page.replace(
		/<script id="epicenter-auth-bootstrap" type="application\/json">[\s\S]*?<\/script>/,
		'',
	);
}

const queryDir = fileURLToPath(new URL('..', import.meta.url));
type TestServer = ReturnType<typeof Bun.serve>;
const BunWebSocket = WebSocket as unknown as {
	new (url: string, options: { headers: Record<string, string> }): WebSocket;
};
const serverAuthentication = new WeakMap<
	TestServer,
	{ cookie: string; origin: string }
>();

function scriptedEngine(scripts: EngineChunk[][]): AgentEngine {
	let step = 0;
	return async function* () {
		const script = scripts[Math.min(step, scripts.length - 1)] ?? [];
		step += 1;
		for (const chunk of script) yield chunk;
	};
}

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'query-server-test-'));
}

const closedRecordOwner = {
	execute: async () => ({
		result: null,
		error: {
			name: EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
			message: 'Desktop record operation failed' as const,
		},
	}),
} satisfies HomeServerOptions['recordOwner'];

function boundPort(server: { port?: number }): number {
	if (server.port === undefined) throw new Error('server did not bind a port');
	return server.port;
}

function createTestHost(
	options: Pick<
		HomeHostInputs,
		'approval' | 'engine' | 'localBooks' | 'localSource'
	>,
) {
	return createOwnedTestHomeHost({
		dataDir: testDataDir(),
		model: 'test-model',
		...options,
	});
}

async function serveHost(
	host: HomeHost,
	page: string = PAGE,
	recordOwner: HomeServerOptions['recordOwner'] = closedRecordOwner,
	readRecordingAudio: HomeServerOptions['readRecordingAudio'] = async () =>
		null,
	chooseFirstAttachment: HomeServerOptions['chooseFirstAttachment'] = async () =>
		undefined,
	recordAttachment: HomeServerOptions['recordAttachment'] = () => ({
		kind: 'unattached',
		requiresChoice: false,
	}),
	desktopAuth: HomeServerOptions['desktopAuth'] = createTestDesktopAuth(),
	deploymentFetch?: HomeServerOptions['deploymentFetch'],
	proposalService?: HomeServerOptions['proposalService'],
	dataInspection?: HomeServerOptions['dataInspection'],
) {
	const portProbe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = boundPort(portProbe);
	await portProbe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await createAppsDistFixture(page),
		recordOwner,
		recordAttachment,
		readRecordingAudio,
		chooseFirstAttachment,
		desktopAuth,
		...(proposalService === undefined ? {} : { proposalService }),
		...(dataInspection === undefined ? {} : { dataInspection }),
		...(deploymentFetch === undefined ? {} : { deploymentFetch }),
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	const bootstrap = await fetch(BOOTSTRAP_ROUTE.url(origin), {
		method: 'POST',
		headers: {
			authorization: `Bearer ${TOKEN}`,
			origin,
		},
	});
	if (bootstrap.status !== 204) {
		throw new Error(`test bootstrap failed with ${bootstrap.status}`);
	}
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (cookie === undefined) throw new Error('test bootstrap set no cookie');
	serverAuthentication.set(server, { cookie, origin });
	return server;
}

async function createAppsDistFixture(homePage: string = PAGE) {
	return loadStaticAssets(writeAppsDistFixture(homePage));
}

function writeAppsDistFixture(homePage: string = PAGE): string {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-apps-dist-'));
	mkdirSync(join(root, 'home'), { recursive: true });
	mkdirSync(join(root, 'whispering', '_app', 'immutable'), { recursive: true });
	mkdirSync(join(root, 'whispering', 'vad'), { recursive: true });
	writeFileSync(join(root, 'home', 'index.html'), homePage);
	writeFileSync(join(root, 'whispering', 'index.html'), WHISPERING_PAGE);
	writeFileSync(
		join(root, 'whispering', '_app', 'immutable', 'entry.js'),
		'window.whisperingLoaded = true;',
	);
	writeFileSync(
		join(root, 'whispering', 'vad', 'silero_vad_v5.onnx'),
		'vad-model',
	);
	return root;
}

function conversationOf(event: HomeServerEvent) {
	return event.snapshot.conversation;
}

function authenticationFor(server: TestServer) {
	const authentication = serverAuthentication.get(server);
	if (authentication === undefined) throw new Error('unknown test server');
	return authentication;
}

function authenticatedHeaders(server: TestServer) {
	return { cookie: authenticationFor(server).cookie };
}

function streamUrl(server: TestServer): string {
	return SESSION_STREAM_ROUTE.url(server.url.origin).replace('http:', 'ws:');
}

function openSocket(server: TestServer): WebSocket {
	const { cookie, origin } = authenticationFor(server);
	return new BunWebSocket(streamUrl(server), {
		headers: { cookie, origin },
	});
}

/**
 * Resolve on the first pushed frame matching `predicate`; reject on socket
 * error or timeout. The listener attaches synchronously at call time, so call
 * this before (or in the same task as) the send that should trigger it.
 */
function nextSnapshot(
	ws: WebSocket,
	predicate: (event: HomeServerEvent) => boolean,
	description: string,
	timeoutMs = 5000,
): Promise<HomeServerEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timed out waiting for ${description}`)),
			timeoutMs,
		);
		ws.addEventListener('message', (event) => {
			const parsed = JSON.parse(String(event.data)) as HomeServerEvent;
			if (!predicate(parsed)) return;
			clearTimeout(timer);
			resolve(parsed);
		});
		ws.addEventListener('error', () => {
			clearTimeout(timer);
			reject(new Error('socket error'));
		});
	});
}

/** The turn settled and the last assistant message contains `text`. */
const settledWith =
	(text: string) =>
	(event: HomeServerEvent): boolean => {
		const snapshot = conversationOf(event);
		const last = snapshot.messages.at(-1);
		return (
			!snapshot.isGenerating &&
			last?.role === 'assistant' &&
			last.parts.some(
				(part) => part.type === 'text' && part.text.includes(text),
			)
		);
	};

describe('loadStaticAssets', () => {
	test('requires both real application documents at startup', async () => {
		const missingWhispering = mkdtempSync(
			join(tmpdir(), 'epicenter-missing-whispering-'),
		);
		mkdirSync(join(missingWhispering, 'home'), { recursive: true });
		writeFileSync(join(missingWhispering, 'home', 'index.html'), PAGE);
		expect(loadStaticAssets(missingWhispering)).rejects.toThrow(
			/Whispering asset root is missing/,
		);

		const missingQuery = mkdtempSync(
			join(tmpdir(), 'epicenter-missing-query-'),
		);
		mkdirSync(join(missingQuery, 'whispering'), { recursive: true });
		writeFileSync(
			join(missingQuery, 'whispering', 'index.html'),
			WHISPERING_PAGE,
		);
		expect(loadStaticAssets(missingQuery)).rejects.toThrow(
			/Home index is missing/,
		);
	});

	test('resolves nested generated assets and extensionless SPA routes', async () => {
		const assets = await createAppsDistFixture();
		const nested = await assets.resolveWhispering(
			'/apps/whispering/_app/immutable/entry.js',
		);
		expect(nested?.contentType).toContain('text/javascript');
		expect(await nested?.file.text()).toContain('whisperingLoaded');

		const vad = await assets.resolveWhispering(
			'/apps/whispering/vad/silero_vad_v5.onnx',
		);
		expect(await vad?.file.text()).toBe('vad-model');

		const fallback = await assets.resolveWhispering(
			'/apps/whispering/settings/transcription',
		);
		expect(await fallback?.file.text()).toBe(WHISPERING_PAGE);
		expect(
			await assets.resolveWhispering('/apps/whispering/_app/missing.js'),
		).toBeUndefined();
	});

	test('rejects raw, encoded, double-encoded, and symlink traversal', async () => {
		const root = writeAppsDistFixture();
		const outside = mkdtempSync(join(tmpdir(), 'epicenter-outside-assets-'));
		writeFileSync(join(outside, 'secret.txt'), 'outside secret');
		symlinkSync(
			join(outside, 'secret.txt'),
			join(root, 'whispering', 'linked-secret.txt'),
		);
		symlinkSync(
			join(outside, 'secret.txt'),
			join(root, 'whispering', 'linked-secret'),
		);
		const assets = await loadStaticAssets(root);

		for (const pathname of [
			'/apps/whispering/../home/index.html',
			'/apps/whispering/%2e%2e/home/index.html',
			'/apps/whispering/%252e%252e/home/index.html',
			'/apps/whispering/%2fetc/passwd',
			'/apps/whispering/%252fetc/passwd',
			'/apps/whispering//etc/passwd',
			'/apps/whispering/..\\query\\index.html',
			'/apps/whispering/%00index.html',
			'/apps/whispering/linked-secret.txt',
			'/apps/whispering/linked-secret',
		]) {
			expect(await assets.resolveWhispering(pathname)).toBeUndefined();
		}
	});
});

describe('createHomeServer', () => {
	test('refuses an empty launch token and non-loopback origins', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const staticAssets = await createAppsDistFixture();
		const desktopAuth = createTestDesktopAuth();
		expect(() =>
			createHomeServer({
				host,
				origin: 'http://127.0.0.1:39130',
				launchToken: '',
				staticAssets,
				recordOwner: closedRecordOwner,
				recordAttachment: () => ({
					kind: 'unattached',
					requiresChoice: false,
				}),
				readRecordingAudio: async () => null,
				chooseFirstAttachment: async () => undefined,
				desktopAuth,
			}),
		).toThrow(/launch token/);
		for (const origin of [
			'http://localhost:39130',
			'https://127.0.0.1:39130',
			'http://127.0.0.1',
			'http://127.0.0.1:39130/path',
		]) {
			expect(() =>
				createHomeServer({
					host,
					origin,
					launchToken: TOKEN,
					staticAssets,
					recordOwner: closedRecordOwner,
					recordAttachment: () => ({
						kind: 'unattached',
						requiresChoice: false,
					}),
					readRecordingAudio: async () => null,
					chooseFirstAttachment: async () => undefined,
					desktopAuth,
				}),
			).toThrow(/exact http:\/\/127\.0\.0\.1/);
		}
	});

	test('the launch token mints a browser session only at bootstrap', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const { origin } = authenticationFor(server);
		try {
			const minted = await fetch(BOOTSTRAP_ROUTE.url(origin), {
				method: 'POST',
				headers: { authorization: `Bearer ${TOKEN}`, origin },
			});
			const setCookie = minted.headers.get('set-cookie');
			expect(minted.status).toBe(204);
			expect(setCookie).toContain('HttpOnly');
			expect(setCookie).toContain('SameSite=Strict');
			expect(setCookie).toContain('Path=/');
			expect(setCookie).not.toContain(TOKEN);

			const wrongToken = await fetch(BOOTSTRAP_ROUTE.url(origin), {
				method: 'POST',
				headers: { authorization: 'Bearer wrong', origin },
			});
			expect(wrongToken.status).toBe(401);
			const wrongOrigin = await fetch(BOOTSTRAP_ROUTE.url(origin), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${TOKEN}`,
					origin: 'http://localhost:39130',
				},
			});
			expect(wrongOrigin.status).toBe(403);
			const queryToken = await fetch(
				`${SESSION_ROUTE.url(origin)}?token=${TOKEN}`,
			);
			expect(queryToken.status).toBe(401);
		} finally {
			await server.stop(true);
		}
	});

	test('native recording audio accepts only the launch bearer and existing record keys', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const recordingId = 'abc123abc123abc123abc123';
		const requested: string[] = [];
		const server = await serveHost(
			host,
			PAGE,
			closedRecordOwner,
			async (candidate) => {
				requested.push(candidate);
				return candidate === recordingId
					? {
							bytes: new Blob(['record audio']).stream(),
							mediaType: 'audio/webm',
							byteLength: 12,
						}
					: null;
			},
		);
		const pathFor = (candidate: string) =>
			NATIVE_WHISPERING_AUDIO_ROUTE.replace(':recordingId', candidate);
		const browserPathFor = (candidate: string) =>
			DESKTOP_WHISPERING_AUDIO_ROUTE.replace(':recordingId', candidate);
		try {
			const cookieOnly = await fetch(
				new URL(pathFor(recordingId), server.url),
				{
					headers: authenticatedHeaders(server),
				},
			);
			expect(cookieOnly.status).toBe(401);
			expect(requested).toEqual([]);

			const wrongBearer = await fetch(
				new URL(pathFor(recordingId), server.url),
				{ headers: { authorization: 'Bearer wrong' } },
			);
			expect(wrongBearer.status).toBe(401);
			expect(requested).toEqual([]);

			const invalid = await fetch(
				new URL(pathFor('../not-a-record'), server.url),
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			expect(invalid.status).toBe(404);
			expect(requested).toEqual([]);

			const missing = await fetch(
				new URL(pathFor('def456def456def456def456'), server.url),
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			expect(missing.status).toBe(404);

			const audio = await fetch(new URL(pathFor(recordingId), server.url), {
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(audio.status).toBe(200);
			expect(audio.headers.get('content-type')).toBe('audio/webm');
			expect(audio.headers.get('cache-control')).toBe('no-store');
			expect(audio.headers.get('accept-ranges')).toBe('bytes');
			expect(audio.headers.get('content-length')).toBe('12');
			expect(await audio.text()).toBe('record audio');
			expect(requested).toEqual(['def456def456def456def456', recordingId]);

			const range = await fetch(new URL(pathFor(recordingId), server.url), {
				headers: {
					authorization: `Bearer ${TOKEN}`,
					range: 'bytes=7-11',
				},
			});
			expect(range.status).toBe(206);
			expect(range.headers.get('content-range')).toBe('bytes 7-11/12');
			expect(range.headers.get('content-length')).toBe('5');
			expect(await range.text()).toBe('audio');

			const unsatisfiable = await fetch(
				new URL(pathFor(recordingId), server.url),
				{
					headers: {
						authorization: `Bearer ${TOKEN}`,
						range: 'bytes=12-',
					},
				},
			);
			expect(unsatisfiable.status).toBe(416);
			expect(unsatisfiable.headers.get('content-range')).toBe('bytes */12');

			const browserAudio = await fetch(
				new URL(browserPathFor(recordingId), server.url),
				{ headers: authenticatedHeaders(server) },
			);
			expect(browserAudio.status).toBe(200);
			expect(await browserAudio.text()).toBe('record audio');
			expect(
				(
					await fetch(new URL(browserPathFor(recordingId), server.url), {
						headers: { authorization: `Bearer ${TOKEN}` },
					})
				).status,
			).toBe(401);
		} finally {
			await server.stop(true);
		}
	});

	test('recording audio never reflects synchronized active content types', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const recordingId = 'abc123abc123abc123abc123';
		const server = await serveHost(host, PAGE, closedRecordOwner, async () => ({
			bytes: new Blob(['not markup']).stream(),
			mediaType: 'text/html\r\nx-injected: yes',
			byteLength: 10,
		}));
		try {
			const response = await fetch(
				new URL(
					NATIVE_WHISPERING_AUDIO_ROUTE.replace(':recordingId', recordingId),
					server.url,
				),
				{ headers: { authorization: `Bearer ${TOKEN}` } },
			);
			expect(response.status).toBe(200);
			expect(response.headers.get('content-type')).toBe(
				'application/octet-stream',
			);
			expect(response.headers.get('x-injected')).toBeNull();
		} finally {
			await server.stop(true);
		}
	});

	test('the desktop transcription broker exposes one fixed authenticated gateway', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const upstream: Array<{
			url: string;
			contentType: string | null;
			body: string;
		}> = [];
		const server = await serveHost(
			host,
			PAGE,
			closedRecordOwner,
			async () => null,
			async () => undefined,
			() => ({ kind: 'unattached', requiresChoice: false }),
			createSignedTestDesktopAuth(),
			async (input, init) => {
				expect(init?.body).toBeInstanceOf(ArrayBuffer);
				upstream.push({
					url: String(input),
					contentType: new Headers(init?.headers).get('content-type'),
					body: await new Response(init?.body).text(),
				});
				return Response.json({ text: 'transcribed' });
			},
		);
		const { cookie, origin } = authenticationFor(server);
		const form = new FormData();
		form.set('model', 'epicenter');
		form.set(
			'file',
			new File(['audio'], 'recording.wav', { type: 'audio/wav' }),
		);
		const request = (headers: Record<string, string>) =>
			fetch(new URL(DESKTOP_AI_TRANSCRIPTIONS_ROUTE, server.url), {
				method: 'POST',
				headers,
				body: form,
			});
		try {
			expect((await request({ origin })).status).toBe(401);
			expect((await request({ cookie })).status).toBe(403);
			const response = await request({ cookie, origin });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ text: 'transcribed' });
			expect(upstream).toHaveLength(1);
			expect(upstream[0]?.url).toBe(
				API_ROUTES.ai.transcriptions.url('https://api.epicenter.so'),
			);
			expect(upstream[0]?.contentType).toStartWith('multipart/form-data;');
			expect(upstream[0]?.body).toContain('recording.wav');
			expect(upstream[0]?.body).not.toContain('host-owned-access-token');
		} finally {
			await server.stop(true);
		}
	});

	test('the browser session delegates one validated attachment choice to the host', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const choices: string[] = [];
		const server = await serveHost(
			host,
			PAGE,
			closedRecordOwner,
			async () => null,
			async (choice) => {
				choices.push(choice);
			},
		);
		const { cookie, origin } = authenticationFor(server);
		const request = (body: string, headers: Record<string, string>) =>
			fetch(new URL(DESKTOP_RECORD_ATTACHMENT_ROUTE, server.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body,
			});
		try {
			expect(
				(
					await request('{"choice":"bring"}', {
						authorization: `Bearer ${TOKEN}`,
						origin,
					})
				).status,
			).toBe(401);
			expect((await request('{"choice":"bring"}', { cookie })).status).toBe(
				403,
			);
			expect(
				(await request('{"choice":"keep"}', { cookie, origin })).status,
			).toBe(400);
			expect(
				(await request('{"choice":"bring"}', { cookie, origin })).status,
			).toBe(204);
			expect(choices).toEqual(['bring']);
		} finally {
			await server.stop(true);
		}
	});

	test('the host gates every app and serializes shared-replica mutations behind attachment', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		let attachment: ReturnType<HomeServerOptions['recordAttachment']> = {
			kind: 'unattached',
			requiresChoice: true,
		};
		const inputs: unknown[] = [];
		const choices: string[] = [];
		const server = await serveHost(
			host,
			PAGE,
			{
				async execute(input: unknown) {
					inputs.push(input);
					return structuredClone(await closedRecordOwner.execute());
				},
			},
			async () => null,
			async (choice) => {
				choices.push(choice);
				attachment = {
					kind: 'attached',
					attachment: {
						deploymentId: 'https://api.epicenter.so/',
						principalId: 'alice',
					},
				};
			},
			() => attachment,
			createSignedTestDesktopAuth(),
		);
		const { cookie, origin } = authenticationFor(server);
		const requestRecord = (input: unknown) =>
			fetch(new URL('/api/data/records', server.url), {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					cookie,
					origin,
				},
				body: JSON.stringify(input),
			});
		const mutation = {
			surfaceId: 'home',
			generation: 1,
			mutationId: 1,
			operation: {
				kind: 'create-record',
				namespace: 'so.epicenter.test',
				collection: 'notes',
				payload: { title: 'Blocked until choice' },
			},
		};
		try {
			const gate = await fetch(HOME_ROUTE.url(origin), {
				headers: { cookie },
			});
			const gateText = await gate.text();
			expect(gateText).toContain('Home, Whispering, and installed apps');
			expect(gateText).toContain('Discard all local data');

			const blocked = await requestRecord(mutation);
			expect(blocked.status).toBe(409);
			expect(inputs).toEqual([]);

			const read = await requestRecord({
				surfaceId: 'home',
				operation: { kind: 'open' },
			});
			expect(read.status).toBe(400);
			expect(inputs).toHaveLength(1);

			const choice = await fetch(
				new URL(DESKTOP_RECORD_ATTACHMENT_ROUTE, server.url),
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						cookie,
						origin,
					},
					body: '{"choice":"bring"}',
				},
			);
			expect(choice.status).toBe(204);
			expect(choices).toEqual(['bring']);

			const admitted = await requestRecord(mutation);
			expect(admitted.status).toBe(400);
			expect(inputs).toHaveLength(2);
		} finally {
			await server.stop(true);
		}
	});

	test('the record carrier requires session and Origin then forwards the sanitized envelope', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const inputs: unknown[] = [];
		const envelope = {
			result: null,
			error: {
				name: EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
				message: 'Desktop record operation failed',
			},
		} as const;
		const server = await serveHost(host, PAGE, {
			async execute(input) {
				inputs.push(input);
				return structuredClone(envelope);
			},
		});
		const { cookie, origin } = authenticationFor(server);
		const url = `${server.url.origin}/api/data/records`;
		try {
			expect(
				(
					await fetch(url, {
						method: 'POST',
						headers: { origin },
						body: '{}',
					})
				).status,
			).toBe(401);
			expect(
				(
					await fetch(url, {
						method: 'POST',
						headers: { cookie },
						body: '{}',
					})
				).status,
			).toBe(403);

			const forwarded = await fetch(url, {
				method: 'POST',
				headers: { cookie, origin },
				body: 'not-json',
			});
			expect(forwarded.status).toBe(400);
			expect(await forwarded.json()).toEqual(envelope);
			expect(inputs).toEqual([undefined]);
		} finally {
			await server.stop(true);
		}
	});

	test('the live data broker exposes bounded Lens pages and parked work', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const calls: unknown[] = [];
		const overview = {
			lenses: [],
			attachment: { kind: 'unattached' as const, requiresChoice: false },
			sync: {
				state: 'local' as const,
				work: {
					scalar: { pending: 0, sealed: 0, parked: 0 },
					document: { owed: 0, parked: 0 },
					blob: { owed: 0, parked: 0 },
				},
			},
			parked: { entries: [] },
		};
		const server = await serveHost(
			host,
			PAGE,
			closedRecordOwner,
			async () => null,
			async () => undefined,
			() => ({ kind: 'unattached', requiresChoice: false }),
			createTestDesktopAuth(),
			undefined,
			undefined,
			{
				async overview() {
					return overview;
				},
				async collection(input) {
					calls.push(input);
					return {
						lens: input.lens,
						collection: input.collection,
						kind: 'table',
						entries: [],
					};
				},
			},
		);
		try {
			const headers = authenticatedHeaders(server);
			const status = await fetch(
				HOME_DATA_OVERVIEW_ROUTE.url(server.url.origin),
				{
					headers,
				},
			);
			expect(status.status).toBe(200);
			expect(await status.json()).toEqual(overview);

			const page = await fetch(
				new URL(
					`${homeDataCollectionPath('chat', 'notes')}?after=${'a'.repeat(24)}&limit=25`,
					server.url,
				),
				{ headers },
			);
			expect(page.status).toBe(200);
			expect(calls).toEqual([
				{
					lens: 'chat',
					collection: 'notes',
					after: 'a'.repeat(24),
					limit: 25,
				},
			]);
			expect(
				(
					await fetch(
						new URL(homeDataCollectionPath('unknown', 'notes'), server.url),
						{ headers },
					)
				).status,
			).toBe(400);
		} finally {
			await server.stop(true);
		}
	});

	test('the Proposal broker validates and forwards the desktop artifact lifecycle', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const id = 'a'.repeat(24);
		const draft = {
			id,
			path: `/tmp/proposal-${id}.sqlite3`,
			proposalId: id,
			sourceReplicaId: 'r'.repeat(24),
			sourceAuthorityLifetime: null,
			state: 'draft' as const,
			changeCount: 0,
			appliedCount: 0,
		};
		const calls: unknown[] = [];
		let requiresAttachmentChoice = false;
		let compileBlock: Promise<void> | undefined;
		const proposalService = {
			async list() {
				calls.push(['list']);
				return {
					lenses: [
						{
							id: 'chat' as const,
							title: 'Chat',
							description: 'Conversations.',
							namespace: 'so.epicenter.chat',
							collections: [
								{
									key: 'conversations',
									title: 'Conversations',
									kind: 'table' as const,
								},
							],
						},
					],
					proposals: [draft],
				};
			},
			async create(input: unknown) {
				calls.push(['create', input]);
				return draft;
			},
			async compile(proposalId: string) {
				calls.push(['compile', proposalId]);
				await compileBlock;
				return { ...draft, state: 'compiled' as const, changeCount: 2 };
			},
			async apply(proposalId: string) {
				calls.push(['apply', proposalId]);
				return { proposalId, admittedChanges: 2 };
			},
			async delete(proposalId: string) {
				calls.push(['delete', proposalId]);
			},
		} satisfies NonNullable<HomeServerOptions['proposalService']>;
		const server = await serveHost(
			host,
			PAGE,
			closedRecordOwner,
			undefined,
			undefined,
			() => ({
				kind: 'unattached',
				requiresChoice: requiresAttachmentChoice,
			}),
			createSignedTestDesktopAuth(),
			undefined,
			proposalService,
		);
		const { cookie, origin } = authenticationFor(server);
		const mutationHeaders = {
			cookie,
			origin,
			'content-type': 'application/json',
		};
		try {
			const listed = await fetch(HOME_PROPOSALS_ROUTE.url(server.url.origin), {
				headers: { cookie },
			});
			expect(listed.status).toBe(200);
			expect(listed.headers.get('cache-control')).toBe('no-store');
			expect(await listed.json()).toEqual({
				lenses: [expect.objectContaining({ id: 'chat' })],
				proposals: [draft],
			});

			const selection = {
				namespace: 'so.epicenter.chat',
				collections: {
					conversations: {
						kind: 'table',
						recordKeys: [id],
						allowCreate: false,
					},
				},
			};
			const created = await fetch(HOME_PROPOSALS_ROUTE.url(server.url.origin), {
				method: 'POST',
				headers: mutationHeaders,
				body: JSON.stringify({ lens: 'chat', selection }),
			});
			expect(created.status).toBe(201);
			expect(await created.json()).toEqual(draft);

			expect(
				(
					await fetch(new URL(homeProposalCompilePath(id), server.url), {
						method: 'POST',
						headers: mutationHeaders,
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(new URL(homeProposalApplyPath(id), server.url), {
						method: 'POST',
						headers: mutationHeaders,
					})
				).status,
			).toBe(200);
			expect(
				(
					await fetch(new URL(homeProposalPath(id), server.url), {
						method: 'DELETE',
						headers: mutationHeaders,
					})
				).status,
			).toBe(204);
			expect(calls).toEqual([
				['list'],
				['create', { lens: 'chat', selection }],
				['compile', id],
				['apply', id],
				['delete', id],
			]);
			requiresAttachmentChoice = true;
			expect(
				(
					await fetch(new URL(homeProposalApplyPath(id), server.url), {
						method: 'POST',
						headers: mutationHeaders,
					})
				).status,
			).toBe(409);
			expect(calls.at(-1)).toEqual(['delete', id]);

			requiresAttachmentChoice = false;
			let releaseCompile: () => void = () => undefined;
			compileBlock = new Promise<void>((resolve) => {
				releaseCompile = resolve;
			});
			const blockedCompile = fetch(
				new URL(homeProposalCompilePath(id), server.url),
				{ method: 'POST', headers: mutationHeaders },
			);
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if (
					calls.filter((call) => Array.isArray(call) && call[0] === 'compile')
						.length === 2
				)
					break;
				await Bun.sleep(1);
			}
			expect(
				calls.filter((call) => Array.isArray(call) && call[0] === 'compile'),
			).toHaveLength(2);
			let queuedListSettled = false;
			const queuedList = fetch(HOME_PROPOSALS_ROUTE.url(server.url.origin), {
				headers: { cookie },
			}).then((response) => {
				queuedListSettled = true;
				return response;
			});
			await Bun.sleep(25);
			expect(queuedListSettled).toBe(false);
			const queuedApply = fetch(
				new URL(homeProposalApplyPath(id), server.url),
				{ method: 'POST', headers: mutationHeaders },
			);
			await Bun.sleep(25);
			requiresAttachmentChoice = true;
			releaseCompile();
			const [compiledAfterWait, listedAfterWait, appliedAfterWait] =
				await Promise.all([blockedCompile, queuedList, queuedApply]);
			expect(compiledAfterWait.status).toBe(200);
			expect(listedAfterWait.status).toBe(200);
			expect(appliedAfterWait.status).toBe(409);
			expect(
				calls.filter((call) => Array.isArray(call) && call[0] === 'list'),
			).toHaveLength(2);
			expect(
				calls.filter((call) => Array.isArray(call) && call[0] === 'apply'),
			).toHaveLength(1);
			compileBlock = undefined;

			expect(
				(
					await fetch(
						new URL(homeProposalCompilePath('not-an-id'), server.url),
						{
							method: 'POST',
							headers: mutationHeaders,
						},
					)
				).status,
			).toBe(400);
		} finally {
			await server.stop(true);
		}
	});

	test('serves only the session shell before bootstrap and gates domain APIs', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const shell = await fetch(HOME_ROUTE.url(server.url.origin));
			expect(shell.status).toBe(200);
			expect(await shell.text()).toContain('__EPICENTER_SESSION_READY__');
			expect(shell.headers.get('cache-control')).toBe('no-store');
			const page = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(withoutAuthBootstrap(await page.text())).toBe(PAGE);

			const bareSession = await fetch(SESSION_ROUTE.url(server.url.origin));
			expect(bareSession.status).toBe(401);
			const session = await fetch(SESSION_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(session.status).toBe(200);
			const body = (await session.json()) as HomeSessionResponse;
			const createTodos = body.tools.find(
				(t) => t.name === 'honeycrisp__folders_create',
			);
			expect(createTodos).toBeDefined();
			expect(createTodos?.inputSchema).toBeDefined();
			expect(body.snapshot.conversation.messages).toEqual([]);

			const oldTools = await fetch(`${server.url.origin}/api/tools`);
			expect(oldTools.status).toBe(404);
			const oldWs = await fetch(`${server.url.origin}/ws`);
			expect(oldWs.status).toBe(404);
		} finally {
			await server.stop(true);
		}
	});

	test('serves Home and Whispering builds plus honest Mail and Books placeholders', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			expect(
				Object.values(SURFACE_ROUTES).map(({ id, pattern, windowLabel }) => ({
					id,
					pattern,
					windowLabel,
				})),
			).toEqual([
				{ id: 'home', pattern: '/apps/home/', windowLabel: 'home' },
				{
					id: 'whispering',
					pattern: '/apps/whispering/',
					windowLabel: 'whispering',
				},
				{ id: 'mail', pattern: '/apps/mail/', windowLabel: 'mail' },
				{ id: 'books', pattern: '/apps/books/', windowLabel: 'books' },
			]);

			const query = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			const queryPage = await query.text();
			expect(queryPage).toContain('id="epicenter-auth-bootstrap"');
			expect(withoutAuthBootstrap(queryPage)).toBe(PAGE);

			const whispering = await fetch(WHISPERING_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			const whisperingPage = await whispering.text();
			expect(whisperingPage).toContain('id="epicenter-auth-bootstrap"');
			expect(withoutAuthBootstrap(whisperingPage)).toBe(WHISPERING_PAGE);
			const whisperingAsset = await fetch(
				`${server.url.origin}/apps/whispering/_app/immutable/entry.js?v=1`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(await whisperingAsset.text()).toContain('whisperingLoaded');
			expect(whisperingAsset.headers.get('content-type')).toContain(
				'text/javascript',
			);
			const vadAsset = await fetch(
				`${server.url.origin}/apps/whispering/vad/silero_vad_v5.onnx`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(await vadAsset.text()).toBe('vad-model');
			const clientRoute = await fetch(
				`${server.url.origin}/apps/whispering/settings/transcription?tab=models`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(withoutAuthBootstrap(await clientRoute.text())).toBe(
				WHISPERING_PAGE,
			);
			const mail = await fetch(MAIL_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await mail.text()).toContain(
				'the full Mail experience is not included',
			);
			const books = await fetch(BOOKS_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await books.text()).toContain(
				'the full Books experience is not included',
			);

			for (const response of [
				query,
				whispering,
				whisperingAsset,
				vadAsset,
				clientRoute,
				mail,
				books,
			]) {
				expect(response.status).toBe(200);
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(response.headers.get('content-security-policy')).toContain(
					"default-src 'self'",
				);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('rejects alternate surface request targets without exposing filesystem paths', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			for (const path of [
				'/apps/unknown/',
				'/apps/home/extra',
				'/apps/home%2f',
				'/apps/home/%2e%2e/%2e%2e/package.json',
				'/apps/home/%252e%252e/%252e%252e/package.json',
				'/apps/whispering/missing.js',
			]) {
				const response = await fetch(`${server.url.origin}${path}`);
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain('"scripts"');
			}

			// Home strings are SPA state, not an alternate server-side surface.
			const queryState = await fetch(
				`${HOME_ROUTE.url(server.url.origin)}?conversation=recent`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(queryState.status).toBe(200);
			expect(withoutAuthBootstrap(await queryState.text())).toBe(PAGE);

			// URL fragments are browser state and are not sent in an HTTP request.
			// The server therefore sees this as the one canonical Mail path.
			const browserFragment = await fetch(
				`${MAIL_ROUTE.url(server.url.origin)}#compose`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(browserFragment.status).toBe(200);
			expect(await browserFragment.text()).toContain('<h1>Mail</h1>');
		} finally {
			await server.stop(true);
		}
	});

	test('rejects wrong Host and Origin and serves the browser security policy', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const wrongHost = await fetch(
				HOME_ROUTE.url(server.url.origin).replace('127.0.0.1', 'localhost'),
			);
			expect(wrongHost.status).toBe(421);
			const wrongOrigin = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: { origin: 'https://example.com' },
			});
			expect(wrongOrigin.status).toBe(403);

			const page = await fetch(HOME_ROUTE.url(server.url.origin));
			expect(page.headers.get('content-security-policy')).toContain(
				"connect-src 'self' ipc: http://ipc.localhost",
			);
			expect(page.headers.get('content-security-policy')).toContain(
				"script-src 'self'",
			);
			expect(page.headers.get('content-security-policy')).not.toContain(
				"script-src 'self' 'unsafe-inline'",
			);
			expect(page.headers.get('referrer-policy')).toBe('no-referrer');
			expect(page.headers.get('x-frame-options')).toBe('DENY');
		} finally {
			await server.stop(true);
		}
	});

	test('the account broker requires the browser session and grants no bearer', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const { cookie, origin } = authenticationFor(server);
		try {
			const unauthorized = await fetch(ACCOUNT_SIGN_OUT_ROUTE.url(origin), {
				method: 'POST',
				headers: { origin },
			});
			expect(unauthorized.status).toBe(401);

			const missingOrigin = await fetch(ACCOUNT_SIGN_OUT_ROUTE.url(origin), {
				method: 'POST',
				headers: { cookie },
			});
			expect(missingOrigin.status).toBe(403);

			const profileWithoutSession = await fetch(
				ACCOUNT_PROFILE_ROUTE.url(origin),
			);
			expect(profileWithoutSession.status).toBe(401);

			const signedOut = await fetch(ACCOUNT_SIGN_OUT_ROUTE.url(origin), {
				method: 'POST',
				headers: { cookie, origin },
			});
			expect(signedOut.status).toBe(202);

			const invalidInstance = await fetch(ACCOUNT_INSTANCE_ROUTE.url(origin), {
				method: 'POST',
				headers: { cookie, origin, 'content-type': 'application/json' },
				body: JSON.stringify({
					baseURL: 'https://box.example',
					token: 'too-short',
				}),
			});
			expect(invalidInstance.status).toBe(400);

			const hosted = await fetch(ACCOUNT_INSTANCE_ROUTE.url(origin), {
				method: 'DELETE',
				headers: { cookie, origin },
			});
			expect(hosted.status).toBe(202);
		} finally {
			await server.stop(true);
		}
	});

	test('a WebSocket session drives a chat turn and streams snapshots', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([
				[{ type: 'text-delta', delta: 'Hello from the host.' }],
			]),
		});
		const server = await serveHost(host);
		try {
			const ws = openSocket(server);
			const answered = nextSnapshot(
				ws,
				settledWith('Hello from the host.'),
				'the settled turn',
			);
			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({ type: 'send', content: 'hi' }));
			});

			const final = await answered;
			expect(conversationOf(final).error).toBeNull();
			expect(conversationOf(final).messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
			ws.close();
		} finally {
			await server.stop(true);
		}
	});

	test('a pending approval reappears after reconnect and approval resumes the turn', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([
				[
					{
						type: 'tool-call',
						toolCallId: 'call-approve',
						toolName: 'honeycrisp__folders_create',
						input: { name: 'Approve over WebSocket' },
					},
				],
				[{ type: 'text-delta', delta: 'Created over WebSocket.' }],
			]),
		});
		const server = await serveHost(host);
		try {
			const firstSocket = openSocket(server);
			const pending = nextSnapshot(
				firstSocket,
				(event) => event.snapshot.pendingApprovals.length === 1,
				'a pending approval',
			);
			firstSocket.addEventListener('open', () => {
				firstSocket.send(
					JSON.stringify({ type: 'send', content: 'create a folder' }),
				);
			});

			const pendingEvent = await pending;
			const [approval] = pendingEvent.snapshot.pendingApprovals;
			if (!approval) throw new Error('pending snapshot had no approval');
			expect(approval).toEqual(
				expect.objectContaining({
					toolCallId: 'call-approve',
					toolName: 'honeycrisp__folders_create',
					input: { name: 'Approve over WebSocket' },
				}),
			);
			firstSocket.close();

			// A fresh socket re-renders the same pending approval from host state
			// (ADR-0113): the prompt outlives the transport that first saw it.
			const secondSocket = openSocket(server);
			await nextSnapshot(
				secondSocket,
				(event) =>
					event.snapshot.pendingApprovals.some(
						(candidate) => candidate.id === approval.id,
					),
				'the rehydrated approval',
			);
			secondSocket.send(
				JSON.stringify({
					type: 'approve',
					requestId: approval.id,
					approved: true,
				}),
			);

			const final = await nextSnapshot(
				secondSocket,
				settledWith('Created over WebSocket.'),
				'the final answer',
			);
			expect(final.snapshot.pendingApprovals).toEqual([]);
			expect(conversationOf(final).error).toBeNull();
			secondSocket.close();
		} finally {
			await server.stop(true);
		}
	});

	test('two sockets share the one host session (the remote-session proof)', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[{ type: 'text-delta', delta: 'Shared.' }]]),
		});
		const server = await serveHost(host);
		try {
			const watcher = openSocket(server);
			const driver = openSocket(server);
			const watcherSettled = nextSnapshot(
				watcher,
				settledWith('Shared.'),
				'the watcher settling',
			);
			const driverSettled = nextSnapshot(
				driver,
				settledWith('Shared.'),
				'the driver settling',
			);
			await Promise.all(
				[watcher, driver].map(
					(ws) =>
						new Promise<void>((resolve) =>
							ws.addEventListener('open', () => resolve()),
						),
				),
			);
			driver.send(
				JSON.stringify({ type: 'send', content: 'hi from device 2' }),
			);

			// The watcher never sent anything, yet sees the same finished turn: one
			// conversation per host process, devices attach to the session
			// (ADR-0080), not to their own thread.
			const [watched, drove] = await Promise.all([
				watcherSettled,
				driverSettled,
			]);
			expect(conversationOf(watched).messages).toEqual(
				conversationOf(drove).messages,
			);
			expect(conversationOf(watched).messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
			watcher.close();
			driver.close();
		} finally {
			await server.stop(true);
		}
	});

	test('an invoke frame settles as an invocation record on the same session channel', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const ws = openSocket(server);
			const settled = nextSnapshot(
				ws,
				(event) =>
					event.snapshot.invocations.some(
						(invocation) => invocation.status === 'succeeded',
					),
				'the settled invocation',
			);
			ws.addEventListener('open', () => {
				ws.send(
					JSON.stringify({
						type: 'invoke',
						toolName: 'honeycrisp__folders_list',
						input: {},
					}),
				);
			});

			const final = await settled;
			expect(final.snapshot.invocations[0]).toEqual(
				expect.objectContaining({
					toolName: 'honeycrisp__folders_list',
					status: 'succeeded',
				}),
			);
			// A direct run rides the session channel but never the transcript.
			expect(conversationOf(final).messages).toEqual([]);
			ws.close();
		} finally {
			await server.stop(true);
		}
	});

	test('malformed frames drop silently without killing the session socket', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[{ type: 'text-delta', delta: 'Still alive.' }]]),
		});
		const server = await serveHost(host);
		try {
			const ws = openSocket(server);
			const settled = nextSnapshot(
				ws,
				settledWith('Still alive.'),
				'the turn after garbage frames',
			);
			ws.addEventListener('open', () => {
				// Deliberate until commands carry client-minted ids: an error outcome
				// would have nothing to name, so bad frames drop instead of erroring.
				ws.send('not json');
				ws.send(JSON.stringify({ type: 'launch-missiles' }));
				ws.send(JSON.stringify({ type: 'send', content: 'hi' }));
			});
			const final = await settled;
			expect(conversationOf(final).error).toBeNull();
			expect(conversationOf(final).messages.map((m) => m.role)).toEqual([
				'user',
				'assistant',
			]);
			ws.close();
		} finally {
			await server.stop(true);
		}
	});

	test('WebSocket upgrades require both a browser session and exact Origin', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const { cookie, origin } = authenticationFor(server);
			const rejectedHeaders: Record<string, string>[] = [
				{ origin },
				{ cookie, origin: 'http://localhost:39130' },
			];
			for (const headers of rejectedHeaders) {
				const ws = new BunWebSocket(streamUrl(server), { headers });
				const outcome = await new Promise<'open' | 'refused'>((resolve) => {
					ws.addEventListener('open', () => resolve('open'));
					ws.addEventListener('error', () => resolve('refused'));
					ws.addEventListener('close', () => resolve('refused'));
				});
				expect(outcome).toBe('refused');
			}
		} finally {
			await server.stop(true);
		}
	});
});

// ============================================================================
// Built SPA Tests (the real vite build)
// ============================================================================

let builtPagePromise: Promise<string> | undefined;

/**
 * Run the real Vite build once per test run and return Home's index document.
 * Memoized because both the built-SPA describe and the sidecar smoke need it,
 * and bun test does not guarantee an ordering contract between describes.
 */
function buildSpaOnce(): Promise<string> {
	builtPagePromise ??= (async () => {
		const outDir = mkdtempSync(join(tmpdir(), 'epicenter-home-build-'));
		const build = Bun.spawn(['bun', 'x', 'vite', 'build', '--outDir', outDir], {
			cwd: queryDir,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const exitCode = await build.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(build.stderr).text();
			throw new Error(`vite build exited with ${exitCode}:\n${stderr}`);
		}
		return Bun.file(join(outDir, 'index.html')).text();
	})();
	return builtPagePromise;
}

describe('the built SPA', () => {
	test('the build emits one self-contained document and the server returns it byte-for-byte', async () => {
		const page = await buildSpaOnce();

		// Home currently ships as one document. The server hashes every inline
		// script into its CSP instead of allowing arbitrary inline execution.
		const scriptTags = page.match(/<script\b[^>]*>/gi) ?? [];
		expect(scriptTags.length).toBeGreaterThan(0);
		for (const tag of scriptTags) {
			expect(tag).not.toMatch(/\ssrc\s*=/i);
		}
		// No asset-bearing tag may reference an external file. Matching tag
		// attributes (not raw substrings) keeps legitimate inline JS or CSS
		// content from false-positives.
		for (const [tag] of page.matchAll(
			/<(?:img|iframe|source|audio|video|embed)\b[^>]*>/gi,
		)) {
			expect(tag).not.toMatch(/\ssrc\s*=/i);
		}
		expect(page).not.toMatch(/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i);
		expect(page).not.toMatch(/<link\b[^>]*\bhref\s*=/i);

		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host, page);
		try {
			const response = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(response.status).toBe(200);
			expect(withoutAuthBootstrap(await response.text())).toBe(page);
			expect(response.headers.get('content-security-policy')).toMatch(
				/script-src 'self' 'sha256-/,
			);
		} finally {
			await server.stop(true);
		}
	}, 60_000);
});

// ============================================================================
// Sidecar End-to-End Smoke (the real main.ts entrypoint)
// ============================================================================

/** Build an OpenAI SSE response: one `data:` frame per chunk, then `[DONE]`. */
function openAiSse(chunks: object[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
				);
			}
			controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
	return new Response(body, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	});
}

/** First model call: a fragmented streamed tool call to `honeycrisp__folders_list`. */
const TOOL_CALL_TURN = [
	{
		choices: [
			{
				delta: {
					tool_calls: [
						{
							index: 0,
							id: 'call_1',
							type: 'function',
							function: { name: 'honeycrisp__folders_list', arguments: '' },
						},
					],
				},
				finish_reason: null,
			},
		],
	},
	{
		choices: [
			{
				delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
				finish_reason: null,
			},
		],
	},
	{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

const FINAL_TEXT = 'Your folder list is empty.';

/** Second model call: the final assistant sentence as text deltas. */
const FINAL_TEXT_TURN = [
	{
		choices: [{ delta: { content: 'Your folder list' }, finish_reason: null }],
	},
	{ choices: [{ delta: { content: ' is empty.' }, finish_reason: null }] },
	{ choices: [{ delta: {}, finish_reason: 'stop' }] },
];

/**
 * Read the sidecar's stdout until the one-line versioned ready announcement.
 * Rejects with the buffered stdout (or the sidecar's stderr, if it exited)
 * so a failed launch names its cause instead of timing out silently.
 */
async function readPortAnnouncement(
	sidecar: {
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
	},
	timeoutMs: number,
): Promise<number> {
	const reader = sidecar.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`no port announcement within ${timeoutMs}ms; stdout so far: ${JSON.stringify(buffer)}`,
				),
			);
		}, timeoutMs);
	});
	try {
		while (true) {
			const { value, done } = await Promise.race([reader.read(), timeout]);
			if (value) {
				buffer += decoder.decode(value, { stream: true });
				const newline = buffer.indexOf('\n');
				if (newline !== -1) {
					const line = buffer.slice(0, newline);
					const ready = JSON.parse(line) as ReadyFrame;
					expect(ready).toEqual({
						type: 'ready',
						protocolVersion: 2,
						port: ready.port,
					});
					return ready.port;
				}
			}
			if (done) {
				const stderr = await new Response(sidecar.stderr).text();
				throw new Error(
					`the sidecar exited before announcing a port:\n${stderr}`,
				);
			}
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

async function exitWithin(
	sidecar: { exited: Promise<number> },
	timeoutMs: number,
): Promise<number> {
	return Promise.race([
		sidecar.exited,
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`sidecar did not exit within ${timeoutMs}ms`);
		}),
	]);
}

describe('sidecar end-to-end smoke', () => {
	test('the spawned entrypoint serves the built SPA and drives a tool-calling turn', async () => {
		const page = await buildSpaOnce();
		const appsDist = writeAppsDistFixture(page);

		// The fake OpenAI-compatible backend: first request streams a
		// `honeycrisp__folders_list` tool call, second streams the final sentence.
		let inferenceRequests = 0;
		const inference = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (request.method !== 'POST' || pathname !== '/v1/chat/completions') {
					return new Response('Not found', { status: 404 });
				}
				inferenceRequests += 1;
				return openAiSse(
					inferenceRequests === 1 ? TOOL_CALL_TURN : FINAL_TEXT_TURN,
				);
			},
		});

		const portProbe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = boundPort(portProbe);
		await portProbe.stop(true);
		const sidecar = Bun.spawn(
			['bun', 'run', 'src/main.ts', '--runtime-mode=development'],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
					// The engine POSTs `${baseURL}/chat/completions`, so the base
					// carries the `/v1` prefix.
					EPICENTER_INFERENCE_URL: `${inference.url.origin}/v1`,
					EPICENTER_INFERENCE_MODEL: 'fake-model',
					// Keep the host's replicas out of the real user data directory.
					EPICENTER_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			// The credential and Rust-resolved port travel in the boot frame.
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 2, token: TOKEN, port, authCell: null })}\n`,
			);
			await sidecar.stdin.flush();
			const announcedPort = await readPortAnnouncement(sidecar, 30_000);
			expect(announcedPort).toBe(port);
			const origin = `http://127.0.0.1:${announcedPort}`;

			const shell = await fetch(HOME_ROUTE.url(origin));
			expect(shell.status).toBe(200);
			expect(await shell.text()).toContain('__EPICENTER_SESSION_READY__');

			const bootstrap = await fetch(BOOTSTRAP_ROUTE.url(origin), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${TOKEN}`,
					origin,
				},
			});
			expect(bootstrap.status).toBe(204);
			const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
			expect(cookie).toBeDefined();
			const served = await fetch(HOME_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(withoutAuthBootstrap(await served.text())).toBe(page);

			const session = await fetch(SESSION_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(session.status).toBe(200);
			const catalog = (await session.json()) as HomeSessionResponse;
			expect(catalog.tools.map((t) => t.name)).toContain(
				'honeycrisp__folders_list',
			);
			expect(catalog.snapshot.conversation.messages).toEqual([]);

			// One WebSocket turn: send, then await the settled snapshot.
			const ws = new BunWebSocket(
				SESSION_STREAM_ROUTE.url(origin).replace('http:', 'ws:'),
				{ headers: { cookie: cookie ?? '', origin } },
			);
			const settled = nextSnapshot(
				ws,
				settledWith(FINAL_TEXT),
				'the settled turn',
				20_000,
			);
			ws.addEventListener('open', () => {
				ws.send(JSON.stringify({ type: 'send', content: 'list my folders' }));
			});
			let final: HomeServerEvent;
			try {
				final = await settled;
			} finally {
				ws.close();
			}

			expect(conversationOf(final).error).toBeNull();
			const parts = conversationOf(final).messages.flatMap((m) => m.parts);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: 'tool-call',
					toolName: 'honeycrisp__folders_list',
				}),
			);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: 'tool-result',
					toolName: 'honeycrisp__folders_list',
					isError: false,
				}),
			);
			expect(inferenceRequests).toBe(2);
		} finally {
			sidecar.kill('SIGTERM');
			expect(await sidecar.exited).toBe(0);
			await inference.stop(true);
		}
	}, 120_000);

	test('a port collision exits without announcing readiness or falling back', async () => {
		const appsDist = writeAppsDistFixture(await buildSpaOnce());
		const occupied = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response('occupied'),
		});
		const occupiedPort = boundPort(occupied);
		const sidecar = Bun.spawn(
			['bun', 'run', 'src/main.ts', '--runtime-mode=development'],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
					EPICENTER_INFERENCE_URL: 'http://127.0.0.1:1/v1',
					EPICENTER_INFERENCE_MODEL: 'unused-model',
					EPICENTER_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 2, token: TOKEN, port: occupiedPort, authCell: null })}\n`,
			);
			await sidecar.stdin.flush();
			expect(await exitWithin(sidecar, 30_000)).not.toBe(0);
			expect(await new Response(sidecar.stdout).text()).toBe('');
			expect(await new Response(sidecar.stderr).text()).toMatch(
				/port|address/i,
			);
		} finally {
			sidecar.kill();
			await occupied.stop(true);
		}
	}, 60_000);

	test('parent-pipe EOF exits and releases the listening port', async () => {
		const appsDist = writeAppsDistFixture(await buildSpaOnce());
		const portProbe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = boundPort(portProbe);
		await portProbe.stop(true);
		const sidecar = Bun.spawn(
			['bun', 'run', 'src/main.ts', '--runtime-mode=development'],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
					EPICENTER_INFERENCE_URL: 'http://127.0.0.1:1/v1',
					EPICENTER_INFERENCE_MODEL: 'unused-model',
					EPICENTER_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 2, token: TOKEN, port, authCell: null })}\n`,
			);
			await sidecar.stdin.flush();
			expect(await readPortAnnouncement(sidecar, 30_000)).toBe(port);
			sidecar.stdin.end();
			expect(await exitWithin(sidecar, 30_000)).toBe(0);

			const replacement = Bun.serve({
				hostname: '127.0.0.1',
				port,
				fetch: () => new Response(),
			});
			expect(replacement.port).toBe(port);
			await replacement.stop(true);
		} finally {
			sidecar.kill();
		}
	}, 60_000);
});
