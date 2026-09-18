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
 * - Unknown, non-canonical, and traversal-shaped app paths stay closed
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

import { describe, expect, spyOn, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEngine, EngineChunk } from '@epicenter/agent';
import { CHECKOUT_PATH } from '@epicenter/app/artifact/checkout';
import { generateBlobId } from '@epicenter/blobs';
import { type BunBlobStore, createBunBlobStore } from '@epicenter/blobs/bun';
import { createDesktopSqliteOwner } from '@epicenter/device/desktop';
import { DEVICE_PATH } from '@epicenter/device/protocol';
import { LOCAL_MAIL_APP_ID } from '@epicenter/local-mail/storage';
import { expectOk } from 'wellcrafted/testing';
import {
	type AppSecretOwner,
	createProcessMemoryAppSecrets,
} from './app-secrets.ts';
import { COMPILED_APPLICATIONS } from './applications.ts';
import { createDesktopAuthAuthority } from './desktop-auth-authority.js';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import { PLACEHOLDER_PAGES } from './placeholder-pages.ts';
import {
	ACCOUNT_CONNECT_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	APPLICATIONS_ROUTE,
	BOOKS_ROUTE,
	BOOTSTRAP_ROUTE,
	BUILT_IN_ROUTES,
	HOME_ROUTE,
	HONEYCRISP_ROUTE,
	MAIL_CALLBACK_ROUTE,
	MAIL_PENDING_CALLBACK_ROUTE,
	MAIL_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	WHISPERING_ROUTE,
} from './routes.ts';
import {
	createHomeServer,
	type HomeServerEvent,
	type HomeServerOptions,
	type HomeSessionResponse,
} from './server.ts';
import type { ReadyFrame } from './sidecar-runtime.ts';
import {
	type EpicenterStaticAssets,
	loadStaticAssets,
} from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { createTestDesktopAuth } from './test-home-host.ts';
import { type BunDevice, createBunDevice } from './test-sqlite.ts';

test('development browser callback completes the pending sign-in without a Home cookie', async () => {
	await using host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	const origin = 'http://127.0.0.1:49152';
	const callbackUrl = `${origin}/_epicenter/sign-in/callback`;
	const opened = Promise.withResolvers<string>();
	let relaunches = 0;
	using desktopAuth = createDesktopAuthAuthority({
		authCell: null,
		callbackUrl,
		nativeAuthPort: {
			async closeApplications() {},
			async resumeApplications() {},
			async storeAuth() {},
			async openAuthUrl(url) {
				opened.resolve(url);
			},
			relaunch() {
				relaunches++;
			},
			onAuthCallback() {
				return () => false;
			},
			completed: new Promise(() => {}),
		},
		async fetch(input) {
			return new URL(String(input)).pathname === '/api/session'
				? Response.json({ principalId: 'alice' })
				: Response.json({ token: 'alice' });
		},
	});
	const options = {
		folderRoot: testDataDir(),
		host,
		origin,
		launchToken: 'launch',
		staticAssets: await createAppsDistFixture(PAGE),
		blobs: createTestBlobs(),

		desktopAuth,
	};
	const { app } = createHomeServer(options);
	const pending = desktopAuth.startSignIn();
	const launch = new URL(await opened.promise);
	const request = (url: string) =>
		app.request(url, { headers: { host: new URL(origin).host } });
	expect((await request(`${callbackUrl}?code=code&state=wrong`)).status).toBe(
		400,
	);
	const params = new URLSearchParams({
		code: 'code',
		state: launch.searchParams.get('state')!,
	});
	const response = await request(`${callbackUrl}?${params}`);
	expect(response.status).toBe(200);
	expect(response.headers.get('set-cookie')).toBeNull();
	expect(response.headers.get('cache-control')).toBe('no-store');
	expectOk(await pending);
	expect(relaunches).toBe(1);
	expect((await request(`${callbackUrl}?${params}`)).status).toBe(400);
	using productionAuth = createTestDesktopAuth();
	const production = createHomeServer({
		...options,
		desktopAuth: productionAuth,
	});
	expect(
		(
			await production.app.request(callbackUrl, {
				headers: { host: new URL(origin).host },
			})
		).status,
	).toBe(404);
});

const TOKEN = 'per-launch-secret';

/**
 * The stdio MCP fixture, which is the whole tool surface a test host has: the
 * in-process app catalogs went with the data plane they read (ADR-0226).
 */
const MCP_FIXTURE = new URL(
	'../test-fixtures/mini-mcp-server.ts',
	import.meta.url,
).pathname;

/** A stand-in for the built SPA document; `/` must return it byte-for-byte. */
const PAGE = '<!doctype html><html><body>Home test page</body></html>';
const applicationPage = (title: string) =>
	`<!doctype html><html><body>${title} test application</body></html>`;
const WHISPERING_PAGE = applicationPage('Whispering');

/** Parse a Content-Security-Policy header into directive name to its token list. */
function cspDirectives(header: string | null): Map<string, string[]> {
	const directives = new Map<string, string[]>();
	for (const directive of (header ?? '').split(';')) {
		const [name, ...tokens] = directive.trim().split(/\s+/);
		if (name !== undefined && name !== '') directives.set(name, tokens);
	}
	return directives;
}

/** Strip what the host stamps onto an app window, recovering the built page. */
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

function createTestBlobs(): HomeServerOptions['blobs'] {
	const directory = testDataDir();
	const stores = new Map<string, BunBlobStore>();
	return (appId, owner) => {
		const key = JSON.stringify([appId, owner]);
		let store = stores.get(key);
		if (store === undefined) {
			store = createBunBlobStore({
				directory: join(directory, String(stores.size)),
			});
			stores.set(key, store);
		}
		return store;
	};
}

const TEST_APP_ID = 'so.epicenter.whispering';

function testBlobUrl(id: string, appId = TEST_APP_ID) {
	return `/api/apps/${appId}/blobs/${id}`;
}

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
	return createHomeHost({
		model: 'test-model',
		localBooks: { command: 'bun', args: [MCP_FIXTURE] },
		...options,
	});
}

