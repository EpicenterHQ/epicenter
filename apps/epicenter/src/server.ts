/**
 * The Bun-owned Device origin: trusted SPA documents. The launch credential
 * can only mint short-lived browser sessions at the bootstrap route; it never
 * appears in a URL or durable browser storage. The host holds no account: a
 * page's account requests go through the `epicenter` CLI (ADR-0556).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { BOOTSTRAP_ROUTE, BUILT_IN_ROUTES } from './routes.ts';
import type {
	EpicenterStaticAssets,
	InstalledApplications,
	ServedApplicationAssets,
} from './static-assets.ts';

export type HomeServerOptions = {
	/** Exact active origin, including the Rust-selected explicit port. */
	origin: string;
	/** Per-launch credential received from Rust over stdin. */
	launchToken: string;
	/** Home's document and every compiled application's release build. */
	staticAssets: EpicenterStaticAssets;
	/** Installed apps' current builds (ADR-0540). */
	installedApplications?: InstalledApplications;
};

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;
const SESSION_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Device</title><script>window.__EPICENTER_SESSION_READY__.then(() => window.location.reload())</script></head><body></body></html>`;

export function createHomeServer({
	origin,
	launchToken,
	staticAssets,
	installedApplications,
}: HomeServerOptions) {
	if (launchToken === '') {
		throw new Error('Device refuses to serve without a launch token.');
	}
	const activeUrl = validateOrigin(origin);
	const activeHost = activeUrl.host;
	const sessionHashes = new Set<string>();
	const homePage = staticAssets.homePage;
	const servedApps = staticAssets.applications;
	// One text for every policy: an inline script's hash has to be admitted
	// wherever that document may be served, and only the reachable origins
	// differ between applications.
	const everyPage = [
		homePage,
		...servedApps.map(({ page }) => page),
		SESSION_SHELL,
	].join('\n');
	const csp = contentSecurityPolicy(everyPage);
	const app = new Hono();

	app.use('*', async (c, next) => {
		if (c.req.header('host') !== activeHost) {
			return c.text('Misdirected Request', 421);
		}
		const requestOrigin = c.req.header('origin');
		if (requestOrigin !== undefined && requestOrigin !== origin) {
			return c.text('Forbidden', 403);
		}

		c.header('content-security-policy', csp);
		c.header('referrer-policy', 'no-referrer');
		c.header('x-content-type-options', 'nosniff');
		c.header('x-frame-options', 'DENY');
		await next();
	});

	app.post(BOOTSTRAP_ROUTE.pattern, (c) => {
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		const header = c.req.header('authorization');
		const candidate = header?.startsWith('Bearer ')
			? header.slice('Bearer '.length)
			: undefined;
		if (candidate === undefined || !tokensMatch(candidate, launchToken)) {
			return c.text('Unauthorized', 401);
		}

		const session = randomBytes(32).toString('base64url');
		sessionHashes.add(tokenHash(session));
		while (sessionHashes.size > MAX_BROWSER_SESSIONS) {
			const oldest = sessionHashes.values().next().value;
			if (oldest === undefined) break;
			sessionHashes.delete(oldest);
		}
		setCookie(c, SESSION_COOKIE, session, {
			httpOnly: true,
			path: '/',
			sameSite: 'Strict',
		});
		return c.body(null, 204);
	});
	const hasBrowserSession = (c: Context) => {
		const session = getCookie(c, SESSION_COOKIE);
		return session !== undefined && sessionHashes.has(tokenHash(session));
	};

	// Home: one document, no asset tree behind it.
	app.get(BUILT_IN_ROUTES.home.pattern, (c) => {
		c.header('cache-control', 'no-store');
		if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
		return c.html(homePage);
	});
	/**
	 * One application's asset tree, with the document served from memory so
	 * every client route lands on the same page. `csp` replaces the origin's
	 * policy for a document whose inline scripts it does not hash.
	 */
	const serveApplication = async (
		c: Context,
		application: ServedApplicationAssets,
		csp?: string,
	) => {
		const prefix = `/apps/${application.id}/`;
		const servePage = (c: Context) => {
			if (csp !== undefined) c.header('content-security-policy', csp);
			return c.html(application.page);
		};
		const pathname = new URL(c.req.url).pathname;
		if (pathname === prefix || pathname === `${prefix}index.html`) {
			c.header('cache-control', 'no-store');
			if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
			return servePage(c);
		}
		const asset = await application.resolve(pathname);
		if (!asset) return c.text('Not Found', 404);
		c.header('cache-control', 'no-store');
		if (!hasBrowserSession(c)) {
			return asset.isDocument
				? c.html(SESSION_SHELL)
				: c.text('Unauthorized', 401);
		}
		if (asset.isDocument) return servePage(c);
		c.header('content-type', asset.contentType);
		return c.body(asset.file.stream());
	};
	for (const application of servedApps) {
		app.get(`/apps/${application.id}/*`, (c) =>
			serveApplication(c, application),
		);
	}
	// An installed app, served exactly as a compiled one from the build the
	// shell made current (ADR-0540). Its document is read after boot, so its
	// inline scripts are hashed into its own policy.
	app.get('/apps/:id/*', async (c) => {
		const installed = await installedApplications?.find(c.req.param('id'));
		if (installed === undefined) return c.text('Not Found', 404);
		return serveApplication(
			c,
			installed,
			contentSecurityPolicy(`${everyPage}\n${installed.page}`),
		);
	});
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	return { app };
}

function validateOrigin(origin: string): URL {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Invalid Device origin: ${origin}`);
	}
	if (
		url.origin !== origin ||
		url.protocol !== 'http:' ||
		url.hostname !== '127.0.0.1' ||
		url.port === '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		throw new Error(
			'Device origin must be exact http://127.0.0.1:<port> without credentials or a path.',
		);
	}
	return url;
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

function tokensMatch(candidate: string, expected: string): boolean {
	const a = createHash('sha256').update(candidate).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * The one policy every document on this origin is served: an application
 * talks to the host and to no one else. Tauri's `security.csp` does not reach
 * these windows, because every application is served over
 * `http://127.0.0.1`, so this header is the only policy the WebView enforces.
 */
function contentSecurityPolicy(page: string): string {
	const scriptHashes = [
		...page.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
	]
		.map((match) => match[1] ?? '')
		.map(
			(script) =>
				`'sha256-${createHash('sha256').update(script).digest('base64')}'`,
		);
	return [
		"default-src 'self'",
		// `'wasm-unsafe-eval'` permits WebAssembly compilation and nothing else:
		// it does not restore `eval` or `new Function`, which is why it exists
		// separately from `'unsafe-eval'`. Voice activity detection runs
		// onnxruntime in this WebView over assets Device itself ships, so
		// WebAssembly is a first-party capability of the app window rather than
		// something a policy is being bent to tolerate. Without it the browser
		// refuses the compile and the recording trigger dies mid-boot.
		`script-src 'self' 'wasm-unsafe-eval' ${scriptHashes.join(' ')}`,
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self' ipc: http://ipc.localhost",
		"img-src 'self' data: blob:",
		"media-src 'self' data: blob:",
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"frame-ancestors 'none'",
	].join('; ');
}
