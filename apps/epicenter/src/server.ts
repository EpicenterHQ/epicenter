/**
 * The Bun-owned Epicenter origin: trusted SPA documents, Home APIs, and the
 * Home session WebSocket. The launch credential can only mint short-lived
 * browser sessions at the bootstrap route; it never appears in a URL or
 * durable browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentToolDefinition } from '@epicenter/agent';
import { getProfileVia } from '@epicenter/auth';
import {
	DESKTOP_RECORD_ROUTE,
	type DesktopRecordEpicenterOwner,
} from '@epicenter/data/desktop-record-owner';
import { type Context, Hono, type Next } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createDesktopAuthorityFetch } from './desktop-authority-fetch.ts';
import {
	type HomeHost,
	type HomeSessionSnapshot,
	parseHomeCommand,
} from './host.ts';
import {
	ACCOUNT_INSTANCE_ROUTE,
	ACCOUNT_PROFILE_ROUTE,
	ACCOUNT_SIGN_IN_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	BOOTSTRAP_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SURFACE_ROUTES,
	type SurfaceId,
} from './routes.ts';
import type { AppCatalog, EpicenterStaticAssets } from './static-assets.ts';
import { PLACEHOLDER_SURFACE_PAGES } from './surface-pages.ts';

export type HomeServerEvent = {
	type: 'snapshot';
	snapshot: HomeSessionSnapshot;
};

export type HomeSessionResponse = {
	tools: AgentToolDefinition[];
	snapshot: HomeSessionSnapshot;
};

export type HomeServerOptions = {
	host: HomeHost;
	/** Exact active origin, including the Rust-selected explicit port. */
	origin: string;
	/** Per-launch credential received from Rust over stdin. */
	launchToken: string;
	/** Release-built documents and the contained Whispering asset resolver. */
	staticAssets: EpicenterStaticAssets;
	/** Derived trusted app catalog (ADR-0153); absent means no members. */
	appCatalog?: AppCatalog;
	/** The composition root's one Bun-owned record carrier capability. */
	recordOwner: Pick<DesktopRecordEpicenterOwner, 'execute'>;
	/** One credential owner for every compiled desktop surface. */
	desktopAuth: DesktopAuthAuthority;
};

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;
const SESSION_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Epicenter</title><script>window.__EPICENTER_SESSION_READY__.then(() => window.location.reload())</script></head><body></body></html>`;

export function createHomeServer({
	host,
	origin,
	launchToken,
	staticAssets,
	appCatalog = { apps: [] },
	recordOwner,
	desktopAuth,
}: HomeServerOptions) {
	if (launchToken === '') {
		throw new Error('Epicenter refuses to serve without a launch token.');
	}
	const activeUrl = validateOrigin(origin);
	const activeHost = activeUrl.host;
	const sessionHashes = new Set<string>();
	const surfacePages = {
		home: injectAuthBootstrap(staticAssets.homePage, desktopAuth.bootSnapshot),
		whispering: injectAuthBootstrap(
			staticAssets.whisperingPage,
			desktopAuth.bootSnapshot,
		),
		...PLACEHOLDER_SURFACE_PAGES,
	} satisfies Record<SurfaceId, string>;
	const csp = contentSecurityPolicy(
		`${Object.values(surfacePages).join('\n')}\n${SESSION_SHELL}`,
	);
	const deploymentFetch = createDesktopAuthorityFetch(desktopAuth);
	const { upgradeWebSocket, websocket } = createBunWebSocket();
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

	const requireBrowserSession = async (c: Context, next: Next) => {
		if (!hasBrowserSession(c)) return c.text('Unauthorized', 401);
		await next();
	};
	const requirePrivateBroker = async (c: Context, next: Next) => {
		if (!hasBrowserSession(c)) return c.text('Unauthorized', 401);
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		await next();
	};
	// The account broker carries only host-owned identity commands and the
	// profile projection. There is deliberately no authorize/bearer-grant
	// route: no credential ever crosses into a WebView, so the windows keep
	// the loopback-only CSP. The read-only profile GET is session-guarded
	// without the origin check because a browser omits the Origin header on
	// same-origin GETs.
	app.use('/_epicenter/account/*', async (c, next) => {
		if (c.req.method === 'GET') return requireBrowserSession(c, next);
		return requirePrivateBroker(c, next);
	});

	app.get(ACCOUNT_PROFILE_ROUTE.pattern, async (c) => {
		const profile = await getProfileVia(deploymentFetch, desktopAuth.baseURL);
		if (profile.error !== null) return c.text('Profile unavailable', 502);
		return c.json(profile.data);
	});
	app.post(ACCOUNT_SIGN_IN_ROUTE.pattern, async (c) => {
		const result = await desktopAuth.startSignIn();
		if (result.error) return c.text('Sign-in failed', 502);
		return c.body(null, 202);
	});
	app.post(ACCOUNT_SIGN_OUT_ROUTE.pattern, async (c) => {
		const result = await desktopAuth.signOut();
		if (result.error) return c.text('Sign-out failed', 500);
		return c.body(null, 202);
	});
	app.post(ACCOUNT_INSTANCE_ROUTE.pattern, async (c) => {
		const input = await readJsonObject(c.req.raw);
		if (
			input === null ||
			Object.keys(input).some((key) => key !== 'baseURL' && key !== 'token') ||
			typeof input.baseURL !== 'string' ||
			typeof input.token !== 'string'
		) {
			return c.text('Bad Request', 400);
		}
		try {
			await desktopAuth.selectInstance({
				baseURL: input.baseURL,
				token: input.token,
			});
			return c.body(null, 202);
		} catch {
			return c.text('Invalid instance', 400);
		}
	});
	app.delete(ACCOUNT_INSTANCE_ROUTE.pattern, async (c) => {
		await desktopAuth.selectHosted();
		return c.body(null, 202);
	});

	for (const surface of [
		SURFACE_ROUTES.home,
		SURFACE_ROUTES.mail,
		SURFACE_ROUTES.books,
	]) {
		app.get(surface.pattern, (c) => {
			c.header('cache-control', 'no-store');
			if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
			return c.html(surfacePages[surface.id]);
		});
	}
	app.get('/apps/whispering/*', async (c) => {
		const pathname = new URL(c.req.url).pathname;
		if (
			pathname === SURFACE_ROUTES.whispering.pattern ||
			pathname === `${SURFACE_ROUTES.whispering.pattern}index.html`
		) {
			c.header('cache-control', 'no-store');
			if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
			return c.html(surfacePages.whispering);
		}
		const asset = await staticAssets.resolveWhispering(pathname);
		if (!asset) return c.text('Not Found', 404);
		c.header('cache-control', 'no-store');
		if (!hasBrowserSession(c)) {
			return asset.isDocument
				? c.html(SESSION_SHELL)
				: c.text('Unauthorized', 401);
		}
		if (asset.isDocument) return c.html(surfacePages.whispering);
		c.header('content-type', asset.contentType);
		return c.body(asset.file.stream());
	});
	// Derived catalog members (ADR-0153). Reserved built-in IDs never reach
	// this handler: the surface routes above win registration order and the
	// catalog derivation refuses them.
	app.get('/apps/:appId/*', async (c) => {
		const member = appCatalog.apps.find(
			(catalogApp) => catalogApp.id === c.req.param('appId'),
		);
		if (!member) return c.text('Not Found', 404);
		const asset = await member.resolve(new URL(c.req.url).pathname);
		if (!asset) return c.text('Not Found', 404);
		c.header('cache-control', 'no-store');
		c.header('content-type', asset.contentType);
		return c.body(asset.file.stream());
	});
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	app.use('/api/apps', requireBrowserSession);
	app.use('/api/home/*', requireBrowserSession);
	app.use(DESKTOP_RECORD_ROUTE, requirePrivateBroker);
	app.use(SESSION_STREAM_ROUTE.pattern, async (c, next) => {
		if (c.req.header('origin') !== origin) return c.text('Forbidden', 403);
		await next();
	});

	app.get(SESSION_ROUTE.pattern, (c) =>
		c.json({
			tools: host.toolDefinitions(),
			snapshot: host.snapshot(),
		} satisfies HomeSessionResponse),
	);

	app.get('/api/apps', (c) =>
		c.json({
			apps: appCatalog.apps.map(({ id, title }) => ({ id, title })),
		}),
	);

	app.post(DESKTOP_RECORD_ROUTE, async (c) => {
		const input = await c.req.json().catch(() => undefined);
		const response = await recordOwner.execute(input);
		return c.json(response, response.error === null ? 200 : 400);
	});

	app.get(
		SESSION_STREAM_ROUTE.pattern,
		upgradeWebSocket(() => {
			let unsubscribe: (() => void) | undefined;
			const push = (ws: { send(data: string): void }) => {
				const event: HomeServerEvent = {
					type: 'snapshot',
					snapshot: host.snapshot(),
				};
				ws.send(JSON.stringify(event));
			};
			return {
				onOpen(_event, ws) {
					unsubscribe = host.subscribe(() => push(ws));
					push(ws);
				},
				onMessage(event, ws) {
					const command = parseHomeCommand(parseFrame(event.data));
					if (!command) return;
					void host.handleCommand(command);
					push(ws);
				},
				onClose() {
					unsubscribe?.();
				},
			};
		}),
	);

	return { app, websocket };
}

function injectAuthBootstrap(
	page: string,
	snapshot: DesktopAuthAuthority['bootSnapshot'],
): string {
	const serialized = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
	const element = `<script id="epicenter-auth-bootstrap" type="application/json">${serialized}</script>`;
	const head = page.search(/<\/head\s*>/i);
	return head === -1
		? page.replace(/<body\b/i, `${element}<body`)
		: `${page.slice(0, head)}${element}${page.slice(head)}`;
}

function validateOrigin(origin: string): URL {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Invalid Epicenter origin: ${origin}`);
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
			'Epicenter origin must be exact http://127.0.0.1:<port> without credentials or a path.',
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
		`script-src 'self' ${scriptHashes.join(' ')}`,
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

async function readJsonObject(
	request: Request,
): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown = await request.json();
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseFrame(data: unknown): unknown {
	if (typeof data !== 'string') return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}
