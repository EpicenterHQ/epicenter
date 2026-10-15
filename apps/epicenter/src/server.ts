import type { AiCatalog } from './ai-catalog.ts';
import { createAiCatalogRoutes } from './ai-catalog-routes.ts';
/**
 * The Bun-owned Device origin: trusted SPA documents, the account broker, and
 * the AI catalog. The launch credential can only mint short-lived browser
 * sessions at the bootstrap route; it never appears in a URL or durable
 * browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { deviceOwnerPath } from '@epicenter/principal';
import { type Context, Hono, type Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';
import {
	ACCOUNT_CANCEL_CONNECTION_ROUTE,
	ACCOUNT_SIGN_IN_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	BOOTSTRAP_ROUTE,
	BUILT_IN_ROUTES,
	SIGN_IN_CALLBACK_ROUTE,
} from './routes.ts';
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
	/** One credential owner for every compiled desktop window. */
	desktopAuth: DesktopAuthAuthority;
	aiCatalog?: AiCatalog;
	noAccountAiCatalog?: AiCatalog;
};

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;
const SESSION_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Device</title><script>window.__EPICENTER_SESSION_READY__.then(() => window.location.reload())</script></head><body></body></html>`;
const RESTART_REQUIRED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Restart Epicenter</title></head><body><h1>Restart Epicenter to continue</h1><p>This session has ended. Quit and reopen Epicenter. If the account change failed, your saved sign-in may not have changed.</p></body></html>`;

export function createHomeServer({
	origin,
	launchToken,
	staticAssets,
	installedApplications,
	desktopAuth,
	aiCatalog,
	noAccountAiCatalog,
}: HomeServerOptions) {
	if (launchToken === '') {
		throw new Error('Device refuses to serve without a launch token.');
	}
	const bootAccount = desktopAuth.account;
	const activeUrl = validateOrigin(origin);
	const activeHost = activeUrl.host;
	const sessionHashes = new Set<string>();
	const homePage = injectAuthBootstrap(
		staticAssets.homePage,
		desktopAuth.bootSnapshot,
	);
	const servedApps = staticAssets.applications.map((application) => ({
		id: application.id,
		page: injectAuthBootstrap(application.page, desktopAuth.bootSnapshot),
		resolve: application.resolve,
	}));
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
	// Development has no installed macOS URL handler. The pending authority
	// accepts only its exact callback and random state; no Home cookie is used.
	if (desktopAuth.callbackUrl === SIGN_IN_CALLBACK_ROUTE.url(origin)) {
		app.get(SIGN_IN_CALLBACK_ROUTE.pattern, (c) => {
			c.header('cache-control', 'no-store');
			if (!desktopAuth.acceptSignInCallback(c.req.url))
				return c.text(
					'This sign-in attempt is no longer active. Start again in Epicenter.',
					400,
				);
			return c.html(
				'<!doctype html><html><head><meta charset="utf-8"><title>Epicenter</title></head><body><p>Return to Epicenter to finish signing in. You can close this tab.</p></body></html>',
			);
		});
	}
	const hasBrowserSession = (c: Context) => {
		const session = getCookie(c, SESSION_COOKIE);
		return session !== undefined && sessionHashes.has(tokenHash(session));
	};

	const requireBrowserSession = async (c: Context, next: Next) => {
		if (!hasBrowserSession(c)) return c.text('Unauthorized', 401);
		await next();
	};
	const requirePrivateBroker = async (c: Context, next: Next) => {
		if (!hasBrowserSession(c)) return c.text('Unauthorized', 401);
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		await next();
	};
	// Windows issue identity commands and relay Account traffic through Bun;
	// no server credential crosses into a WebView. GET and HEAD require the
	// browser session without an Origin header, which same-origin reads omit.
	// Mutations and sync upgrades additionally require the exact Origin.
	app.use('/_epicenter/account/*', async (c, next) => {
		const response =
			c.req.method === 'GET' || c.req.method === 'HEAD'
				? await requireBrowserSession(c, next)
				: await requirePrivateBroker(c, next);
		if (desktopAuth.restartRequired)
			c.header('x-epicenter-auth-state', 'signed-out');
		return response;
	});

	app.use('/_epicenter/ai/*', async (c, next) => {
		c.header('cache-control', 'no-store');
		if (c.req.method === 'GET' || c.req.method === 'HEAD')
			return requireBrowserSession(c, next);
		return requirePrivateBroker(c, next);
	});
	if (aiCatalog)
		app.route(
			`/_epicenter/ai/${deviceOwnerPath(bootAccount ?? undefined).replaceAll('/', '_')}`,
			createAiCatalogRoutes(aiCatalog),
		);
	if (bootAccount && noAccountAiCatalog)
		app.route(
			'/_epicenter/ai/no-account',
			createAiCatalogRoutes(noAccountAiCatalog),
		);

	app.all('/_epicenter/account/http', async (c) => {
		const account = desktopAuth.account;
		if (!account) return c.text('Signed out', 401);
		const path = c.req.query('path');
		if (!path?.startsWith('/') || path.startsWith('//') || path.includes('\\'))
			return c.text('Invalid account path', 400);
		const target = new URL(path, account.baseURL);
		if (
			target.origin !== new URL(account.baseURL).origin ||
			!(
				target.pathname.startsWith('/api/') ||
				target.pathname.startsWith('/v1/')
			)
		)
			return c.text('Invalid account path', 400);
		const headers = relayHeaders(c.req.raw.headers);
		const body: BodyInit | undefined =
			c.req.method === 'GET' || c.req.method === 'HEAD'
				? undefined
				: (c.req.raw.body ?? undefined);
		try {
			const response = await account.fetch(
				new Request(target, {
					method: c.req.method,
					headers,
					body,
					signal: c.req.raw.signal,
					redirect: 'manual',
				}),
			);
			const outgoing = relayHeaders(response.headers);
			// HEAD carries metadata only, so no decompression can change its length.
			const length = response.headers.get('content-length');
			if (c.req.method === 'HEAD' && length !== null)
				outgoing.set('content-length', length);
			outgoing.delete('set-cookie');
			outgoing.delete('content-encoding');
			outgoing.delete('location');
			outgoing.set('cache-control', 'no-store');
			outgoing.set('x-epicenter-auth-state', desktopAuth.getState().status);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: outgoing,
			});
		} catch (error) {
			c.header('x-epicenter-auth-state', desktopAuth.getState().status);
			if (desktopAuth.getState().status === 'signed-out')
				return c.text('Signed out', 401);
			if (
				typeof error === 'object' &&
				error !== null &&
				'name' in error &&
				error.name === 'AccountUnavailable' &&
				'code' in error
			)
				return c.text('Account network access unavailable', 401);
			return c.text('Account transport unavailable', 502);
		}
	});
	app.post(ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern, async (c) => {
		const { error } = await desktopAuth.cancelConnection();
		if (error)
			return c.text(
				'Could not cancel sign-in. Restart Epicenter to continue.',
				500,
			);
		return c.body(null, 204);
	});
	app.post(ACCOUNT_SIGN_IN_ROUTE.pattern, async (c) => {
		const body: unknown = await c.req.json().catch(() => null);
		if (
			typeof body !== 'object' ||
			body === null ||
			Array.isArray(body) ||
			('reauthenticate' in body && typeof body.reauthenticate !== 'boolean')
		)
			return c.text('Invalid sign-in options.', 400);
		const { error } = await desktopAuth.startSignIn({
			reauthenticate:
				'reauthenticate' in body ? (body.reauthenticate as boolean) : undefined,
		});
		if (error) return c.text('Sign-in failed', 502);
		return c.body(null, 202);
	});
	app.post(ACCOUNT_SIGN_OUT_ROUTE.pattern, async (c) => {
		const { error } = await desktopAuth.signOut();
		if (error) return c.text('Sign-out failed', 500);
		return c.body(null, 202);
	});

	// Home: one document, no asset tree behind it.
	app.get(BUILT_IN_ROUTES.home.pattern, (c) => {
		c.header('cache-control', 'no-store');
		if (desktopAuth.restartRequired) return c.html(RESTART_REQUIRED_PAGE);
		if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
		return c.html(homePage);
	});
	/**
	 * One application's asset tree, with the document served from memory so
	 * every client route lands on the stamped page. `csp` replaces the
	 * origin's policy for a document whose inline scripts it does not hash.
	 */
	const serveApplication = async (
		c: Context,
		application: {
			id: string;
			page: string;
			resolve: ServedApplicationAssets['resolve'];
		},
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
			if (desktopAuth.restartRequired) return c.html(RESTART_REQUIRED_PAGE);
			if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
			return servePage(c);
		}
		const asset = await application.resolve(pathname);
		if (!asset) return c.text('Not Found', 404);
		c.header('cache-control', 'no-store');
		if (asset.isDocument && desktopAuth.restartRequired)
			return c.html(RESTART_REQUIRED_PAGE);
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
		const page = injectAuthBootstrap(installed.page, desktopAuth.bootSnapshot);
		return serveApplication(
			c,
			{ id: installed.id, page, resolve: installed.resolve },
			contentSecurityPolicy(`${everyPage}\n${page}`),
		);
	});
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	return { app };
}

