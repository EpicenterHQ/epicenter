import type { AiCatalog } from './ai-catalog.ts';
import { createAiCatalogRoutes } from './ai-catalog-routes.ts';
/**
 * The Bun-owned Device origin: trusted SPA documents, Home APIs, and the
 * Home session WebSocket. The launch credential can only mint short-lived
 * browser sessions at the bootstrap route; it never appears in a URL or
 * durable browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentToolDefinition } from '@epicenter/agent';
import { CHECKOUT_PATH } from '@epicenter/app/artifact/checkout';
import {
	type BlobId,
	MAX_REMOTE_BLOB_BYTES,
	parseBlobId,
} from '@epicenter/blobs';
import type { BunBlobStore } from '@epicenter/blobs/bun';
import { isAppId } from '@epicenter/constants/app-id';
import type { DeviceSqliteOwner } from '@epicenter/device/owner';
import { createDeviceDispatcher } from '@epicenter/device/owner';
import {
	DEVICE_PATH,
	type DeviceRequest,
	type DeviceResponse,
	isDatabaseName,
	isSecretLabel,
	parseSqliteFrame,
	type SqliteStatement,
	stringifySqliteFrame,
} from '@epicenter/device/protocol';
import type { PendingCallback } from '@epicenter/local-mail/authorization-return';
import {
	type AccountIdentity,
	asPrincipalId,
	deviceOwnerPath,
	isDeviceOwnerPath,
} from '@epicenter/principal';
import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { type Context, Hono, type Next } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import { createLogger } from 'wellcrafted/logger';
import { createAccountRelay } from './account-relay.ts';
import type { AppSecretOwner } from './app-secrets.ts';
import type { Application } from './applications.ts';
import {
	CheckoutPreconditionFailedError,
	checkoutFolderPath,
	readCheckout,
	writeCheckout,
} from './checkout.ts';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';
import {
	type HomeHost,
	type HomeSessionSnapshot,
	parseHomeCommand,
} from './host.ts';
import { PLACEHOLDER_PAGES } from './placeholder-pages.ts';
import {
	ACCOUNT_CANCEL_CONNECTION_ROUTE,
	ACCOUNT_CONNECT_ROUTE,
	ACCOUNT_SIGN_IN_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	ACCOUNT_USE_CLOUD_ROUTE,
	APPLICATIONS_ROUTE,
	BOOTSTRAP_ROUTE,
	BUILT_IN_ROUTES,
	CHECKOUT_ROUTE,
	MAIL_CALLBACK_ROUTE,
	MAIL_PENDING_CALLBACK_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SIGN_IN_CALLBACK_ROUTE,
} from './routes.ts';
import type { EpicenterStaticAssets } from './static-assets.ts';

export type HomeServerEvent = {
	type: 'snapshot';
	snapshot: HomeSessionSnapshot;
};

export type HomeSessionResponse = {
	tools: AgentToolDefinition[];
	snapshot: HomeSessionSnapshot;
};

export type ApplicationsResponse = {
	apps: Application[];
};

export type HomeServerOptions = {
	/** Working copy directory selected by native startup. */
	folderRoot: string;
	host: HomeHost;
	/** Exact active origin, including the Rust-selected explicit port. */
	origin: string;
	/** Per-launch credential received from Rust over stdin. */
	launchToken: string;
	/** Home's document and every compiled application's release build. */
	staticAssets: EpicenterStaticAssets;
	/** Canonical device-local bytes shared by every trusted app window. */
	blobs: (appId: string, owner?: string) => BunBlobStore;
	/** One credential owner for every compiled desktop window. */
	desktopAuth: DesktopAuthAuthority;
	/** Bun owner for app-scoped SQLite files. */
	device?: DeviceSqliteOwner;
	/** Credential-store owner for one labeled secret per application account. */
	appSecrets?: AppSecretOwner;
	aiCatalog?: AiCatalog;
	noAccountAiCatalog?: AiCatalog;
};

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;
/**
 * What the person's browser shows once Google has answered. It carries no
 * script, so it needs no hash in the policy, and it says nothing about what
 * happened: whether the account connected is decided in the Mail window, which
 * is where the person is about to look.
 */
