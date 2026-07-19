/**
 * The Bun-owned Epicenter origin: trusted SPA documents, Home APIs, and the
 * Home session WebSocket. The launch credential can only mint short-lived
 * browser sessions at the bootstrap route; it never appears in a URL or
 * durable browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getProfileVia } from '@epicenter/auth';
import { type BlobId, type BlobRemote, parseBlobId } from '@epicenter/blobs';
import type { BunBlobStore } from '@epicenter/blobs/bun';
import type { AgentToolDefinition } from '@epicenter/workspace/agent';
import {
	isDocumentRowAbsentError,
	isWorkspaceStorageMovedError,
} from '@epicenter/workspace/sqlite';
import type { DesktopWorkspaceOwner } from '@epicenter/workspace/sqlite/desktop-owner';
import { DesktopWorkspaceError } from '@epicenter/workspace/sqlite/desktop-owner';
import { type Context, Hono, type Next } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { Ok } from 'wellcrafted/result';
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
	LOCAL_BLOB_REMOTE_ROUTES,
	LOCAL_BLOB_ROUTE,
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
	workspaceOwner?: DesktopWorkspaceOwner;
	/** Canonical device-local bytes shared by every trusted app surface. */
	blobs: BunBlobStore;
	/** One credential owner for every compiled desktop surface. */
	desktopAuth: DesktopAuthAuthority;
	/**
	 * Host-owned remote copy capability over the same local bytes, or `null`
	 * when this signed-out process generation has none. The composition root
	 * builds it from the desktop authority, so these routes never see a
	 * credential or a destination URL.
	 */
	blobRemote: BlobRemote | null;
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
	workspaceOwner,
	blobs,
	desktopAuth,
	blobRemote,
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
	app.use('/api/workspaces/*', requireBrowserSession);
	app.use('/api/local-blobs/*', requireBrowserSession);
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

	app.put(LOCAL_BLOB_ROUTE.pattern, async (c) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (id === undefined) return c.text('Invalid blob id', 400);
		const result = await blobs.putRequest(id, c.req.raw);
		if (result.error === null) return c.body(null, 201);
		switch (result.error.name) {
			case 'BlobAlreadyExists':
				return c.text('Blob already exists', 409);
			case 'BlobStoreFailed':
				return c.text('Blob store failed', 500);
			default:
				return result.error satisfies never;
		}
	});

	// Hono derives HEAD from GET before considering explicit HEAD routes. A
	// middleware guard keeps HEAD metadata-only and preserves Content-Length.
	app.use(LOCAL_BLOB_ROUTE.pattern, async (c, next) => {
		if (c.req.method !== 'HEAD') {
			await next();
			return;
		}
		const id = parseBlobId(c.req.param('blobId'));
		if (id === undefined) return c.text('Invalid blob id', 400);
		const result = await blobs.stat(id);
		if (result.error !== null) {
			switch (result.error.name) {
				case 'BlobNotFound':
					return c.text('Blob not found', 404);
				case 'BlobStoreFailed':
					return c.text('Blob store failed', 500);
				default:
					return result.error satisfies never;
			}
		}
		return new Response(null, {
			headers: {
				...blobResponseHeaders(result.data.contentType),
				'content-length': String(result.data.size),
			},
		});
	});

	app.get(LOCAL_BLOB_ROUTE.pattern, async (c) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (id === undefined) return c.text('Invalid blob id', 400);
		const result = await blobs.openFile(id);
		if (result.error !== null) {
			switch (result.error.name) {
				case 'BlobNotFound':
					return c.text('Blob not found', 404);
				case 'BlobStoreFailed':
					return c.text('Blob store failed', 500);
				default:
					return result.error satisfies never;
			}
		}
		const rangeHeader = c.req.header('range');
		if (rangeHeader !== undefined) {
			const range = parseByteRange(rangeHeader, result.data.stat.size);
			if (range === undefined) {
				return new Response('Range Not Satisfiable', {
					status: 416,
					headers: {
						...blobResponseHeaders(result.data.stat.contentType),
						'content-range': `bytes */${result.data.stat.size}`,
					},
				});
			}
			return new Response(
				result.data.file.slice(
					range.start,
					range.endExclusive,
					result.data.stat.contentType,
				),
				{
					status: 206,
					headers: {
						...blobResponseHeaders(result.data.stat.contentType),
						'content-length': String(range.endExclusive - range.start),
						'content-range': `bytes ${range.start}-${range.endExclusive - 1}/${result.data.stat.size}`,
					},
				},
			);
		}
		return new Response(result.data.file, {
			headers: {
				...blobResponseHeaders(result.data.stat.contentType),
				'content-length': String(result.data.stat.size),
			},
		});
	});

	app.delete(LOCAL_BLOB_ROUTE.pattern, async (c) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (id === undefined) return c.text('Invalid blob id', 400);
		const result = await blobs.delete(id);
		if (result.error !== null) return c.text('Blob store failed', 500);
		return c.body(null, 204);
	});

	// Remote copy operations: the blob id in the path is the only input. The
	// host's own deployment authority supplies the target and credential, so
	// no request body, destination URL, or authorization header is read.
	const requireBlobRemote = (
		operate: (
			remote: BlobRemote,
			id: BlobId,
		) => Promise<
			| Awaited<ReturnType<BlobRemote['upload']>>
			| Awaited<ReturnType<BlobRemote['download']>>
			| Awaited<ReturnType<BlobRemote['purge']>>
		>,
	) => {
		return async (c: Context) => {
			const id = parseBlobId(c.req.param('blobId'));
			if (id === undefined) return c.text('Invalid blob id', 400);
			if (blobRemote === null) {
				return c.text('Remote storage unavailable', 503);
			}
			const result = await operate(blobRemote, id);
			if (result.error === null) return c.body(null, 204);
			switch (result.error.name) {
				case 'BlobNotFound':
				case 'RemoteBlobNotFound':
					return c.text(result.error.message, 404);
				case 'BlobStoreFailed':
					return c.text('Blob store failed', 500);
				case 'BlobRemoteFailed':
					return c.text('Remote operation failed', 502);
				default:
					return result.error satisfies never;
			}
		};
	};
	app.post(
		LOCAL_BLOB_REMOTE_ROUTES.upload.pattern,
		requireBlobRemote((remote, id) => remote.upload(id)),
	);
	app.post(
		LOCAL_BLOB_REMOTE_ROUTES.download.pattern,
		requireBlobRemote((remote, id) => remote.download(id)),
	);
	app.post(
		LOCAL_BLOB_REMOTE_ROUTES.purge.pattern,
		requireBlobRemote((remote, id) => remote.purge(id)),
	);

	app.post('/api/workspaces/:workspaceId/records', async (c) => {
		if (!workspaceOwner)
			return c.json(DesktopWorkspaceError.OwnerUnavailable(), 404);
		const workspaceId = c.req.param('workspaceId');
		if (!workspaceOwner.hasWorkspace(workspaceId)) {
			return c.json(
				DesktopWorkspaceError.UnknownWorkspace({ workspaceId }),
				404,
			);
		}
		try {
			return c.json(
				Ok(await workspaceOwner.execute(workspaceId, await c.req.json())),
			);
		} catch (cause) {
			// A displaced surface's request carries the shared moved-error name
			// so the WebView can flip its blocking moved screen.
			if (isWorkspaceStorageMovedError(cause)) {
				return c.json(
					DesktopWorkspaceError.WorkspaceStorageMovedError({ workspaceId }),
					409,
				);
			}
			if (isDocumentRowAbsentError(cause)) {
				return c.json(
					DesktopWorkspaceError.DocumentRowAbsentError({ workspaceId }),
					409,
				);
			}
			return c.json(DesktopWorkspaceError.InvalidRequest({ cause }), 400);
		}
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

function blobResponseHeaders(contentType: string): Record<string, string> {
	return {
		'accept-ranges': 'bytes',
		'cache-control': 'no-store',
		'content-disposition': 'attachment',
		'content-security-policy': "sandbox; default-src 'none'",
		'content-type': contentType,
		'cross-origin-resource-policy': 'same-origin',
		'x-content-type-options': 'nosniff',
	};
}

function parseByteRange(
	header: string,
	size: number,
): { start: number; endExclusive: number } | undefined {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (match === null || size === 0) return undefined;
	const [, startText = '', endText = ''] = match;
	if (startText === '' && endText === '') return undefined;

	if (startText === '') {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
			return undefined;
		}
		return {
			start: Math.max(size - suffixLength, 0),
			endExclusive: size,
		};
	}

	const start = Number(startText);
	if (!Number.isSafeInteger(start) || start < 0 || start >= size) {
		return undefined;
	}
	if (endText === '') return { start, endExclusive: size };

	const inclusiveEnd = Number(endText);
	if (!Number.isSafeInteger(inclusiveEnd) || inclusiveEnd < start) {
		return undefined;
	}
	return {
		start,
		endExclusive: Math.min(inclusiveEnd + 1, size),
	};
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
