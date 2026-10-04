/**
 * Query Server Tests
 *
 * Verifies the loopback shell around one host session (ADR-0084): the
 * exact Host and Origin checks protect the loopback boundary, Tauri bootstraps
 * HttpOnly browser sessions without a URL token, Query is served at its final
 * route, and the WebSocket drives the single shared chat session.
 *
 * Key behaviors:
 * - The launch token is accepted only by the bootstrap route
 * - Query APIs and WebSockets require an HttpOnly browser session
 * - Query and Whispering serve their builds; Mail and Books stay placeholders
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
import { generateBlobId } from '@epicenter/blobs';
import { createBunBlobs } from '@epicenter/blobs/bun';
import { desktopBlobUrl } from '@epicenter/blobs/webview';
import type { AgentEngine, EngineChunk } from '@epicenter/workspace/agent';
import {
	createQueryHost,
	type QueryHost,
	type QueryHostOptions,
} from './host.ts';
import {
	BOOKS_ROUTE,
	BOOTSTRAP_ROUTE,
	MAIL_ROUTE,
	QUERY_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SURFACE_ROUTES,
	WHISPERING_ROUTE,
} from './routes.ts';
import {
	createQueryServer,
	type QueryServerEvent,
	type QuerySessionResponse,
} from './server.ts';
import type { ReadyFrame } from './sidecar-runtime.ts';
import { loadStaticAssets } from './static-assets.ts';

const TOKEN = 'per-launch-secret';

/** A stand-in for the built SPA document; `/` must return it byte-for-byte. */
const PAGE = '<!doctype html><html><body>Query test page</body></html>';
const WHISPERING_PAGE =
	'<!doctype html><html><body>Whispering test application</body></html>';

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

function createTestBlobs() {
	return createBunBlobs({ directory: join(testDataDir(), 'blobs') });
}

function boundPort(server: { port?: number }): number {
	if (server.port === undefined) throw new Error('server did not bind a port');
	return server.port;
}

function createTestHost(options: Omit<QueryHostOptions, 'dataDir' | 'model'>) {
	return createQueryHost({
		dataDir: testDataDir(),
		model: 'test-model',
		...options,
	});
}