const MAIL_CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Local Mail</title></head><body><p>Google has answered. You can close this tab and return to Device.</p></body></html>`;
const SESSION_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Device</title><script>window.__EPICENTER_SESSION_READY__.then(() => window.location.reload())</script></head><body></body></html>`;

export function createHomeServer({
	folderRoot,
	host,
	origin,
	launchToken,
	staticAssets,
	blobs,
	desktopAuth,
	device,
	appSecrets,
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
	// The single callback Google has delivered and Local Mail has not collected
	// yet. One slot rather than a queue: a person authorizes one account at a
	// time, and a stale callback is a spent code, so the latest is the only one
	// worth keeping.
	let pendingMailCallback: string | null = null;
	const hostPages = {
		home: injectAuthBootstrap(staticAssets.homePage, desktopAuth.bootSnapshot),
		...PLACEHOLDER_PAGES,
	};
	const servedApps = staticAssets.applications.map((application) => ({
		id: application.id,
		page: injectAuthBootstrap(application.page, desktopAuth.bootSnapshot),
		resolve: application.resolve,
	}));
	// One text for every policy: an inline script's hash has to be admitted
	// wherever that document may be served, and only the reachable origins
	// differ between applications.
	const everyPage = [
		...Object.values(hostPages),
		...servedApps.map(({ page }) => page),
		SESSION_SHELL,
	].join('\n');
	const csp = contentSecurityPolicy(everyPage);
	const applicationCsp = new Map(
		servedApps
			.filter(({ id }) => APPLICATION_CONNECT_ORIGINS[id] !== undefined)
			.map(({ id }) => [
				id,
				contentSecurityPolicy(everyPage, APPLICATION_CONNECT_ORIGINS[id]),
			]),
	);
	const { upgradeWebSocket, websocket: homeWebsocket } = createBunWebSocket();
	const relay = createAccountRelay(homeWebsocket);
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
		if (c.req.method === 'GET' || c.req.method === 'HEAD')
			return requireBrowserSession(c, next);
		return requirePrivateBroker(c, next);
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
		const localId = c.req.header('x-epicenter-local-blob-id');
		headers.delete('x-epicenter-local-blob-id');
		let body: BodyInit | undefined =
			c.req.method === 'GET' || c.req.method === 'HEAD'
				? undefined
				: (c.req.raw.body ?? undefined);
		let upload: ReturnType<typeof ownedFileBody> | undefined;
		if (localId !== undefined) {
			// The captured Account owns both cancellation and the destination.
			// The control request contains no bytes for WebKit to materialize.
			if (!bootAccount || account !== bootAccount)
				return c.text('Account retired', 401);
			const match = /^\/api\/apps\/([^/]+)\/blobs$/.exec(target.pathname);
			const appId = match?.[1];
			const id = parseBlobId(localId);
			if (
				c.req.method !== 'POST' ||
				target.search !== '' ||
				!appId ||
				!isAppId(appId) ||
				!id ||
				c.req.raw.body !== null
			)
				return c.text('Invalid native blob upload', 400);
			const store = blobs(appId, deviceOwnerPath(account));
			const stat = await store.stat(id);
			if (stat.error)
				return c.text(
					'Local blob unavailable',
					stat.error.name === 'BlobNotFound' ? 404 : 500,
				);
			if (stat.data.size > MAX_REMOTE_BLOB_BYTES)
				return c.text('Blob is too large', 413);
			const opened = await store.openFile(id);
			if (opened.error)
				return c.text(
					'Local blob unavailable',
					opened.error.name === 'BlobNotFound' ? 404 : 500,
				);
			upload = ownedFileBody(
				opened.data.file,
				opened.data.close,
				opened.data.stat.size,
			);
			body = upload.stream;
			headers.set('content-type', opened.data.stat.contentType);
			headers.set('content-length', String(opened.data.stat.size));
		}
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
			outgoing.delete('set-cookie');
			outgoing.delete('content-encoding');
			outgoing.delete('location');
			outgoing.set('cache-control', 'no-store');
			outgoing.set('x-epicenter-auth-state', desktopAuth.state.status);
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers: outgoing,
			});
		} catch (error) {
			c.header('x-epicenter-auth-state', desktopAuth.state.status);
			if (desktopAuth.state.status === 'signed-out')
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
		} finally {
			await upload?.close();
		}
	});
	app.get('/_epicenter/account/sync', requirePrivateBroker, (c) => {
		const dataId = c.req.query('dataId') ?? '';
		const appId = c.req.query('appId');
		const scope = c.req.query('scope');
		const generation = Number(c.req.query('generation'));
		const cursor = Number(c.req.query('cursor'));
		if (
			!dataId ||
			(appId !== undefined && !isAppId(appId)) ||
			(scope !== undefined && scope !== 'personal' && scope !== 'shared') ||
			(appId === undefined) !== (scope === undefined) ||
			!Number.isSafeInteger(generation) ||
			generation < 0 ||
			!Number.isSafeInteger(cursor) ||
			cursor < 0
		)
			return c.text('Invalid sync address', 400);
		return relay.upgrade(
			c,
			desktopAuth.account,
			STORE_SYNC_ROUTE.address(desktopAuth.baseURL, {
				dataId,
				generation,
				cursor,
				appId,
				scope,
			}),
		);
	});

	app.post(ACCOUNT_CANCEL_CONNECTION_ROUTE.pattern, async (c) => {
		const result = await desktopAuth.cancelConnection();
		if (result.error) return c.text('Could not resume applications.', 500);
		return c.body(null, 204);
	});
	app.post(ACCOUNT_CONNECT_ROUTE.pattern, async (c) => {
		const body: unknown = await c.req.json().catch(() => null);
		if (
			typeof body !== 'object' ||
			body === null ||
			!('server' in body) ||
			typeof body.server !== 'string'
		)
			return c.text('Enter a server URL.', 400);
		const result = await desktopAuth.connectInstance(body.server);
		if (result.error)
			return c.text('Could not select this server. Check the server URL.', 502);
		return c.body(null, 202);
	});
	app.post(ACCOUNT_USE_CLOUD_ROUTE.pattern, async (c) => {
		const result = await desktopAuth.useCloud();
		if (result.error) return c.text('Could not change servers.', 500);
		return c.body(null, 202);
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
		const result = await desktopAuth.startSignIn({
			reauthenticate:
				'reauthenticate' in body ? (body.reauthenticate as boolean) : undefined,
		});
		if (result.error) return c.text('Sign-in failed', 502);
		return c.body(null, 202);
	});
	app.post(ACCOUNT_SIGN_OUT_ROUTE.pattern, async (c) => {
		const result = await desktopAuth.signOut();
		if (result.error) return c.text('Sign-out failed', 500);
		return c.body(null, 202);
	});

	// Home and the release-bundled placeholders: one document each, no asset
	// tree behind them.
	for (const builtInRoute of [BUILT_IN_ROUTES.home, BUILT_IN_ROUTES.books]) {
		app.get(builtInRoute.pattern, (c) => {
			c.header('cache-control', 'no-store');
			if (!hasBrowserSession(c)) return c.html(SESSION_SHELL);
			return c.html(hostPages[builtInRoute.id]);
		});
	}
	// Google's answer, arriving in the person's own browser.
	//
	// This is the one route on the origin a browser outside the WebView is
	// expected to reach, so it is deliberately unguarded: a browser following a
	// redirect carries no session cookie, and there is nothing here to protect.
	// The host holds an opaque URL for one collection and reads nothing out of
	// it. The code is worthless without the PKCE verifier, which never leaves
	// the Mail window, and a forged callback fails that window's `state` check.
	//
	// Only a request carrying `code` or `error` is a callback. Anything else is
	// the WebView loading its own client route, and falls through to the SPA.
	app.get(MAIL_CALLBACK_ROUTE.pattern, (c, next) => {
		const url = new URL(c.req.url);
		const isCallback =
			url.searchParams.has('code') || url.searchParams.has('error');
		if (!isCallback) return next();
		pendingMailCallback = url.toString();
		c.header('cache-control', 'no-store');
		return c.html(MAIL_CALLBACK_PAGE);
	});
	// One contained asset tree each, with the document served from memory so
	// every client route lands on the stamped page.
	for (const application of servedApps) {
		const prefix = `/apps/${application.id}/`;
		// The session shell is the host's own document and keeps the host's own
		// policy; only this application's page carries the wider one.
		const widened = applicationCsp.get(application.id);
		const servePage = (c: Context) => {
			if (widened !== undefined) c.header('content-security-policy', widened);
			return c.html(application.page);
		};
		app.get(`${prefix}*`, async (c) => {
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
		});
	}
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	app.use(APPLICATIONS_ROUTE.pattern, requireBrowserSession);
	// Application-scoped blob routes are host APIs over private local files. The
	// generic application listing is already guarded above; this wildcard keeps
	// newly added app routes behind the same browser session by default.
	app.use('/api/apps/*', requireBrowserSession);
	app.use('/api/mail/*', requireBrowserSession);
	// Taking is destructive, because one authorization is redeemable once and a
	// second reader would be redeeming a code Google has already spent.
	app.get(MAIL_PENDING_CALLBACK_ROUTE.pattern, (c) => {
		const callback = pendingMailCallback;
		pendingMailCallback = null;
		if (callback === null) return c.body(null, 204);
		return c.json({ callbackUrl: callback } satisfies PendingCallback);
	});
	app.use('/api/home/*', requireBrowserSession);
	app.use(`${DEVICE_PATH}/*`, requirePrivateBroker);
	app.get(`${DEVICE_PATH}/sqlite`, async (c, next) => {
		if (device === undefined) return c.text('Unavailable', 503);
		const response = await upgradeWebSocket(() => {
			const dispatcher = createDeviceDispatcher(device);
			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				void dispatcher.close().catch((cause: unknown) => {
					createLogger('epicenter/sqlite').error(
						new Error('SQLite socket cleanup failed.', { cause }),
					);
				});
			};
			return {
				onMessage(event, ws) {
					if (closed) return;
					const frame =
						typeof event.data === 'string'
							? parseSqliteFrame(event.data)
							: undefined;
					if (
						typeof frame !== 'object' ||
						frame === null ||
						!('id' in frame) ||
						!Number.isSafeInteger(frame.id)
					) {
						close();
						ws.close(1008, 'Invalid SQLite request.');
						return;
					}
					const input = 'request' in frame ? frame.request : null;
					const request = parseDeviceRequest(
						typeof input === 'object' && input !== null && !Array.isArray(input)
							? (input as Record<string, unknown>)
							: null,
					);
					if (
						request === undefined ||
						request.kind === 'secret-put' ||
						request.kind === 'secret-get' ||
						request.kind === 'secret-delete'
					) {
						ws.send(
							stringifySqliteFrame({
								id: frame.id,
								failure: 'Invalid SQLite request.',
							}),
						);
						return;
					}
					void dispatcher.request(request).then(
						(response) => {
							if (!closed)
								ws.send(stringifySqliteFrame({ id: frame.id, response }));
						},
						() => {
							if (!closed)
								ws.send(
									stringifySqliteFrame({
										id: frame.id,
										failure: 'Application storage failed',
									}),
								);
						},
					);
				},
				onClose: close,
				onError: close,
			};
		})(c, next);
		return response ?? c.text('Expected WebSocket upgrade', 400);
	});

	app.post(DEVICE_PATH, async (c) => {
		const request = parseDeviceRequest(await readJsonObject(c.req.raw));
		if (request === undefined) return c.text('Bad Request', 400);
		try {
			if (request.kind === 'secret-put') {
				if (appSecrets === undefined) return c.text('Unavailable', 503);
				await appSecrets.put(
					request.appId,
					request.label,
					request.value,
					request.account,
				);
				return c.json({ kind: request.kind } satisfies DeviceResponse);
			}
			if (request.kind === 'secret-get') {
				if (appSecrets === undefined) return c.text('Unavailable', 503);
				const value = await appSecrets.get(
					request.appId,
					request.label,
					request.account,
				);
				return c.json({
					kind: request.kind,
					value,
				} satisfies DeviceResponse);
			}
			if (request.kind === 'secret-delete') {
				if (appSecrets === undefined) return c.text('Unavailable', 503);
				await appSecrets.delete(request.appId, request.label, request.account);
				return c.json({ kind: request.kind } satisfies DeviceResponse);
			}
			return c.text('Bad Request', 400);
		} catch {
			return c.text('Application storage failed', 500);
		}
	});
	// The same gate the blob routes carry, for the same reason: these write and
	// delete real files and list a workspace's row ids, and the only caller is
	// a rendering WebView that already holds the session it was bootstrapped
	// with. Without this they are the one loopback API any local process can
	// reach (ADR-0271).
	app.use(`${CHECKOUT_PATH}/*`, requireBrowserSession);
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

	// What Home lists as launchable: every validated compiled or installed app.
	app.get(APPLICATIONS_ROUTE.pattern, (c) =>
		c.json({
			apps: staticAssets.applications.map(
				({ id, title }) => ({ id, title }) satisfies Application,
			),
		} satisfies ApplicationsResponse),
	);

	/**
	 * One database's working copy in `~/Device` (ADR-0337).
	 *
	 * `PUT` is `pull`'s half: the application says what its store holds and the
	 * host replaces the folder with it. `GET` is `push`'s, and what `pull` reads
	 * first to know the folder is clean: the host hands back the files it holds.
	 *
	 * No store is opened here, no CRDT update is decoded, and no frontmatter is
	 * parsed. The host owns the root, the refusal, and the atomic swap; the
	 * application owns what any of it means.
	 *
	 * Native startup validates the root before the server is constructed.
	 */
	const checkoutFolder = (c: {
		req: { param(name: string): string | undefined };
	}) =>
		checkoutFolderPath({
			dataId: c.req.param('dataId') ?? '',
			root: folderRoot,
		});

	app.put(CHECKOUT_ROUTE.pattern, async (c) => {
		const folder = checkoutFolder(c);
		if (folder === undefined) return c.text('Invalid checkout path', 400);
		// Required, not optional. A checkout with no reading behind it is a write
		// nobody approved, and refusing it here makes that impossible at the wire
		// rather than only in the library that usually sends one.
		const ifMatch = c.req.header('if-match');
		if (ifMatch === undefined) {
			return c.text('A checkout write must carry If-Match', 428);
		}
		try {
			await writeCheckout(folder, await c.req.text(), ifMatch);
		} catch (cause) {
			if (cause instanceof CheckoutPreconditionFailedError) {
				return c.text('The folder changed since it was read', 412);
			}
			// The folder sits on a filesystem that may be full, read-only, or on a
			// drive someone unplugged. The store is unaffected, so this is the
			// folder's failure to report and never the application's to crash on.
			return c.text('The checkout could not be written', 500);
		}
		return c.body(null, 204);
	});

	app.get(CHECKOUT_ROUTE.pattern, async (c) => {
		const folder = checkoutFolder(c);
		if (folder === undefined) return c.text('Invalid checkout path', 400);
		try {
			const { ndjson, etag } = await readCheckout(folder);
			return c.body(ndjson, 200, {
				'content-type': 'application/x-ndjson',
				// What a write has to hand back. Strong, because it is a digest of
				// the exact bytes below rather than a claim about how fresh they are.
				etag,
			});
		} catch {
			return c.text('The folder could not be read', 500);
		}
	});

	type BlobEnv = { Variables: { appId: string; id: BlobId; owner: string } };
	const blobApi = new Hono<BlobEnv>();
	blobApi.use('*', async (c, next) => {
		const appId = c.req.param('appId');
		if (!appId || !isAppId(appId)) return c.text('Invalid application ID', 400);
		c.set('appId', appId);
		const owner = c.req.query('owner') ?? 'no-account';
		if (!isDeviceOwnerPath(owner)) return c.text('Invalid storage owner', 400);
		c.set('owner', owner);
		await next();
	});
	blobApi.use('/:blobId/*', async (c, next) => {
		const id = parseBlobId(c.req.param('blobId'));
		if (
			!id ||
			[...new URL(c.req.url).searchParams.keys()].some((key) => key !== 'owner')
		)
			return c.text('Invalid blob address', 400);
		c.set('id', id);
		await next();
	});
	blobApi.get('/', async (c) => {
		const query = new URL(c.req.url).searchParams;
		if (
			[...query.keys()].some(
				(key) => key !== 'cursor' && key !== 'limit' && key !== 'owner',
			)
		)
			return c.text('Invalid blob list options', 400);
		const limit = query.get('limit');
		const cursor = query.get('cursor');
		const result = await blobs(c.var.appId, c.var.owner).list({
			...(limit === null ? {} : { limit: Number(limit) }),
			...(cursor === null ? {} : { cursor }),
		});
		return result.error ? c.text('Blob list failed', 400) : c.json(result.data);
	});
	blobApi.put('/:blobId', async (c) => {
		const result = await blobs(c.var.appId, c.var.owner).putRequest(
			c.var.id,
			c.req.raw,
		);
		if (!result.error) return c.body(null, 201);
		return c.text(
			'Blob publication failed',
			result.error.name === 'BlobAlreadyExists' ? 409 : 500,
		);
	});
	// Hono derives HEAD from GET; intercept it before file-body acquisition.
	blobApi.use('/:blobId', async (c, next) => {
		if (c.req.method !== 'HEAD') return next();
		const result = await blobs(c.var.appId, c.var.owner).stat(c.var.id);
		if (result.error)
			return c.text(
				'Blob unavailable',
				result.error.name === 'BlobNotFound' ? 404 : 500,
			);
		return new Response(null, {
			headers: {
				...blobResponseHeaders(result.data.contentType),
				'content-length': String(result.data.size),
			},
		});
	});
	blobApi.get('/:blobId', async (c) => {
		const result = await blobs(c.var.appId, c.var.owner).openFile(c.var.id);
		if (result.error)
			return c.text(
				'Blob unavailable',
				result.error.name === 'BlobNotFound' ? 404 : 500,
			);
		const { file, stat, close } = result.data;
		const headers = {
			...blobResponseHeaders(stat.contentType),
			'content-length': String(stat.size),
		};
		const requestedRange = c.req.header('range');
		if (requestedRange === undefined)
			return new Response(ownedFileBody(file, close, stat.size).stream, {
				headers,
			});
		const range = parseByteRange(requestedRange, stat.size);
		if (!range) {
			await close();
			return new Response(null, {
				status: 416,
				headers: {
					...headers,
					'content-length': '0',
					'content-range': `bytes */${stat.size}`,
				},
			});
		}
		return new Response(
			ownedFileBody(
				file.slice(range.start, range.endExclusive, stat.contentType),
				close,
				range.endExclusive - range.start,
			).stream,
			{
				status: 206,
				headers: {
					...headers,
					'content-length': String(range.endExclusive - range.start),
					'content-range': `bytes ${range.start}-${range.endExclusive - 1}/${stat.size}`,
				},
			},
		);
	});
	blobApi.delete('/:blobId', async (c) => {
		const result = await blobs(c.var.appId, c.var.owner).delete(c.var.id);
		return result.error
			? c.text('Blob deletion failed', 500)
			: c.body(null, 204);
	});
	app.route('/api/apps/:appId/blobs', blobApi);
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

	return { app, websocket: relay.websocket };
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

