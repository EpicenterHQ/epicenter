/**
 * Home Server Tests
 *
 * Verifies the loopback shell (ADR-0084): the exact Host and Origin checks
 * protect the loopback boundary, Tauri bootstraps HttpOnly browser sessions
 * without a URL token, and Settings is served at its final route.
 *
 * Key behaviors:
 * - The launch token is accepted only by the bootstrap route
 * - Served documents require an HttpOnly browser session
 * - Settings and each compiled application serve their builds
 * - Unknown, non-canonical, and traversal-shaped app paths stay closed
 * - Host, Origin, CSP, frame, and referrer policies are enforced
 * - The real vite build emits one document with no external asset references
 * - The spawned `epicenter-binary.ts __host` sidecar announces versioned readiness and serves
 *   the built SPA
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
import { COMPILED_APPLICATIONS } from './applications.ts';
import {
	BOOTSTRAP_ROUTE,
	BUILT_IN_ROUTES,
	FOLDERS_ROUTE,
	HOME_ROUTE,
} from './routes.ts';
import { createHomeServer } from './server.ts';
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

const TOKEN = 'per-launch-secret';

/** A stand-in for the built SPA document; `/` must return it byte-for-byte. */
const PAGE = '<!doctype html><html><body>Home test page</body></html>';
const applicationPage = (title: string) =>
	`<!doctype html><html><body>${title} test application</body></html>`;
const FOLDERS_PAGE = applicationPage('Folders');

/** Parse a Content-Security-Policy header into directive name to its token list. */
function cspDirectives(header: string | null): Map<string, string[]> {
	const directives = new Map<string, string[]>();
	for (const directive of (header ?? '').split(';')) {
		const [name, ...tokens] = directive.trim().split(/\s+/);
		if (name !== undefined && name !== '') directives.set(name, tokens);
	}
	return directives;
}

const queryDir = fileURLToPath(new URL('..', import.meta.url));
type TestServer = ReturnType<typeof Bun.serve>;
const serverAuthentication = new WeakMap<
	TestServer,
	{ cookie: string; origin: string }
>();

function testDataDir(): string {
	return mkdtempSync(join(tmpdir(), 'query-server-test-'));
}

function boundPort(server: { port?: number }): number {
	if (server.port === undefined) throw new Error('server did not bind a port');
	return server.port;
}

async function serveHost(page: string = PAGE) {
	const portProbe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = boundPort(portProbe);
	await portProbe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const { app } = createHomeServer({
		origin,
		launchToken: TOKEN,
		staticAssets: await createAppsDistFixture(page),
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
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
	mkdirSync(join(root, 'folders', '_app', 'immutable'), { recursive: true });
	mkdirSync(join(root, 'folders', 'vad'), { recursive: true });
	writeFileSync(
		join(root, 'folders', '_app', 'immutable', 'entry.js'),
		'window.foldersLoaded = true;',
	);
	writeFileSync(
		join(root, 'folders', 'vad', 'silero_vad_v5.onnx'),
		'vad-model',
	);
	// The onnxruntime binary the VAD trigger compiles in the WebView. It belongs
	// in the fixture because a policy that admits WebAssembly is only truthful if
	// the WebAssembly it admits is actually served from this origin.
	writeFileSync(
		join(root, 'folders', 'vad', 'ort-wasm-simd-threaded.wasm'),
		'\0asm\x01\0\0\0',
	);
	return root;
}

function authenticationFor(server: TestServer) {
	const authentication = serverAuthentication.get(server);
	if (authentication === undefined) throw new Error('unknown test server');
	return authentication;
}

function authenticatedHeaders(server: TestServer) {
	return { cookie: authenticationFor(server).cookie };
}

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
		const folders = applicationAssets(assets, 'folders');
		const nested = await folders.resolve(
			'/apps/folders/_app/immutable/entry.js',
		);
		expect(nested?.contentType).toContain('text/javascript');
		expect(await nested?.file.text()).toContain('foldersLoaded');

		const vad = await folders.resolve('/apps/folders/vad/silero_vad_v5.onnx');
		expect(await vad?.file.text()).toBe('vad-model');

		const fallback = await folders.resolve(
			'/apps/folders/settings/transcription',
		);
		expect(await fallback?.file.text()).toBe(FOLDERS_PAGE);
		expect(
			await folders.resolve('/apps/folders/_app/missing.js'),
		).toBeUndefined();
	});

	test('rejects raw, encoded, double-encoded, and symlink traversal', async () => {
		const root = writeAppsDistFixture();
		const outside = mkdtempSync(join(tmpdir(), 'epicenter-outside-assets-'));
		writeFileSync(join(outside, 'secret.txt'), 'outside secret');
		symlinkSync(
			join(outside, 'secret.txt'),
			join(root, 'folders', 'linked-secret.txt'),
		);
		symlinkSync(
			join(outside, 'secret.txt'),
			join(root, 'folders', 'linked-secret'),
		);
		const assets = await loadStaticAssets(root, COMPILED_APPLICATIONS);
		const folders = applicationAssets(assets, 'folders');

		for (const pathname of [
			'/apps/folders/../home/index.html',
			'/apps/folders/%2e%2e/home/index.html',
			'/apps/folders/%252e%252e/home/index.html',
			'/apps/folders/%2fetc/passwd',
			'/apps/folders/%252fetc/passwd',
			'/apps/folders//etc/passwd',
			'/apps/folders/..\\query\\index.html',
			'/apps/folders/%00index.html',
			'/apps/folders/linked-secret.txt',
			'/apps/folders/linked-secret',
		]) {
			expect(await folders.resolve(pathname)).toBeUndefined();
		}
	});
});