async function serveHost(host: QueryHost, page: string = PAGE) {
	const portProbe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = boundPort(portProbe);
	await portProbe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const { app, websocket } = createQueryServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await createAppsDistFixture(page),
		blobs: createTestBlobs(),
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

async function createAppsDistFixture(queryPage: string = PAGE) {
	return loadStaticAssets(writeAppsDistFixture(queryPage));
}

function writeAppsDistFixture(queryPage: string = PAGE): string {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-apps-dist-'));
	mkdirSync(join(root, 'query'), { recursive: true });
	mkdirSync(join(root, 'whispering', '_app', 'immutable'), { recursive: true });
	mkdirSync(join(root, 'whispering', 'vad'), { recursive: true });
	writeFileSync(join(root, 'query', 'index.html'), queryPage);
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

function conversationOf(event: QueryServerEvent) {
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
	predicate: (event: QueryServerEvent) => boolean,
	description: string,
	timeoutMs = 5000,
): Promise<QueryServerEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`timed out waiting for ${description}`)),
			timeoutMs,
		);
		ws.addEventListener('message', (event) => {
			const parsed = JSON.parse(String(event.data)) as QueryServerEvent;
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
	(event: QueryServerEvent): boolean => {
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
		mkdirSync(join(missingWhispering, 'query'), { recursive: true });
		writeFileSync(join(missingWhispering, 'query', 'index.html'), PAGE);
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
			/Query index is missing/,
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
			'/apps/whispering/../query/index.html',
			'/apps/whispering/%2e%2e/query/index.html',
			'/apps/whispering/%252e%252e/query/index.html',
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

describe('createQueryServer', () => {
	test('refuses an empty launch token and non-loopback origins', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const staticAssets = await createAppsDistFixture();
		expect(() =>
			createQueryServer({
				host,
				origin: 'http://127.0.0.1:39130',
				launchToken: '',
				staticAssets,
				blobs: createTestBlobs(),
			}),
		).toThrow(/launch token/);
		for (const origin of [
			'http://localhost:39130',
			'https://127.0.0.1:39130',
			'http://127.0.0.1',
			'http://127.0.0.1:39130/path',
		]) {
			expect(() =>
				createQueryServer({
					host,
					origin,
					launchToken: TOKEN,
					staticAssets,
					blobs: createTestBlobs(),
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

	test('serves Query publicly but keeps domain APIs behind the browser session', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const page = await fetch(QUERY_ROUTE.url(server.url.origin));
			expect(page.status).toBe(200);
			expect(await page.text()).toBe(PAGE);
			expect(page.headers.get('cache-control')).toBe('no-store');

			const bareSession = await fetch(SESSION_ROUTE.url(server.url.origin));
			expect(bareSession.status).toBe(401);
			const session = await fetch(SESSION_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(session.status).toBe(200);
			const body = (await session.json()) as QuerySessionResponse;
			const createTodos = body.tools.find(
				(t) => t.name === 'todos__todos_create',
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

	test('serves Query and Whispering builds plus honest Mail and Books placeholders', async () => {
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
				{ id: 'query', pattern: '/apps/query/', windowLabel: 'query' },
				{
					id: 'whispering',
					pattern: '/apps/whispering/',
					windowLabel: 'whispering',
				},
				{ id: 'mail', pattern: '/apps/mail/', windowLabel: 'mail' },
				{ id: 'books', pattern: '/apps/books/', windowLabel: 'books' },
			]);

			const query = await fetch(QUERY_ROUTE.url(server.url.origin));
			expect(await query.text()).toBe(PAGE);

			const whispering = await fetch(WHISPERING_ROUTE.url(server.url.origin));
			expect(await whispering.text()).toBe(WHISPERING_PAGE);
			const whisperingAsset = await fetch(
				`${server.url.origin}/apps/whispering/_app/immutable/entry.js?v=1`,
			);
			expect(await whisperingAsset.text()).toContain('whisperingLoaded');
			expect(whisperingAsset.headers.get('content-type')).toContain(
				'text/javascript',
			);
			const vadAsset = await fetch(
				`${server.url.origin}/apps/whispering/vad/silero_vad_v5.onnx`,
			);
			expect(await vadAsset.text()).toBe('vad-model');
			const clientRoute = await fetch(
				`${server.url.origin}/apps/whispering/settings/transcription?tab=models`,
			);
			expect(await clientRoute.text()).toBe(WHISPERING_PAGE);
			const mail = await fetch(MAIL_ROUTE.url(server.url.origin));
			expect(await mail.text()).toContain(
				'the full Mail experience is not included',
			);
			const books = await fetch(BOOKS_ROUTE.url(server.url.origin));
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
				'/apps/query/extra',
				'/apps/query%2f',
				'/apps/query/%2e%2e/%2e%2e/package.json',
				'/apps/query/%252e%252e/%252e%252e/package.json',
				'/apps/whispering/missing.js',
			]) {
				const response = await fetch(`${server.url.origin}${path}`);
				expect(response.status).toBe(404);
				expect(await response.text()).not.toContain('"scripts"');
			}

			// Query strings are SPA state, not an alternate server-side surface.
			const queryState = await fetch(
				`${QUERY_ROUTE.url(server.url.origin)}?conversation=recent`,
			);
			expect(queryState.status).toBe(200);
			expect(await queryState.text()).toBe(PAGE);

			// URL fragments are browser state and are not sent in an HTTP request.
			// The server therefore sees this as the one canonical Mail path.
			const browserFragment = await fetch(
				`${MAIL_ROUTE.url(server.url.origin)}#compose`,
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
				QUERY_ROUTE.url(server.url.origin).replace('127.0.0.1', 'localhost'),
			);
			expect(wrongHost.status).toBe(421);
			const wrongOrigin = await fetch(QUERY_ROUTE.url(server.url.origin), {
				headers: { origin: 'https://example.com' },
			});
			expect(wrongOrigin.status).toBe(403);

			const page = await fetch(QUERY_ROUTE.url(server.url.origin));
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
						toolName: 'todos__todos_create',
						input: { title: 'Approve over WebSocket' },
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
					JSON.stringify({ type: 'send', content: 'create a todo' }),
				);
			});

			const pendingEvent = await pending;
			const [approval] = pendingEvent.snapshot.pendingApprovals;
			if (!approval) throw new Error('pending snapshot had no approval');
			expect(approval).toEqual(
				expect.objectContaining({
					toolCallId: 'call-approve',
					toolName: 'todos__todos_create',
					input: { title: 'Approve over WebSocket' },
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
						toolName: 'todos__todos_list',
						input: {},
					}),
				);
			});

			const final = await settled;
			expect(final.snapshot.invocations[0]).toEqual(
				expect.objectContaining({
					toolName: 'todos__todos_list',
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

describe('local blob routes', () => {
	test('session authentication protects every local blob operation', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const id = generateBlobId();
		try {
			for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
				const response = await fetch(
					`${server.url.origin}${desktopBlobUrl(id)}`,
					{ method },
				);
				expect(response.status).toBe(401);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('put, head, byte-range forms, collision, and idempotent delete share one id', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const id = generateBlobId();
		const url = `${server.url.origin}${desktopBlobUrl(id)}`;
		const { cookie, origin } = authenticationFor(server);
		try {
			const put = await fetch(url, {
				method: 'PUT',
				headers: {
					cookie,
					'content-type': 'audio/test',
					origin,
				},
				body: '0123456789',
			});
			expect(put.status).toBe(201);

			const head = await fetch(url, {
				method: 'HEAD',
				headers: { cookie },
			});
			expect(head.status).toBe(200);
			expect(head.headers.get('content-length')).toBe('10');
			expect(head.headers.get('content-type')).toBe('audio/test');
			expect(await head.text()).toBe('');

			const range = await fetch(url, {
				headers: { cookie, range: 'bytes=2-5' },
			});
			expect(range.status).toBe(206);
			expect(range.headers.get('content-range')).toBe('bytes 2-5/10');
			expect(await range.text()).toBe('2345');
			const suffix = await fetch(url, {
				headers: { cookie, range: 'bytes=-3' },
			});
			expect(suffix.status).toBe(206);
			expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
			expect(await suffix.text()).toBe('789');
			const oversizedSuffix = await fetch(url, {
				headers: { cookie, range: 'bytes=-99' },
			});
			expect(oversizedSuffix.status).toBe(206);
			expect(oversizedSuffix.headers.get('content-range')).toBe('bytes 0-9/10');
			expect(await oversizedSuffix.text()).toBe('0123456789');
			const openEnded = await fetch(url, {
				headers: { cookie, range: 'bytes=6-' },
			});
			expect(openEnded.status).toBe(206);
			expect(openEnded.headers.get('content-range')).toBe('bytes 6-9/10');
			expect(await openEnded.text()).toBe('6789');
			const clamped = await fetch(url, {
				headers: { cookie, range: 'bytes=7-99' },
			});
			expect(clamped.status).toBe(206);
			expect(clamped.headers.get('content-range')).toBe('bytes 7-9/10');
			expect(await clamped.text()).toBe('789');
			const unsatisfiable = await fetch(url, {
				headers: { cookie, range: 'bytes=99-' },
			});
			expect(unsatisfiable.status).toBe(416);
			expect(unsatisfiable.headers.get('content-range')).toBe('bytes */10');
			for (const refusedRange of [
				'bytes=',
				'bytes=-',
				'bytes=5-2',
				'bytes=0-1,3-4',
				'bytes = 0-1',
				'items=0-1',
			]) {
				const refused = await fetch(url, {
					headers: { cookie, range: refusedRange },
				});
				expect(refused.status).toBe(416);
				expect(refused.headers.get('content-range')).toBe('bytes */10');
			}

			const emptyId = generateBlobId();
			const emptyUrl = `${server.url.origin}${desktopBlobUrl(emptyId)}`;
			expect(
				(
					await fetch(emptyUrl, {
						method: 'PUT',
						headers: { cookie, origin },
						body: '',
					})
				).status,
			).toBe(201);
			const emptyRange = await fetch(emptyUrl, {
				headers: { cookie, range: 'bytes=0-' },
			});
			expect(emptyRange.status).toBe(416);
			expect(emptyRange.headers.get('content-range')).toBe('bytes */0');

			const collision = await fetch(url, {
				method: 'PUT',
				headers: { cookie, 'content-type': 'audio/test', origin },
				body: 'replacement',
			});
			expect(collision.status).toBe(409);

			for (const expectedGetStatus of [404, 404]) {
				const deleted = await fetch(url, {
					method: 'DELETE',
					headers: { cookie, origin },
				});
				expect(deleted.status).toBe(204);
				const missing = await fetch(url, { headers: { cookie } });
				expect(missing.status).toBe(expectedGetStatus);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('hostile blob content is downloadable but cannot become same-origin code', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const id = generateBlobId();
		const url = `${server.url.origin}${desktopBlobUrl(id)}`;
		const { cookie, origin } = authenticationFor(server);
		try {
			expect(
				(
					await fetch(url, {
						method: 'PUT',
						headers: { cookie, 'content-type': 'text/html', origin },
						body: '<script>globalThis.compromised = true</script>',
					})
				).status,
			).toBe(201);

			const response = await fetch(url, { headers: { cookie } });
			expect(response.headers.get('content-disposition')).toBe('attachment');
			expect(response.headers.get('content-security-policy')).toBe(
				"sandbox; default-src 'none'",
			);
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(response.headers.get('cross-origin-resource-policy')).toBe(
				'same-origin',
			);
			expect(await response.text()).toContain('<script>');
		} finally {
			await server.stop(true);
		}
	});

	test('path-hostile and foreign ids are rejected before filesystem access', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const response = await fetch(
				`${server.url.origin}/api/local-blobs/not-a-blob-id`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(response.status).toBe(400);
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
 * Run the real Vite build once per test run and return Query's index document.
 * Memoized because both the built-SPA describe and the sidecar smoke need it,
 * and bun test does not guarantee an ordering contract between describes.
 */
function buildSpaOnce(): Promise<string> {
	builtPagePromise ??= (async () => {
		const outDir = mkdtempSync(join(tmpdir(), 'epicenter-query-build-'));
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

		// Query currently ships as one document. The server hashes every inline
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
			const response = await fetch(QUERY_ROUTE.url(server.url.origin));
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(page);
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

/** First model call: a fragmented streamed tool call to `todos__todos_list`. */
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
							function: { name: 'todos__todos_list', arguments: '' },
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

const FINAL_TEXT = 'Your todo list is empty.';

/** Second model call: the final assistant sentence as text deltas. */
const FINAL_TEXT_TURN = [
	{
		choices: [{ delta: { content: 'Your todo list' }, finish_reason: null }],
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
						protocolVersion: 1,
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
		// `todos__todos_list` tool call, second streams the final sentence.
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
					EPICENTER_QUERY_INFERENCE_URL: `${inference.url.origin}/v1`,
					EPICENTER_QUERY_MODEL: 'fake-model',
					// Keep the host's replicas out of the real user data directory.
					EPICENTER_DATA_DIR: testDataDir(),
					EPICENTER_QUERY_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			// The credential and Rust-resolved port travel in the boot frame.
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 1, token: TOKEN, port })}\n`,
			);
			await sidecar.stdin.flush();
			const announcedPort = await readPortAnnouncement(sidecar, 30_000);
			expect(announcedPort).toBe(port);
			const origin = `http://127.0.0.1:${announcedPort}`;

			// The final Query route is public static content; domain access is not.
			const served = await fetch(QUERY_ROUTE.url(origin));
			expect(served.status).toBe(200);
			expect(await served.text()).toBe(page);

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

			const session = await fetch(SESSION_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(session.status).toBe(200);
			const catalog = (await session.json()) as QuerySessionResponse;
			expect(catalog.tools.map((t) => t.name)).toContain('todos__todos_list');
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
				ws.send(JSON.stringify({ type: 'send', content: 'list my todos' }));
			});
			let final: QueryServerEvent;
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
					toolName: 'todos__todos_list',
				}),
			);
			expect(parts).toContainEqual(
				expect.objectContaining({
					type: 'tool-result',
					toolName: 'todos__todos_list',
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
					EPICENTER_QUERY_INFERENCE_URL: 'http://127.0.0.1:1/v1',
					EPICENTER_QUERY_MODEL: 'unused-model',
					EPICENTER_DATA_DIR: testDataDir(),
					EPICENTER_QUERY_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 1, token: TOKEN, port: occupiedPort })}\n`,
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
					EPICENTER_QUERY_INFERENCE_URL: 'http://127.0.0.1:1/v1',
					EPICENTER_QUERY_MODEL: 'unused-model',
					EPICENTER_DATA_DIR: testDataDir(),
					EPICENTER_QUERY_DATA_DIR: testDataDir(),
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 1, token: TOKEN, port })}\n`,
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