/** Own the borrowed file until HTTP consumption finishes or is cancelled. */
function ownedFileBody(
	file: Blob,
	closeFile: () => Promise<void>,
	size: number,
) {
	const reader = file.stream().getReader();
	let closed: Promise<void> | undefined;
	let cancelled = false;
	let remaining = size;
	function close() {
		closed ??= (async () => {
			try {
				await reader.cancel();
			} finally {
				await closeFile();
			}
		})();
		return closed;
	}
	return {
		close,
		stream: new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					if (remaining === 0 || closed) {
						await close();
						if (!cancelled) controller.close();
						return;
					}
					const { done, value } = await reader.read();
					if (cancelled) return;
					if (closed) {
						controller.close();
						return;
					}
					if (done)
						throw new Error('Blob stream ended before its declared length.');
					remaining -= value.byteLength;
					if (remaining < 0)
						throw new Error('Blob stream exceeded its declared length.');
					controller.enqueue(value);
					// Bun 1.3.14 can stall at the end of a descriptor-backed slice.
					// The validated stat/range length owns completion and cancellation.
					if (remaining === 0) {
						await close();
						if (!cancelled) controller.close();
					}
				} catch (cause) {
					if (!cancelled) controller.error(cause);
					await close().catch(() => {});
				}
			},
			cancel() {
				cancelled = true;
				return close();
			},
		}),
	};
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