/**
 * Stamp one served page with the one-shot auth bootstrap.
 *
 * This is the only thing the host injects. An app window parses the bootstrap
 * and then removes it, because it carries an identity snapshot that has no
 * business sitting in the DOM afterwards, and nothing else may read it: which
 * replica an app window opens is decided by which build the host serves, not by
 * what survives in its `<head>`.
 */
function injectAuthBootstrap(
	page: string,
	snapshot: DesktopAuthAuthority['bootSnapshot'],
): string {
	const serialized = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
	const element = `<script id="epicenter-auth-bootstrap" type="application/json">${serialized}</script>`;
	const head = page.search(/<\/head\s*>/i);
	if (head !== -1) return `${page.slice(0, head)}${element}${page.slice(head)}`;
	// A document with no `</head>` and no `<body` used to come back unstamped,
	// which is the worst of the three outcomes: the app loads, finds no
	// snapshot, and boots signed out with nothing anywhere saying why. The
	// element is inert JSON read by id, so where it lands does not matter and
	// prepending always works. Position is a preference; stamping is not.
	const body = page.search(/<body\b/i);
	return body === -1
		? `${element}${page}`
		: `${page.slice(0, body)}${element}${page.slice(body)}`;
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

/** Only end-to-end application headers cross the credential boundary. */
function relayHeaders(source: Headers): Headers {
	const headers = new Headers(source);
	const connectionHeaders = headers.get('connection')?.split(',') ?? [];
	for (const name of [
		...connectionHeaders,
		'authorization',
		'cookie',
		'host',
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
		'content-length',
	])
		headers.delete(name.trim());
	return headers;
}