describe('createHomeServer', () => {
	test('refuses an empty launch token and non-loopback origins', async () => {
		const staticAssets = await createAppsDistFixture();
		expect(() =>
			createHomeServer({
				origin: 'http://127.0.0.1:39130',
				launchToken: '',
				staticAssets,
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
					origin,
					launchToken: TOKEN,
					staticAssets,
				}),
			).toThrow(/exact http:\/\/127\.0\.0\.1/);
		}
	});

	test('the launch token mints a browser session only at bootstrap', async () => {
		const server = await serveHost();
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
				`${HOME_ROUTE.url(origin)}?token=${TOKEN}`,
			);
			expect(await queryToken.text()).toContain('__EPICENTER_SESSION_READY__');
		} finally {
			await server.stop(true);
		}
	});

	test('serves only the session shell before bootstrap', async () => {
		const server = await serveHost();
		try {
			const shell = await fetch(HOME_ROUTE.url(server.url.origin));
			expect(shell.status).toBe(200);
			expect(await shell.text()).toContain('__EPICENTER_SESSION_READY__');
			expect(shell.headers.get('cache-control')).toBe('no-store');
			const page = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await page.text()).toBe(PAGE);

			// Home Chat's session routes, and the routes before them, are gone.
			for (const retired of [
				'/api/home/session',
				'/api/home/session/stream',
				'/api/tools',
				'/ws',
			]) {
				const response = await fetch(`${server.url.origin}${retired}`, {
					headers: authenticatedHeaders(server),
				});
				expect(response.status).toBe(404);
			}
		} finally {
			await server.stop(true);
		}
	});
	test('serves an installed app from its current build behind the session gate', async () => {
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
			origin,
			launchToken: TOKEN,
			staticAssets: await createAppsDistFixture(),
			installedApplications: createInstalledApplications(buildsDir),
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
		expect(text).not.toContain('epicenter-auth-bootstrap');
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
		const server = await serveHost();
		try {
			expect(
				Object.values(BUILT_IN_ROUTES).map(({ id, pattern }) => ({
					id,
					pattern,
				})),
			).toEqual([
				{ id: 'home', pattern: '/apps/home/' },
				{ id: 'folders', pattern: '/apps/folders/' },
			]);

			const query = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			// The host stamps nothing: the page is the build, byte for byte.
			expect(await query.text()).toBe(PAGE);

			const folders = await fetch(FOLDERS_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(await folders.text()).toBe(FOLDERS_PAGE);
			const foldersAsset = await fetch(
				`${server.url.origin}/apps/folders/_app/immutable/entry.js?v=1`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(await foldersAsset.text()).toContain('foldersLoaded');
			expect(foldersAsset.headers.get('content-type')).toContain(
				'text/javascript',
			);
			const vadAsset = await fetch(
				`${server.url.origin}/apps/folders/vad/silero_vad_v5.onnx`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(await vadAsset.text()).toBe('vad-model');
			const clientRoute = await fetch(
				`${server.url.origin}/apps/folders/settings/transcription?tab=models`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(await clientRoute.text()).toBe(FOLDERS_PAGE);
			// Apps that used to be compiled in are installed now (ADR-0552): their
			// old routes serve nothing.
			for (const id of [
				'whispering',
				'honeycrisp',
				'capture',
				'mail',
				'todos',
				'books',
			]) {
				const gone = await fetch(`${server.url.origin}/apps/${id}/`, {
					headers: authenticatedHeaders(server),
				});
				expect(gone.status).toBe(404);
			}

			for (const response of [
				query,
				folders,
				foldersAsset,
				vadAsset,
				clientRoute,
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
		const server = await serveHost();
		try {
			for (const path of [
				'/apps/unknown/',
				'/apps/home/extra',
				'/apps/home%2f',
				'/apps/home/%2e%2e/%2e%2e/package.json',
				'/apps/home/%252e%252e/%252e%252e/package.json',
				'/apps/folders/missing.js',
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
			expect(await queryState.text()).toBe(PAGE);

			// URL fragments are browser state and are not sent in an HTTP request.
			// The server therefore sees this as the one canonical Folders path.
			const browserFragment = await fetch(
				`${FOLDERS_ROUTE.url(server.url.origin)}#compose`,
				{ headers: authenticatedHeaders(server) },
			);
			expect(browserFragment.status).toBe(200);
			expect(await browserFragment.text()).toBe(applicationPage('Folders'));
		} finally {
			await server.stop(true);
		}
	});

	test('rejects wrong Host and Origin and serves the browser security policy', async () => {
		const server = await serveHost();
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
		const server = await serveHost();
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
				`${server.url.origin}/apps/folders/vad/ort-wasm-simd-threaded.wasm`,
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
		const server = await serveHost();
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
			expect(await connectSrc(FOLDERS_ROUTE.url(origin))).toEqual(closed);
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

		const server = await serveHost(page);
		try {
			const response = await fetch(HOME_ROUTE.url(server.url.origin), {
				headers: authenticatedHeaders(server),
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(page);
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
// Sidecar End-to-End Smoke (the real `__host` entrypoint)
// ============================================================================

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
	test('the spawned entrypoint serves Settings and a compiled app', async () => {
		const page = await buildSpaOnce();
		const appsDist = writeAppsDistFixture(page);
		const dataDir = testDataDir();

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
			[
				'bun',
				'run',
				'src/epicenter-binary.ts',
				'__host',
				'--runtime-mode=development',
			],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
					EPICENTER_DATA_DIR: ignoredDirectory,
					EPICENTER_FOLDER_DIR: ignoredDirectory,
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			// The credential and Rust-resolved port travel in the boot frame.
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port, dataDir, folderDir, cacheDir: testDataDir() })}\n`,
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
			const folders = await fetch(FOLDERS_ROUTE.url(origin), {
				headers,
			});
			expect(folders.status).toBe(200);
			expect(await folders.text()).toBe(FOLDERS_PAGE);

			const served = await fetch(HOME_ROUTE.url(origin), {
				headers: { cookie: cookie ?? '' },
			});
			expect(await served.text()).toBe(page);
		} finally {
			sidecar.kill('SIGTERM');
			expect(await sidecar.exited).toBe(0);
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
			[
				'bun',
				'run',
				'src/epicenter-binary.ts',
				'__host',
				'--runtime-mode=development',
			],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port: occupiedPort, dataDir: testDataDir(), folderDir: testDataDir(), cacheDir: testDataDir() })}\n`,
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
			[
				'bun',
				'run',
				'src/epicenter-binary.ts',
				'__host',
				'--runtime-mode=development',
			],
			{
				cwd: queryDir,
				env: {
					...process.env,
					EPICENTER_APPS_DIST: appsDist,
				},
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		try {
			sidecar.stdin.write(
				`${JSON.stringify({ type: 'boot', protocolVersion: SIDECAR_PROTOCOL_VERSION, token: TOKEN, port, dataDir: testDataDir(), folderDir: testDataDir(), cacheDir: testDataDir() })}\n`,
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
		const server = await serveHost(PAGE);
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