function parseDeviceRequest(
	input: Record<string, unknown> | null,
): DeviceRequest | undefined {
	if (
		input === null ||
		typeof input.kind !== 'string' ||
		typeof input.appId !== 'string' ||
		!isAppId(input.appId)
	) {
		return undefined;
	}
	const kind = input.kind;
	let account: AccountIdentity | undefined;
	if (input.account !== undefined) {
		const value = input.account;
		if (
			!value ||
			typeof value !== 'object' ||
			!('authorityId' in value) ||
			!('principalId' in value) ||
			typeof value.authorityId !== 'string' ||
			typeof value.principalId !== 'string'
		)
			return undefined;
		account = {
			authorityId: value.authorityId,
			principalId: asPrincipalId(value.principalId),
		};
		try {
			deviceOwnerPath(account);
		} catch {
			return undefined;
		}
	}
	if (kind.startsWith('sqlite-')) {
		const address = { appId: input.appId, account };
		if (kind === 'sqlite-acquire') return { kind, ...address };
		if (typeof input.lifetimeId !== 'string' || input.lifetimeId === '')
			return undefined;
		const session = { ...address, lifetimeId: input.lifetimeId };
		if (kind === 'sqlite-close') return { kind, ...session };
		if (kind === 'sqlite-open' || kind === 'sqlite-delete') {
			return typeof input.name === 'string' && isDatabaseName(input.name)
				? { kind, ...session, name: input.name }
				: undefined;
		}
		if (typeof input.connectionId !== 'string' || input.connectionId === '')
			return undefined;
		const connection = { ...session, connectionId: input.connectionId };
		if (kind === 'sqlite-run' || kind === 'sqlite-all') {
			const statement = parseSqliteStatement(input.statement);
			return statement === undefined
				? undefined
				: { kind, ...connection, statement };
		}
		if (kind === 'sqlite-query' || kind === 'sqlite-cancel') {
			if (
				typeof input.queryId !== 'string' ||
				input.queryId.length === 0 ||
				input.queryId.length > 128
			)
				return undefined;
			if (kind === 'sqlite-cancel')
				return { kind, ...connection, queryId: input.queryId };
			const statement = parseSqliteStatement(input.statement);
			if (
				!statement ||
				new TextEncoder().encode(statement.sql).length > 65536 ||
				!Array.isArray(input.tables) ||
				input.tables.length > 128 ||
				!input.tables.every(
					(table): table is string =>
						typeof table === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(table),
				)
			)
				return undefined;
			return {
				kind,
				...connection,
				queryId: input.queryId,
				statement,
				tables: input.tables,
			};
		}
		if (kind === 'sqlite-batch') {
			if (!Array.isArray(input.statements)) return undefined;
			const statements: SqliteStatement[] = [];
			for (const value of input.statements) {
				const statement = parseSqliteStatement(value);
				if (statement === undefined) return undefined;
				statements.push(statement);
			}
			return { kind, ...connection, statements };
		}
		return undefined;
	}
	if (
		(kind === 'secret-put' ||
			kind === 'secret-get' ||
			kind === 'secret-delete') &&
		typeof input.label === 'string'
	) {
		if (!isSecretLabel(input.label)) return undefined;
		if (kind === 'secret-put' && typeof input.value !== 'string')
			return undefined;
		return kind === 'secret-put'
			? {
					kind,
					account,
					appId: input.appId,
					label: input.label,
					value: input.value as string,
				}
			: {
					kind,
					account,
					appId: input.appId,
					label: input.label,
				};
	}
	return undefined;
}