async function serveHost(
	host: HomeHost,
	page: string = PAGE,
	owners: {
		device?: BunDevice;
		appSecrets?: AppSecretOwner;
		folderRoot?: string;
		blobs?: HomeServerOptions['blobs'];
	} = {},
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
		folderRoot: testDataDir(),
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await createAppsDistFixture(page),
		blobs: owners.blobs ?? createTestBlobs(),
		desktopAuth: createTestDesktopAuth(),
		...owners,
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
	return loadStaticAssets(
		writeAppsDistFixture(homePage),
		COMPILED_APPLICATIONS,
	);
}

/** The loaded build of one compiled application, by ID. */
function applicationAssets(assets: EpicenterStaticAssets, id: string) {
	const application = assets.applications.find(
		(candidate) => candidate.id === id,
	);
	if (!application) throw new Error(`no compiled application named ${id}`);
	return application;
}

function writeAppsDistFixture(homePage: string = PAGE): string {
	const root = writeAppsDist({
		homePage,
		applicationPage: ({ title }) => applicationPage(title),
	});
	mkdirSync(join(root, 'whispering', '_app', 'immutable'), { recursive: true });
	mkdirSync(join(root, 'whispering', 'vad'), { recursive: true });
	writeFileSync(
		join(root, 'whispering', '_app', 'immutable', 'entry.js'),
		'window.whisperingLoaded = true;',
	);
	writeFileSync(
		join(root, 'whispering', 'vad', 'silero_vad_v5.onnx'),
		'vad-model',
	);
	// The onnxruntime binary the VAD trigger compiles in the WebView. It belongs
	// in the fixture because a policy that admits WebAssembly is only truthful if
	// the WebAssembly it admits is actually served from this origin.
	writeFileSync(
		join(root, 'whispering', 'vad', 'ort-wasm-simd-threaded.wasm'),
		'\0asm\x01\0\0\0',
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
	test('every declared compiled application must have built, and so must Home', async () => {
		// One omission at a time, so the message names the application that is
		// actually missing rather than whichever absence lost a race.
		for (const absent of COMPILED_APPLICATIONS) {
			const root = writeAppsDist({
				homePage: PAGE,
				applicationPage: ({ title }) => applicationPage(title),
			});
			rmSync(join(root, absent.id), { recursive: true });
			expect(loadStaticAssets(root, COMPILED_APPLICATIONS)).rejects.toThrow(
				new RegExp(`${absent.title} asset root is missing`),
			);
		}

		const missingHome = writeAppsDist({
			homePage: PAGE,
			applicationPage: ({ title }) => applicationPage(title),
		});
		rmSync(join(missingHome, 'home'), { recursive: true });
		expect(
			loadStaticAssets(missingHome, COMPILED_APPLICATIONS),
		).rejects.toThrow(/Home index is missing/);
	});

	test('resolves nested generated assets and extensionless SPA routes', async () => {
		const assets = await createAppsDistFixture();
		const whispering = applicationAssets(assets, 'whispering');
		const nested = await whispering.resolve(
			'/apps/whispering/_app/immutable/entry.js',
		);
		expect(nested?.contentType).toContain('text/javascript');
		expect(await nested?.file.text()).toContain('whisperingLoaded');

		const vad = await whispering.resolve(
			'/apps/whispering/vad/silero_vad_v5.onnx',
		);
		expect(await vad?.file.text()).toBe('vad-model');

		const fallback = await whispering.resolve(
			'/apps/whispering/settings/transcription',
		);
		expect(await fallback?.file.text()).toBe(WHISPERING_PAGE);
		expect(
			await whispering.resolve('/apps/whispering/_app/missing.js'),
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
		const assets = await loadStaticAssets(root, COMPILED_APPLICATIONS);
		const whispering = applicationAssets(assets, 'whispering');

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
			expect(await whispering.resolve(pathname)).toBeUndefined();
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
				folderRoot: testDataDir(),
				host,
				origin: 'http://127.0.0.1:39130',
				launchToken: '',
				staticAssets,
				blobs: createTestBlobs(),
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
					folderRoot: testDataDir(),
					host,
					origin,
					launchToken: TOKEN,
					staticAssets,
					blobs: createTestBlobs(),
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
				(t) => t.name === 'localbooks__write_off',
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

	test('nested application APIs reject unauthorized requests before invoking a handler', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const origin = 'http://127.0.0.1:43127';
		const { app } = createHomeServer({
			folderRoot: testDataDir(),
			host,
			origin,
			launchToken: TOKEN,
			staticAssets: await createAppsDistFixture(),
			blobs: createTestBlobs(),
			desktopAuth: createTestDesktopAuth(),
		});
		let calls = 0;
		const path = '/api/apps/so.epicenter.test/auth-regression';
		app.post(path, (c) => {
			calls += 1;
			return c.body(null, 204);
		});
		const headers = { host: '127.0.0.1:43127', origin };
		const unauthorized = await app.request(`${origin}${path}`, {
			method: 'POST',
			headers,
		});
		expect(unauthorized.status).toBe(401);
		expect(calls).toBe(0);
		const bootstrap = await app.request(BOOTSTRAP_ROUTE.url(origin), {
			method: 'POST',
			headers: { ...headers, authorization: `Bearer ${TOKEN}` },
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		if (cookie === undefined) throw new Error('test bootstrap set no cookie');
		const forbidden = await app.request(`${origin}${path}`, {
			method: 'POST',
			headers: { ...headers, cookie, origin: 'https://untrusted.example' },
		});
		expect(forbidden.status).toBe(403);
		expect(calls).toBe(0);
		const authorized = await app.request(`${origin}${path}`, {
			method: 'POST',
			headers: { ...headers, cookie },
		});
		expect(authorized.status).toBe(204);
		expect(calls).toBe(1);
	});

	test('server selection requires the private browser session and exact Origin', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		try {
			for (const path of [
				'/_epicenter/account/connect',
				'/_epicenter/account/select-hosted',
			]) {
				const url = `${server.url.origin}${path}`;
				expect((await fetch(url, { method: 'POST' })).status).toBe(401);
				const headers = new Headers(authenticatedHeaders(server));
				headers.delete('origin');
				expect((await fetch(url, { method: 'POST', headers })).status).toBe(
					403,
				);
				headers.set('origin', 'https://foreign.example');
				expect((await fetch(url, { method: 'POST', headers })).status).toBe(
					403,
				);
			}
			const malformed = await fetch(
				`${server.url.origin}/_epicenter/account/connect`,
				{
					method: 'POST',
					headers: {
						...authenticatedHeaders(server),
						origin: server.url.origin,
					},
					body: '{}',
				},
			);
			expect(malformed.status).toBe(400);
		} finally {
			await server.stop(true);
		}
	});

	test('serves Home and every compiled application plus honest placeholders', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			expect(
				Object.values(BUILT_IN_ROUTES).map(({ id, pattern }) => ({
					id,
					pattern,
				})),
			).toEqual([
				{ id: 'home', pattern: '/apps/home/' },
				{ id: 'whispering', pattern: '/apps/whispering/' },
				{ id: 'honeycrisp', pattern: '/apps/honeycrisp/' },
				{ id: 'mail', pattern: '/apps/mail/' },
				{ id: 'books', pattern: '/apps/books/' },
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
			// The second compiled application takes the same path with no
			// per-application wiring: its own document, stamped and gated.
			const honeycrisp = await fetch(HONEYCRISP_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			const honeycrispPage = await honeycrisp.text();
			expect(honeycrispPage).toContain('id="epicenter-auth-bootstrap"');
			expect(withoutAuthBootstrap(honeycrispPage)).toBe(
				applicationPage('Honeycrisp'),
			);
			const honeycrispRoute = await fetch(
				`${server.url.origin}/apps/honeycrisp/notes/some-note`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(withoutAuthBootstrap(await honeycrispRoute.text())).toBe(
				applicationPage('Honeycrisp'),
			);

			// Mail is a compiled application now, so its route owes the stamped
			// build rather than a placeholder.
			const mail = await fetch(MAIL_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			const mailPage = await mail.text();
			expect(mailPage).toContain('id="epicenter-auth-bootstrap"');
			expect(withoutAuthBootstrap(mailPage)).toBe(applicationPage('Mail'));

			// The page itself, not a phrase inside it: what this route owes is the
			// release-bundled placeholder rather than an app or a 404, and pinning
			// a sentence here only means the copy cannot be improved without
			// editing a test that was never about the copy.
			const books = await fetch(BOOKS_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await books.text()).toBe(PLACEHOLDER_PAGES.books);

			for (const response of [
				query,
				whispering,
				whisperingAsset,
				vadAsset,
				clientRoute,
				honeycrisp,
				honeycrispRoute,
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

	test('rejects alternate app request targets without exposing filesystem paths', async () => {
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

			// Home strings are SPA state, not an alternate server-side app page.
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
			expect(withoutAuthBootstrap(await browserFragment.text())).toBe(
				applicationPage('Mail'),
			);
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

	test('admits first-party WebAssembly without restoring eval', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		try {
			const page = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			const directives = cspDirectives(
				page.headers.get('content-security-policy'),
			);
			const scriptSrc = directives.get('script-src') ?? [];

			// Voice activity detection compiles onnxruntime in this WebView.
			expect(scriptSrc).toContain("'wasm-unsafe-eval'");
			// The narrow token and only the narrow token: `eval` and `new Function`
			// stay refused, and inline scripts stay hash-pinned.
			expect(scriptSrc).not.toContain("'unsafe-eval'");
			expect(scriptSrc).not.toContain("'unsafe-inline'");
			expect(
				scriptSrc.some((token) => token.startsWith("'sha256-")),
			).toBeTrue();

			// Admitting WebAssembly must not have loosened anything else.
			expect(directives.get('worker-src')).toEqual(["'self'", 'blob:']);
			expect(directives.get('connect-src')).toEqual([
				"'self'",
				'ipc:',
				'http://ipc.localhost',
			]);
			expect(directives.get('object-src')).toEqual(["'none'"]);
			expect(directives.get('default-src')).toEqual(["'self'"]);

			// The capability is real on this origin, not a token for its own sake:
			// the binary the policy admits is served by this host.
			const wasm = await fetch(
				`${server.url.origin}/apps/whispering/vad/ort-wasm-simd-threaded.wasm`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(wasm.status).toBe(200);
			expect(new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)).toEqual(
				new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
			);
		} finally {
			await server.stop(true);
		}
	});

	test('only Mail reaches Google, and only from its own document', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const origin = server.url.origin;
		const connectSrc = async (url: string) => {
			const response = await fetch(url, {
				headers: authenticatedHeaders(server),
			});
			return (
				cspDirectives(response.headers.get('content-security-policy')).get(
					'connect-src',
				) ?? []
			);
		};
		try {
			// The host holds no Gmail token and proxies no Gmail request, so the
			// token exchange and the API calls happen in this WebView.
			const mail = await connectSrc(MAIL_ROUTE.url(origin));
			expect(mail).toEqual([
				"'self'",
				'ipc:',
				'http://ipc.localhost',
				'https://oauth2.googleapis.com',
				'https://gmail.googleapis.com',
			]);
			// Consent happens in the person's own browser, through the opener.
			expect(mail).not.toContain('https://accounts.google.com');

			// A client route inside Mail is the same document and keeps the same
			// reach; an asset it loads runs under the document's policy anyway.
			expect(await connectSrc(`${origin}/apps/mail/connected`)).toEqual(mail);

			// Nothing else on this origin gained an inch.
			const closed = ["'self'", 'ipc:', 'http://ipc.localhost'];
			expect(await connectSrc(HOME_ROUTE.url(origin))).toEqual(closed);
			expect(await connectSrc(WHISPERING_ROUTE.url(origin))).toEqual(closed);
			expect(await connectSrc(HONEYCRISP_ROUTE.url(origin))).toEqual(closed);
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
				`${origin}/_epicenter/account/http?path=%2Fapi%2Fsession`,
			);
			expect(profileWithoutSession.status).toBe(401);
			const obsoleteProfile = await fetch(
				`${origin}/_epicenter/account/profile`,
				{ headers: { cookie, origin } },
			);
			expect(obsoleteProfile.status).toBe(404);

			const selected = await fetch(ACCOUNT_CONNECT_ROUTE.url(origin), {
				method: 'POST',
				headers: { cookie, origin, 'content-type': 'application/json' },
				body: JSON.stringify({ server: 'https://self.example' }),
			});
			expect(selected.status).toBe(202);
			expect(await selected.text()).toBe('');

			const signedOut = await fetch(ACCOUNT_SIGN_OUT_ROUTE.url(origin), {
				method: 'POST',
				headers: { cookie, origin },
			});
			expect(signedOut.status).toBe(202);
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
						toolName: 'localbooks__write_off',
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
					toolName: 'localbooks__write_off',
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
						toolName: 'localbooks__customers',
						input: {},
					}),
				);
			});

			const final = await settled;
			expect(final.snapshot.invocations[0]).toEqual(
				expect.objectContaining({
					toolName: 'localbooks__customers',
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

describe("Local Mail's desktop authorization callback", () => {
	test('takes what Google delivered to the browser and hands it to the window once', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const origin = server.url.origin;
		try {
			// Nothing has arrived, so the window is told there is nothing.
			const empty = await fetch(MAIL_PENDING_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(empty.status).toBe(204);

			// Google answers in the person's own browser, which carries no
			// session cookie and must still be served.
			const callback = `${MAIL_CALLBACK_ROUTE.url(origin)}?code=the-code&state=the-state`;
			const delivered = await fetch(callback);
			expect(delivered.status).toBe(200);
			expect(await delivered.text()).toContain('close this tab');

			const collected = await fetch(MAIL_PENDING_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(collected.status).toBe(200);
			expect(await collected.json()).toEqual({ callbackUrl: callback });

			// One authorization is redeemable once, so a second read finds
			// nothing rather than a code Google has already spent.
			const again = await fetch(MAIL_PENDING_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(again.status).toBe(204);
		} finally {
			await server.stop(true);
		}
	});

	test('an error Google reports is a callback too', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const origin = server.url.origin;
		try {
			const denied = `${MAIL_CALLBACK_ROUTE.url(origin)}?error=access_denied&state=the-state`;
			expect((await fetch(denied)).status).toBe(200);
			const collected = await fetch(MAIL_PENDING_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await collected.json()).toEqual({ callbackUrl: denied });
		} finally {
			await server.stop(true);
		}
	});

	test('without a code it is the WebView loading its own route, and the SPA is served', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const origin = server.url.origin;
		try {
			const page = await fetch(MAIL_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(page.status).toBe(200);
			expect(await page.text()).not.toContain('close this tab');

			const collected = await fetch(MAIL_PENDING_CALLBACK_ROUTE.url(origin), {
				headers: authenticatedHeaders(server),
			});
			expect(collected.status).toBe(204);
		} finally {
			await server.stop(true);
		}
	});

	test('collecting requires a browser session, so only a window may read it', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const origin = server.url.origin;
		try {
			await fetch(`${MAIL_CALLBACK_ROUTE.url(origin)}?code=the-code`);
			const unauthenticated = await fetch(
				MAIL_PENDING_CALLBACK_ROUTE.url(origin),
			);
			expect(unauthenticated.status).toBe(401);
		} finally {
			await server.stop(true);
		}
	});
});

describe('local blob routes', () => {
	test('the same blob ID reads different bytes for each device owner', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const blobs = createTestBlobs();
		const id = generateBlobId('txt');
		const owners = ['no-account', 'accounts/61/61', 'accounts/61/62'];
		for (const owner of owners) {
			expectOk(await blobs(TEST_APP_ID, owner).put(id, new Blob([owner])));
		}
		const server = await serveHost(host, PAGE, { blobs });
		try {
			for (const owner of owners) {
				const response = await fetch(
					`${server.url.origin}${testBlobUrl(id)}?owner=${encodeURIComponent(owner)}`,
					{ headers: authenticatedHeaders(server) },
				);
				expect(response.status).toBe(200);
				expect(await response.text()).toBe(owner);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('GET, range, cancellation and 416 release borrowed files while HEAD opens none', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const directory = testDataDir();
		const store = createBunBlobStore({ directory });
		const id = generateBlobId('bin');
		expectOk(await store.put(id, new Blob([new Uint8Array(8 * 1024 * 1024)])));
		let acquired = 0;
		let closed = 0;
		const openFile = store.openFile;
		spyOn(store, 'openFile').mockImplementation(async (key) => {
			const result = await openFile(key);
			if (!result.error) {
				acquired++;
				const close = result.data.close;
				result.data.close = async () => {
					closed++;
					await close();
				};
			}
			return result;
		});
		const server = await serveHost(host, PAGE, { blobs: () => store });
		const { cookie, origin } = authenticationFor(server);
		const url = `${origin}${testBlobUrl(id)}`;
		try {
			expect(
				(await fetch(url, { method: 'HEAD', headers: { cookie } })).status,
			).toBe(200);
			expect(acquired).toBe(0);
			for (const range of [undefined, 'bytes=0-7', 'bytes=99999999-']) {
				const response = await fetch(url, {
					headers: { cookie, ...(range ? { range } : {}) },
				});
				await response.arrayBuffer();
				expect(closed).toBe(acquired);
			}
			const cancelled = await fetch(url, { headers: { cookie } });
			await cancelled.body!.cancel();
			const deadline = Date.now() + 2000;
			while (closed !== acquired && Date.now() < deadline) await Bun.sleep(5);
			expect(acquired).toBe(4);
			expect(closed).toBe(4);
		} finally {
			await server.stop(true);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test('session authentication protects every local blob operation', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const id = generateBlobId('bin');
		try {
			for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
				const response = await fetch(`${server.url.origin}${testBlobUrl(id)}`, {
					method,
				});
				expect(response.status).toBe(401);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('committed local files list in pages and remain isolated by app', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		const { cookie, origin } = authenticationFor(server);
		const ids = [generateBlobId('wav'), generateBlobId('wav')].sort();
		try {
			for (const id of ids)
				expect(
					(
						await fetch(`${origin}${testBlobUrl(id)}`, {
							method: 'PUT',
							headers: { cookie, origin, 'content-type': 'audio/wav' },
							body: 'audio',
						})
					).status,
				).toBe(201);
			const first = await fetch(
				`${origin}/api/apps/${TEST_APP_ID}/blobs?limit=1`,
				{ headers: { cookie } },
			);
			expect(first.status).toBe(200);
			expect(await first.json()).toEqual({
				items: [{ id: ids[0], size: 5, contentType: 'audio/wav' }],
				nextCursor: ids[0],
			});
			const second = await fetch(
				`${origin}/api/apps/${TEST_APP_ID}/blobs?limit=1&cursor=${ids[0]}`,
				{ headers: { cookie } },
			);
			expect(await second.json()).toEqual({
				items: [{ id: ids[1], size: 5, contentType: 'audio/wav' }],
			});
			expect(
				(
					await fetch(
						`${origin}${testBlobUrl(ids[0]!, 'so.epicenter.other')}`,
						{ headers: { cookie } },
					)
				).status,
			).toBe(404);
			for (const suffix of ['?limit=0', '?cursor=invalid', '?owner=alice'])
				expect(
					(
						await fetch(`${origin}/api/apps/${TEST_APP_ID}/blobs${suffix}`, {
							headers: { cookie },
						})
					).status,
				).toBe(400);
		} finally {
			await server.stop(true);
		}
	});

	test('put, head, byte-range forms, collision, and idempotent delete share one id', async () => {
		await using host = await createTestHost({
			engine: scriptedEngine([[]]),
		});
		const server = await serveHost(host);
		const id = generateBlobId('bin');
		const url = `${server.url.origin}${testBlobUrl(id)}`;
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
			expect(head.headers.get('content-type')).toBe('application/octet-stream');
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

			const emptyId = generateBlobId('txt');
			const emptyUrl = `${server.url.origin}${testBlobUrl(emptyId)}`;
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
		const id = generateBlobId('bin');
		const url = `${server.url.origin}${testBlobUrl(id)}`;
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
				`${server.url.origin}/api/apps/so.epicenter.whispering/blobs/not-a-blob-id`,
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
			const scriptSrc =
				cspDirectives(response.headers.get('content-security-policy')).get(
					'script-src',
				) ?? [];
			expect(
				scriptSrc.some((token) => token.startsWith("'sha256-")),
			).toBeTrue();
			expect(scriptSrc).not.toContain("'unsafe-inline'");
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
						protocolVersion: 3,
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
	test('the spawned entrypoint installs and serves an app, then drives a turn', async () => {
		const page = await buildSpaOnce();
		const appsDist = writeAppsDistFixture(page);
		const dataDir = testDataDir();
		const releaseRoot = testDataDir();
		const installedAppId = 'so.epicenter.installed-e2e';
		const installedPage = applicationPage('Installed release');
		mkdirSync(releaseRoot, { recursive: true });
		writeFileSync(
			join(releaseRoot, 'manifest.json'),
			JSON.stringify({
				id: installedAppId,
				title: 'Installed release',
				version: '1.0.0',
			}),
		);
		writeFileSync(join(releaseRoot, 'index.html'), installedPage);
		const install = Bun.spawn(
			[
				'bun',
				'run',
				'scripts/install.ts',
				'--',
				releaseRoot,
				'--data-dir',
				dataDir,
			],
			{
				cwd: queryDir,
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		expect(await install.exited).toBe(0);
		expect(await new Response(install.stdout).text()).toContain(
			`Installed Installed release (${installedAppId})`,
		);
		expect(
			await Bun.file(
				join(dataDir, 'apps', installedAppId, 'bundle', 'index.html'),
			).text(),
		).toBe(installedPage);

		// The fake OpenAI-compatible backend. One request and one text answer:
		// the spawned host has no tool catalog to call into, so what this proves
		// end to end is the installer, sidecar, installed SPA, session, and socket.
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
				return openAiSse(FINAL_TEXT_TURN);
			},
		});

		const portProbe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = boundPort(portProbe);
		await portProbe.stop(true);
		const folderDir = testDataDir();
		const ignoredDirectory = testDataDir();
		const sidecar = Bun.spawn(
			['bun', 'run', 'src/main.ts', '--runtime-mode=development'],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
					EPICENTER_DATA_DIR: ignoredDirectory,
					EPICENTER_FOLDER_DIR: ignoredDirectory,
					// The engine POSTs `${baseURL}/chat/completions`, so the base
					// carries the `/v1` prefix.
					EPICENTER_INFERENCE_URL: `${inference.url.origin}/v1`,
					EPICENTER_INFERENCE_MODEL: 'fake-model',
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			// The credential and Rust-resolved port travel in the boot frame.
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 3, token: TOKEN, port, authCell: null, dataDir, folderDir })}\n`,
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
			// Startup paths win even when the child environment names other roots.
			const headers = { cookie: cookie ?? '', origin };
			const applications = await fetch(APPLICATIONS_ROUTE.url(origin), {
				headers,
			});
			expect(applications.status).toBe(200);
			expect((await applications.json()).apps).toContainEqual({
				id: installedAppId,
				title: 'Installed release',
			});
			const installed = await fetch(`${origin}/apps/${installedAppId}/`, {
				headers,
			});
			expect(installed.status).toBe(200);
			expect(withoutAuthBootstrap(await installed.text())).toBe(installedPage);

			const blobId = generateBlobId('txt');
			const put = await fetch(`${origin}${testBlobUrl(blobId)}`, {
				method: 'PUT',
				headers,
				body: 'native-selected bytes',
			});
			expect(put.status).toBe(201);
			expect(
				await Bun.file(
					join(
						dataDir,
						'apps',
						'so.epicenter.whispering',
						'device',
						'no-account',
						'blobs',
						blobId,
					),
				).text(),
			).toBe('native-selected bytes');
			expect(
				await Bun.file(join(ignoredDirectory, 'blobs', blobId)).exists(),
			).toBe(false);
			const checkoutUrl = `${origin}${CHECKOUT_PATH}/so.epicenter.honeycrisp`;
			const before = await fetch(checkoutUrl, { headers });
			await before.text();
			const checkedOut = await fetch(checkoutUrl, {
				method: 'PUT',
				headers: { ...headers, 'if-match': before.headers.get('etag') ?? '' },
				body: `${JSON.stringify({ path: 'kv.json', contents: '{}' })}\n`,
			});
			expect(checkedOut.status).toBe(204);
			expect(
				await Bun.file(
					join(folderDir, 'so.epicenter.honeycrisp', 'kv.json'),
				).text(),
			).toBe('{}');
			expect(
				await Bun.file(
					join(ignoredDirectory, 'so.epicenter.honeycrisp', 'kv.json'),
				).exists(),
			).toBe(false);

			const served = await fetch(HOME_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(withoutAuthBootstrap(await served.text())).toBe(page);

			const session = await fetch(SESSION_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(session.status).toBe(200);
			const catalog = (await session.json()) as HomeSessionResponse;
			// No tools: the host owns no application data and composes no
			// in-process catalog over it (ADR-0226).
			expect(catalog.tools).toEqual([]);
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
				ws.send(JSON.stringify({ type: 'send', content: 'say something' }));
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
				expect.objectContaining({ type: 'text', text: FINAL_TEXT }),
			);
			expect(inferenceRequests).toBe(1);
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
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 3, token: TOKEN, port: occupiedPort, authCell: null, dataDir: testDataDir(), folderDir: testDataDir() })}\n`,
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
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: 3, token: TOKEN, port, authCell: null, dataDir: testDataDir(), folderDir: testDataDir() })}\n`,
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

describe('checkout routes (ADR-0337)', () => {
	/**
	 * The seam neither side's tests reach. `packages/app/src/data`'s checkout test
	 * injects a `fetch` and asserts what would have crossed the wire;
	 * `checkout.test.ts` here calls the host's functions directly. Between them
	 * sits the routing, and an earlier per-file version declared a bare `*` tail
	 * that Hono routes but does not capture, so every write arrived with an
	 * empty path and 400'd. Both suites stayed green and the folder was never
	 * written once.
	 *
	 * A checkout carries its files in the body now, so there is no path in the
	 * URL to capture wrong. These exist anyway, because "the folder is written"
	 * and "the folder is read back" are the two facts only a request can
	 * establish.
	 */
	const checkout = (files: object[]) =>
		files.map((file) => `${JSON.stringify(file)}\n`).join('');

	test('a checkout replaces the folder, and reads back as what was written', async () => {
		const folderRoot = mkdtempSync(join(tmpdir(), 'checkout-route-test-'));
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host, PAGE, { folderRoot });
		const origin = server.url.origin;
		const url = `${origin}${CHECKOUT_PATH}/so.epicenter.honeycrisp`;
		const folder = join(folderRoot, 'so.epicenter.honeycrisp');
		try {
			// Session-gated like every other domain API on this origin: these
			// routes write, delete, and read real files under a person's home
			// directory.
			expect((await fetch(url, { method: 'PUT', body: '' })).status).toBe(401);
			expect((await fetch(url)).status).toBe(401);

			/** The folder as it stands, which every write has to name. */
			const reading = async () => {
				const response = await fetch(url, {
					headers: authenticatedHeaders(server),
				});
				const etag = response.headers.get('etag');
				if (etag === null) throw new Error('the read stated no folder');
				return { etag, body: await response.text() };
			};

			// A write with no reading behind it is one nobody approved, and the
			// wire refuses it rather than trusting the library to have asked.
			const unprepared = await fetch(url, {
				method: 'PUT',
				body: checkout([{ path: 'kv.json', contents: '{}' }]),
				headers: authenticatedHeaders(server),
			});
			expect(unprepared.status).toBe(428);

			const empty = await reading();
			const wrote = await fetch(url, {
				method: 'PUT',
				headers: { ...authenticatedHeaders(server), 'if-match': empty.etag },
				body: checkout([
					{
						path: 'notes/abc.md',
						contents: '---\npinned: true\n---\n\n# A note\n',
					},
					{ path: 'notes/def.md', contents: '---\npinned: false\n---\n' },
					{ path: 'kv.json', contents: '{}' },
					{ path: '.epicenter/manifest.json', contents: '{"rows":{}}' },
				]),
			});
			expect(wrote.status).toBe(204);
			expect(await Bun.file(join(folder, 'notes/abc.md')).text()).toContain(
				'# A note',
			);

			// The write it was prepared against is gone now, so sending it again
			// is refused and the folder is untouched.
			const replayed = await fetch(url, {
				method: 'PUT',
				headers: { ...authenticatedHeaders(server), 'if-match': empty.etag },
				body: checkout([{ path: 'kv.json', contents: '{}' }]),
			});
			expect(replayed.status).toBe(412);
			expect(await Bun.file(join(folder, 'notes/abc.md')).exists()).toBe(true);

			// A second checkout that no longer names one row takes its file with
			// it. A checkout is complete by definition, so absence is the answer
			// rather than a manifest line saying so.
			const swept = await fetch(url, {
				method: 'PUT',
				headers: {
					...authenticatedHeaders(server),
					'if-match': (await reading()).etag,
				},
				body: checkout([
					{ path: 'notes/abc.md', contents: '---\npinned: true\n---\n' },
					{ path: 'kv.json', contents: '{}' },
					{ path: '.epicenter/manifest.json', contents: '{"rows":{}}' },
				]),
			});
			expect(swept.status).toBe(204);
			expect(await Bun.file(join(folder, 'notes/def.md')).exists()).toBe(false);
			expect(await Bun.file(join(folder, 'notes/abc.md')).exists()).toBe(true);

			// And the read hands back exactly what a checkout is responsible for,
			// which is what `pull` compares against its manifest before it
			// overwrites anything.
			writeFileSync(join(folder, 'README.md'), 'mine');
			const read = await fetch(url, { headers: authenticatedHeaders(server) });
			expect(read.status).toBe(200);
			const paths = (await read.text())
				.split('\n')
				.filter((line) => line.trim() !== '')
				.map((line) => (JSON.parse(line) as { path: string }).path)
				.sort();
			expect(paths).toEqual([
				'.epicenter/manifest.json',
				'kv.json',
				'notes/abc.md',
			]);
			// The person's own file is still there, and was never the host's to
			// hand over or to sweep.
			expect(await Bun.file(join(folder, 'README.md')).text()).toBe('mine');
			// And the read states which folder it handed back, which is the only
			// thing a write is allowed to name.
			expect(read.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
		} finally {
			await server.stop(true);
			rmSync(folderRoot, { recursive: true, force: true });
		}
	});

	test('a data id the render never produces is refused', async () => {
		const folderRoot = mkdtempSync(join(tmpdir(), 'checkout-route-test-'));
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host, PAGE, { folderRoot });
		const origin = server.url.origin;
		try {
			const refused = [
				`${CHECKOUT_PATH}/so.epicenter.honeycrisp/notes/abc.md`,
				`${CHECKOUT_PATH}/..%2F..%2Fetc`,
				`${CHECKOUT_PATH}/not_an_app_id`,
			];
			for (const path of refused) {
				const response = await fetch(`${origin}${path}`, {
					method: 'PUT',
					body: checkout([{ path: 'notes/abc.md', contents: 'x' }]),
					// A path the host cannot name is refused before it looks at
					// anything else, so this never reaches the folder's identity.
					headers: { ...authenticatedHeaders(server), 'if-match': '"x"' },
				});
				expect([400, 404]).toContain(response.status);
			}
			// A file inside the checkout that would climb out is refused by the
			// host without costing the checkout its other files.
			const checkoutUrl = `${origin}${CHECKOUT_PATH}/so.epicenter.honeycrisp`;
			const fresh = await fetch(checkoutUrl, {
				headers: authenticatedHeaders(server),
			});
			const mixed = await fetch(checkoutUrl, {
				method: 'PUT',
				body: checkout([
					{ path: '../escape.md', contents: 'no' },
					{ path: 'notes/ok.md', contents: 'yes' },
				]),
				headers: {
					...authenticatedHeaders(server),
					'if-match': fresh.headers.get('etag') as string,
				},
			});
			expect(mixed.status).toBe(204);
			expect(await Bun.file(join(folderRoot, 'escape.md')).exists()).toBe(
				false,
			);
			expect(
				await Bun.file(
					join(folderRoot, 'so.epicenter.honeycrisp/notes/ok.md'),
				).exists(),
			).toBe(true);
		} finally {
			await server.stop(true);
			rmSync(folderRoot, { recursive: true, force: true });
		}
	});
});

describe('the application storage owner', () => {
	test('desktop SQLite carries binary parameters and results through the actual server socket', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const root = testDataDir();
		const server = await serveHost(host, PAGE, {
			device: createBunDevice(root),
		});
		const { cookie, origin } = authenticationFor(server);
		class AuthenticatedSocket extends BunWebSocket {
			constructor(url: string) {
				super(url, { headers: { cookie, origin } });
			}
		}
		const owner = createDesktopSqliteOwner({
			baseURL: origin,
			webSocket: AuthenticatedSocket as unknown as typeof WebSocket,
		});
		try {
			const lifetime = await owner.acquire(LOCAL_MAIL_APP_ID);
			try {
				const database = await lifetime.open('binary');
				expectOk(
					await database.run('CREATE TABLE values_test(bytes BLOB, text TEXT)'),
				);
				expectOk(
					await database.run('INSERT INTO values_test VALUES (?, ?)', [
						new Uint8Array([0, 1, 255]),
						'a\0b',
					]),
				);
				expect(
					expectOk(await database.all('SELECT bytes, text FROM values_test')),
				).toEqual([{ bytes: new Uint8Array([0, 1, 255]), text: 'a\0b' }]);
				expect(
					(await database.run('SELECT ?', [Infinity])).error,
				).not.toBeNull();
				expect(
					expectOk(
						await database.all('SELECT count(*) AS count FROM values_test'),
					),
				).toEqual([{ count: 1 }]);
			} finally {
				await lifetime.close();
			}
		} finally {
			await server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	});

	async function post(server: TestServer, body: unknown) {
		const { cookie, origin } = authenticationFor(server);
		return fetch(`${server.url.origin}${DEVICE_PATH}`, {
			method: 'POST',
			headers: { cookie, origin, 'content-type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	test('SQL sockets retire connections on delete and release their lifetime on reload without deleting files', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const root = testDataDir();
		const server = await serveHost(host, PAGE, {
			device: createBunDevice(root),
		});
		const { cookie, origin } = authenticationFor(server);
		const url = `${server.url.origin}${DEVICE_PATH}/sqlite`;
		const address = { appId: LOCAL_MAIL_APP_ID };
		const sockets: WebSocket[] = [];
		async function connect() {
			const socket = new BunWebSocket(url.replace('http:', 'ws:'), {
				headers: { cookie, origin },
			});
			sockets.push(socket);
			await new Promise<void>((resolve, reject) => {
				socket.addEventListener('open', () => resolve(), { once: true });
				socket.addEventListener('error', reject, { once: true });
			});
			return socket;
		}
		let id = 0;
		async function request(socket: WebSocket, body: unknown) {
			const requestId = ++id;
			const reply = new Promise<{
				response?: Record<string, unknown>;
				failure?: string;
			}>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('SQLite reply timed out')),
					3000,
				);
				socket.addEventListener(
					'message',
					(event) => {
						clearTimeout(timer);
						const frame = JSON.parse(String(event.data));
						expect(frame.id).toBe(requestId);
						resolve(frame);
					},
					{ once: true },
				);
			});
			socket.send(JSON.stringify({ id: requestId, request: body }));
			return reply;
		}
		async function disconnect(socket: WebSocket) {
			const closed = new Promise<void>((resolve) =>
				socket.addEventListener('close', () => resolve(), { once: true }),
			);
			socket.close();
			await closed;
		}
		try {
			expect((await fetch(url)).status).toBe(401);
			expect((await fetch(url, { headers: { cookie } })).status).toBe(403);
			expect(
				(await post(server, { kind: 'sqlite-acquire', ...address })).status,
			).toBe(400);
			const socket = await connect();
			for (const body of [
				{ kind: 'sqlite-acquire', appId: '../escape' },
				{
					kind: 'sqlite-run',
					...address,
					name: 'mail',
					statement: { sql: 'SELECT 1' },
				},
				{ kind: 'secret-get', appId: LOCAL_MAIL_APP_ID, label: 'secret' },
			])
				expect((await request(socket, body)).failure).toBeDefined();
			const acquired = await request(socket, {
				kind: 'sqlite-acquire',
				...address,
			});
			const session = { ...address, lifetimeId: acquired.response?.lifetimeId };
			expect(typeof session.lifetimeId).toBe('string');
			expect(
				(await request(socket, { kind: 'sqlite-acquire', ...address })).failure,
			).toBeDefined();
			const opened = await request(socket, {
				kind: 'sqlite-open',
				...session,
				name: 'mail',
			});
			const connectionId = opened.response?.connectionId;
			expect(typeof connectionId).toBe('string');
			expect(
				(
					await request(socket, {
						kind: 'sqlite-delete',
						...session,
						name: 'mail',
					})
				).response,
			).toEqual({ kind: 'sqlite-delete' });
			const reopened = await request(socket, {
				kind: 'sqlite-open',
				...session,
				name: 'mail',
			});
			const freshId = reopened.response?.connectionId;
			expect(freshId).not.toBe(connectionId);
			const statement = { sql: 'SELECT name FROM sqlite_master' };
			expect(
				(
					await request(socket, {
						kind: 'sqlite-all',
						...session,
						connectionId,
						statement,
					})
				).failure,
			).toBeDefined();
			expect(
				(
					await request(socket, {
						kind: 'sqlite-run',
						...session,
						connectionId: freshId,
						statement: { sql: 'CREATE TABLE kept (value TEXT)' },
					})
				).failure,
			).toBeUndefined();
			expect(
				(
					await request(socket, {
						kind: 'sqlite-run',
						...session,
						connectionId: freshId,
						statement: { sql: "INSERT INTO kept VALUES ('survives reload')" },
					})
				).failure,
			).toBeUndefined();
			// Reload loses the document socket without sending sqlite-close.
			await disconnect(socket);
			const next = await connect();
			const reacquired = await request(next, {
				kind: 'sqlite-acquire',
				...address,
			});
			expect(reacquired.failure).toBeUndefined();
			const nextSession = {
				...address,
				lifetimeId: reacquired.response?.lifetimeId,
			};
			expect(
				(
					await request(next, {
						kind: 'sqlite-all',
						...session,
						connectionId: freshId,
						statement,
					})
				).failure,
			).toBeDefined();
			const nextOpen = await request(next, {
				kind: 'sqlite-open',
				...nextSession,
				name: 'mail',
			});
			const rows = await request(next, {
				kind: 'sqlite-all',
				...nextSession,
				connectionId: nextOpen.response?.connectionId,
				statement: { sql: 'SELECT value FROM kept' },
			});
			expect(rows.response).toEqual({
				kind: 'sqlite-all',
				rows: [{ value: 'survives reload' }],
			});
			expect(
				(await request(next, { kind: 'sqlite-close', ...nextSession }))
					.response,
			).toEqual({ kind: 'sqlite-close' });
			await disconnect(next);
		} finally {
			for (const socket of sockets)
				if (socket.readyState === 1) await disconnect(socket);
			await server.stop(true);
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('holds one labeled secret per application', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host, PAGE, {
			appSecrets: createProcessMemoryAppSecrets(),
		});
		try {
			const stored = await post(server, {
				kind: 'secret-put',
				appId: LOCAL_MAIL_APP_ID,
				label: 'account-one',
				value: 'refresh-token',
			});
			expect(stored.status).toBe(200);

			const read = await post(server, {
				kind: 'secret-get',
				appId: LOCAL_MAIL_APP_ID,
				label: 'account-one',
			});
			expect(await read.json()).toEqual({
				kind: 'secret-get',
				value: 'refresh-token',
			});

			// Namespaced per application, so the same label under another
			// application is a different secret rather than the same one.
			const neighbour = await post(server, {
				kind: 'secret-get',
				appId: 'so.epicenter.other',
				label: 'account-one',
			});
			expect(await neighbour.json()).toEqual({
				kind: 'secret-get',
				value: null,
			});

			await post(server, {
				kind: 'secret-delete',
				appId: LOCAL_MAIL_APP_ID,
				label: 'account-one',
			});
			const gone = await post(server, {
				kind: 'secret-get',
				appId: LOCAL_MAIL_APP_ID,
				label: 'account-one',
			});
			expect(await gone.json()).toEqual({ kind: 'secret-get', value: null });
		} finally {
			await server.stop(true);
		}
	});

	test('refuses a label that could name something other than one label', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host, PAGE, {
			appSecrets: createProcessMemoryAppSecrets(),
		});
		try {
			for (const label of ['../other', 'a/b', 'a:b', '']) {
				const refused = await post(server, {
					kind: 'secret-get',
					appId: LOCAL_MAIL_APP_ID,
					label,
				});
				expect(refused.status).toBe(400);
			}
		} finally {
			await server.stop(true);
		}
	});

	test('reports an absent secret owner rather than pretending to hold one', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host);
		try {
			const unavailable = await post(server, {
				kind: 'secret-get',
				appId: LOCAL_MAIL_APP_ID,
				label: 'account-one',
			});
			expect(unavailable.status).toBe(503);
		} finally {
			await server.stop(true);
		}
	});
});
