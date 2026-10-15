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
 * - Home and each compiled application serve their builds; Mail and Books stay placeholders
 * - Unknown, non-canonical, and traversal-shaped app paths stay closed
 * - Host, Origin, CSP, frame, and referrer policies are enforced
 * - Malformed WebSocket frames drop silently without killing the socket
 * - The real vite build emits one document with no external asset references
 * - The spawned `main.ts` sidecar announces versioned readiness, serves the
 *   built SPA, and drives a streamed turn against an OpenAI-compatible endpoint
 *
 * See also:
 * - `host.test.ts` for tool catalog composition and turn execution
 * - `packages/client/src/openai-provider.test.ts` for the SSE frame shapes
 *   the fake inference endpoint below reuses
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
import { epicenterCloud } from '@epicenter/auth';
import { expectOk } from 'wellcrafted/testing';
import { COMPILED_APPLICATIONS } from './applications.ts';
import { createDesktopAuthAuthority } from './desktop-auth-authority.js';
import { createHomeHost, type HomeHost, type HomeHostInputs } from './host.ts';
import {
	ACCOUNT_SIGN_OUT_ROUTE,
	BOOTSTRAP_ROUTE,
	BUILT_IN_ROUTES,
	FOLDERS_ROUTE,
	HOME_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	WHISPERING_ROUTE,
} from './routes.ts';
import {
	createHomeServer,
	type HomeServerEvent,
	type HomeSessionResponse,
} from './server.ts';
import {
	type ReadyFrame,
	SIDECAR_PROTOCOL_VERSION,
} from './sidecar-runtime.ts';
import {
	createInstalledApplications,
	type EpicenterStaticAssets,
	loadStaticAssets,
} from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { createTestDesktopAuth } from './test-home-host.ts';

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
		accountManagement: true,
		server: epicenterCloud('https://api.epicenter.so'),
		authCell: null,
		callbackUrl,
		nativeAuthPort: {
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
		host,
		origin,
		launchToken: 'launch',
		staticAssets: await createAppsDistFixture(PAGE),

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

test.each([
	'restart',
	'storage',
	'boot-verification',
] as const)('failed %s serves restart-required documents without stale boot identity', async (failure) => {
	await using host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	using desktopAuth = createDesktopAuthAuthority({
		server: epicenterCloud('https://api.epicenter.so'),
		accountManagement: true,
		authCell: JSON.stringify({
			origin: 'https://api.epicenter.so',
			auth: { token: 'alice-token', principalId: 'alice' },
		}),
		nativeAuthPort: {
			completed: new Promise(() => {}),
			async storeAuth() {
				if (failure === 'storage')
					throw new Error('keychain write acknowledgement failed');
			},
			async openAuthUrl() {},
			onAuthCallback() {
				return () => false;
			},
			relaunch() {
				throw new Error('native restart failed');
			},
		},
		fetch: async () =>
			failure === 'boot-verification'
				? Response.json({ principalId: 'other' })
				: new Response(null),
	});
	const origin = 'http://127.0.0.1:49152';
	const { app } = createHomeServer({
		host,
		origin,
		launchToken: 'launch',
		staticAssets: await createAppsDistFixture(PAGE),
		desktopAuth,
	});
	const bootstrap = await app.request(origin + '/_epicenter/bootstrap', {
		method: 'POST',
		headers: {
			host: new URL(origin).host,
			origin,
			authorization: 'Bearer launch',
		},
	});
	const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
	if (failure === 'boot-verification') {
		await expect(
			desktopAuth.account!.fetch('/api/example'),
		).rejects.toBeDefined();
		expect(desktopAuth.restartRequired).toBe(true);
	} else {
		const signout = await app.request(ACCOUNT_SIGN_OUT_ROUTE.url(origin), {
			method: 'POST',
			headers: { host: new URL(origin).host, origin, cookie },
		});
		expect(signout.status).toBe(500);
		expect(signout.headers.get('x-epicenter-auth-state')).toBe('signed-out');
	}

	for (const route of [
		HOME_ROUTE.url(origin),
		WHISPERING_ROUTE.url(origin),
		FOLDERS_ROUTE.url(origin),
	]) {
		for (const credential of [cookie, '']) {
			const response = await app.request(route, {
				headers: { host: new URL(origin).host, cookie: credential },
			});
			const html = await response.text();
			expect(html).toContain('Restart Epicenter to continue');
			expect(html).not.toContain('epicenter-auth-bootstrap');
			expect(html).not.toContain('<script');
			expect(response.headers.get('cache-control')).toBe('no-store');
		}
	}
	await expect(
		desktopAuth.account!.fetch('/api/example'),
	).rejects.toBeDefined();
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

async function serveHost(host: HomeHost, page: string = PAGE) {
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
		desktopAuth: createTestDesktopAuth(),
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
			await expect(
				loadStaticAssets(root, COMPILED_APPLICATIONS),
			).rejects.toThrow(new RegExp(`${absent.title} asset root is missing`));
		}

		const missingHome = writeAppsDist({
			homePage: PAGE,
			applicationPage: ({ title }) => applicationPage(title),
		});
		rmSync(join(missingHome, 'home'), { recursive: true });
		await expect(
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
				host,
				origin: 'http://127.0.0.1:39130',
				launchToken: '',
				staticAssets,
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
			host,
			origin,
			launchToken: TOKEN,
			staticAssets: await createAppsDistFixture(),
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

	test('serves an installed app from its current build behind the session gate', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const origin = 'http://127.0.0.1:43128';
		const buildsDir = mkdtempSync(join(tmpdir(), 'epicenter-builds-'));
		const id = 'com.example.board';
		const first = 'a'.repeat(40);
		const second = 'b'.repeat(40);
		const build = (commit: string, title: string) => {
			mkdirSync(join(buildsDir, id, commit, 'assets'), { recursive: true });
			writeFileSync(
				join(buildsDir, id, commit, 'index.html'),
				`<!doctype html><html><head><title>${title}</title><script>boot()</script></head><body></body></html>`,
			);
			writeFileSync(
				join(buildsDir, id, commit, 'assets', 'app.js'),
				`// ${title}`,
			);
			writeFileSync(join(buildsDir, id, 'current'), `${commit}\n`);
		};
		build(first, 'one');
		const { app } = createHomeServer({
			host,
			origin,
			launchToken: TOKEN,
			staticAssets: await createAppsDistFixture(),
			installedApplications: createInstalledApplications(buildsDir),
			desktopAuth: createTestDesktopAuth(),
		});
		const headers = { host: '127.0.0.1:43128' };
		const get = (path: string, cookie?: string) =>
			app.request(`${origin}${path}`, {
				headers: cookie === undefined ? headers : { ...headers, cookie },
			});

		const shell = await get(`/apps/${id}/?folder=data%3Avault`);
		expect(await shell.text()).toContain('__EPICENTER_SESSION_READY__');
		expect((await get(`/apps/${id}/assets/app.js`)).status).toBe(401);

		const bootstrap = await app.request(BOOTSTRAP_ROUTE.url(origin), {
			method: 'POST',
			headers: { ...headers, origin, authorization: `Bearer ${TOKEN}` },
		});
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		if (cookie === undefined) throw new Error('test bootstrap set no cookie');

		const page = await get(`/apps/${id}/?folder=data%3Avault`, cookie);
		const text = await page.text();
		expect(text).toContain('<title>one</title>');
		expect(text).toContain('epicenter-auth-bootstrap');
		// The document's own inline script is admitted by its policy.
		const hash = createHash('sha256').update('boot()').digest('base64');
		expect(page.headers.get('content-security-policy')).toContain(
			`'sha256-${hash}'`,
		);
		expect(await (await get(`/apps/${id}/assets/app.js`, cookie)).text()).toBe(
			'// one',
		);
		expect(
			await (await get(`/apps/${id}/some/route`, cookie)).text(),
		).toContain('<title>one</title>');

		// A new build is served once the shell makes it current.
		build(second, 'two');
		expect(await (await get(`/apps/${id}/`, cookie)).text()).toContain(
			'<title>two</title>',
		);

		for (const path of [
			'/apps/com.example.missing/',
			'/apps/Board/',
			`/apps/${id}/%2e%2e/%2e%2e/elsewhere`,
			`/apps/${id}/%2e%2e/current`,
		]) {
			expect((await get(path, cookie)).status).toBe(404);
		}
		writeFileSync(join(buildsDir, id, 'current'), '../../elsewhere\n');
		expect((await get(`/apps/${id}/`, cookie)).status).toBe(404);
	});

	test('serves Home and every compiled application', async () => {
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
				{ id: 'folders', pattern: '/apps/folders/' },
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
			// Apps that used to be compiled in are installed now (ADR-0552): their
			// old routes serve nothing.
			for (const id of ['honeycrisp', 'capture', 'mail', 'todos', 'books']) {
				const gone = await fetch(`${server.url.origin}/apps/${id}/`, {
					headers: authenticatedHeaders(server),
				});
				expect(gone.status).toBe(404);
			}

			const folders = await fetch(FOLDERS_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(withoutAuthBootstrap(await folders.text())).toBe(
				applicationPage('Folders'),
			);

			for (const response of [
				query,
				whispering,
				whisperingAsset,
				vadAsset,
				clientRoute,
				folders,
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
			// The server therefore sees this as the one canonical Folders path.
			const browserFragment = await fetch(
				`${FOLDERS_ROUTE.url(server.url.origin)}#compose`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(browserFragment.status).toBe(200);
			expect(withoutAuthBootstrap(await browserFragment.text())).toBe(
				applicationPage('Folders'),
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

	test('every application document reaches only this host', async () => {
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
			const closed = ["'self'", 'ipc:', 'http://ipc.localhost'];
			expect(await connectSrc(HOME_ROUTE.url(origin))).toEqual(closed);
			expect(await connectSrc(WHISPERING_ROUTE.url(origin))).toEqual(closed);
			expect(await connectSrc(FOLDERS_ROUTE.url(origin))).toEqual(closed);
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

			const selected = await fetch(`${origin}/_epicenter/account/connect`, {
				method: 'POST',
				headers: { cookie, origin, 'content-type': 'application/json' },
				body: JSON.stringify({ server: 'https://self.example' }),
			});
			expect(selected.status).toBe(404);

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
async function readReadyFrame(
	sidecar: {
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
	},
	timeoutMs: number,
): Promise<ReadyFrame> {
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
						protocolVersion: SIDECAR_PROTOCOL_VERSION,
						port: ready.port,
					});
					return ready;
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
	test('the spawned entrypoint serves a compiled app, then drives a turn', async () => {
		const page = await buildSpaOnce();
		const appsDist = writeAppsDistFixture(page);
		const dataDir = testDataDir();

		// The fake OpenAI-compatible backend. One request and one text answer:
		// the spawned host has no tool catalog to call into, so what this proves
		// end to end is the sidecar, a compiled SPA, session, and socket.
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
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port, authCell: null, authServer: { baseURL: 'https://api.epicenter.so', authorityId: 'epicenter-api' }, accountManagement: true, dataDir, folderDir, cacheDir: testDataDir() })}\n`,
			);
			await sidecar.stdin.flush();
			const ready = await readReadyFrame(sidecar, 30_000);
			expect(ready.port).toBe(port);
			const origin = `http://127.0.0.1:${ready.port}`;

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
			const whispering = await fetch(WHISPERING_ROUTE.url(origin), {
				headers,
			});
			expect(whispering.status).toBe(200);
			expect(withoutAuthBootstrap(await whispering.text())).toBe(
				WHISPERING_PAGE,
			);

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
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port: occupiedPort, authCell: null, authServer: { baseURL: 'https://api.epicenter.so', authorityId: 'epicenter-api' }, accountManagement: true, dataDir: testDataDir(), folderDir: testDataDir(), cacheDir: testDataDir() })}\n`,
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
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port, authCell: null, authServer: { baseURL: 'https://api.epicenter.so', authorityId: 'epicenter-api' }, accountManagement: true, dataDir: testDataDir(), folderDir: testDataDir(), cacheDir: testDataDir() })}\n`,
			);
			await sidecar.stdin.flush();
			const ready = await readReadyFrame(sidecar, 30_000);
			expect(ready.port).toBe(port);
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

describe('retired store checkout routes', () => {
	test('GET and PUT no longer expose a store working copy', async () => {
		await using host = await createTestHost({ engine: scriptedEngine([[]]) });
		const server = await serveHost(host, PAGE);
		try {
			const url = `${server.url.origin}/api/checkout/so.epicenter.honeycrisp`;
			for (const method of ['GET', 'PUT']) {
				const response = await fetch(url, {
					method,
					headers: authenticatedHeaders(server),
				});
				expect(response.status).toBe(404);
			}
		} finally {
			await server.stop(true);
		}
	});
});