function parseSqliteStatement(value: unknown):
	| {
			sql: string;
			parameters?: readonly import('@epicenter/sqlite').SqliteValue[];
	  }
	| undefined {
	if (typeof value !== 'object' || value === null || !('sql' in value))
		return undefined;
	if (typeof value.sql !== 'string' || value.sql.trim() === '')
		return undefined;
	if (!('parameters' in value) || value.parameters === undefined)
		return { sql: value.sql };
	if (
		!Array.isArray(value.parameters) ||
		value.parameters.some((item) => !isSqliteValue(item))
	)
		return undefined;
	return {
		sql: value.sql,
		parameters: value.parameters as import('@epicenter/sqlite').SqliteValue[],
	};
}

function isSqliteValue(value: unknown): boolean {
	return (
		value === null ||
		typeof value === 'string' ||
		(typeof value === 'number' && Number.isFinite(value)) ||
		value instanceof Uint8Array
	);
}

function tokensMatch(candidate: string, expected: string): boolean {
	const a = createHash('sha256').update(candidate).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Origins an application's own document may reach, beyond this one.
 *
 * The default is nothing: `connect-src 'self'` plus the IPC endpoints, so an
 * application talks to the host and to no one else. Tauri's `security.csp`
 * does not reach these windows at all, because it is injected into assets
 * Tauri's own protocol serves and every application here is served over
 * `http://127.0.0.1`. This header is the only policy the WebView enforces.
 *
 * Mail is the one entry. The host holds no Gmail token and proxies no Gmail
 * request (ADR-0226), so the WebView redeems Google's authorization code and
 * calls the Gmail API itself. `accounts.google.com` is deliberately absent:
 * consent happens in the person's own browser through the opener, never in
 * this WebView.
 *
 * Widening one entry widens one application. The policy is a response header
 * and every application document is served its own, which is the same scoping
 * the capability files apply to native commands.
 */
const APPLICATION_CONNECT_ORIGINS: Record<string, readonly string[]> = {
	[BUILT_IN_ROUTES.mail.id]: [
		'https://oauth2.googleapis.com',
		'https://gmail.googleapis.com',
	],
};

function contentSecurityPolicy(
	page: string,
	connectOrigins: readonly string[] = [],
): string {
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
		["connect-src 'self' ipc: http://ipc.localhost", ...connectOrigins].join(
			' ',
		),
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
