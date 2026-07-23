/**
 * The Bun-owned Epicenter origin: trusted SPA documents, Home APIs, and the
 * Home session WebSocket. The launch credential can only mint short-lived
 * browser sessions at the bootstrap route; it never appears in a URL or
 * durable browser storage.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentToolDefinition } from '@epicenter/agent';
import { type AuthFetch, getProfileVia } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	DESKTOP_RECORD_ATTACHMENT_ROUTE,
	DESKTOP_RECORD_ROUTE,
	type DesktopRecordEpicenterOwner,
	DesktopRecordProtocolError,
	type DesktopRecordResponse,
	isDesktopRecordMutationRequest,
	MAX_RECORD_BLOB_BYTES,
} from '@epicenter/data/desktop-record-owner';
import type { FirstAttachmentChoice } from '@epicenter/data/record';
import {
	EPICENTER_DESKTOP_AI_BASE_ROUTE,
	WHISPERING_DESKTOP_AUDIO_ROUTE,
} from '@epicenter/whispering/workspace-contract';
import { type Context, Hono, type Next } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { getCookie, setCookie } from 'hono/cookie';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { DesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createDesktopAuthorityFetch } from './desktop-authority-fetch.ts';
import { type HomeDataService, isHomeDataLens } from './home-data-service.ts';
import {
	type HomeHost,
	type HomeSessionSnapshot,
	parseHomeCommand,
} from './host.ts';
import { isHomeProposalLens } from './proposal-contract.ts';
import type { ProposalService } from './proposal-service.ts';
import {
	ACCOUNT_INSTANCE_ROUTE,
	ACCOUNT_PROFILE_ROUTE,
	ACCOUNT_SIGN_IN_ROUTE,
	ACCOUNT_SIGN_OUT_ROUTE,
	BOOTSTRAP_ROUTE,
	HOME_DATA_COLLECTION_ROUTE,
	HOME_DATA_OVERVIEW_ROUTE,
	HOME_PROPOSAL_APPLY_ROUTE,
	HOME_PROPOSAL_COMPILE_ROUTE,
	HOME_PROPOSAL_ROUTE,
	HOME_PROPOSALS_ROUTE,
	HOME_SNAPSHOT_CAPTURE_ROUTE,
	HOME_SNAPSHOT_QUERY_ROUTE,
	SESSION_ROUTE,
	SESSION_STREAM_ROUTE,
	SURFACE_ROUTES,
	type SurfaceId,
} from './routes.ts';
import type {
	HomeSnapshotLens,
	SnapshotQueryService,
} from './snapshot-query.ts';
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
	/** Trusted Home-only snapshot capture and bounded artifact query surface. */
	snapshotQueries?: Pick<SnapshotQueryService, 'capture' | 'query'>;
	/** Trusted Home-only editable Proposal artifact workflow. */
	proposalService?: Pick<
		ProposalService,
		'list' | 'create' | 'compile' | 'apply' | 'delete'
	>;
	/** Trusted Home-only live Lens traversal and parked-work observation. */
	dataInspection?: Pick<HomeDataService, 'collection' | 'overview'>;
	/** Current attachment state of that same shared replica. */
	recordAttachment(): DesktopRecordEpicenterOwner['epicenter']['attachment'];
	/** Native-only, record-addressed Whispering audio reader. */
	readRecordingAudio(recordingId: string): Promise<{
		bytes: ReadableStream<Uint8Array>;
		mediaType: string;
		byteLength: number;
	} | null>;
	chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void>;
	/** One credential owner for every compiled desktop surface. */
	desktopAuth: DesktopAuthAuthority;
	/** Test seam for the one host-owned authenticated deployment transport. */
	deploymentFetch?: AuthFetch;
};

export const SnapshotRouteError = defineErrors({
	QueryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Snapshot query failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SnapshotRouteError = InferErrors<typeof SnapshotRouteError>;

export const ProposalRouteError = defineErrors({
	OperationFailed: ({ cause }: { cause: unknown }) => ({
		message: `Proposal operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ProposalRouteError = InferErrors<typeof ProposalRouteError>;

const MAX_HOME_SNAPSHOT_BODY_BYTES = 128 * 1024;

export const NATIVE_WHISPERING_AUDIO_ROUTE =
	'/_epicenter/native/whispering/recordings/:recordingId/audio';
export const DESKTOP_WHISPERING_AUDIO_ROUTE = WHISPERING_DESKTOP_AUDIO_ROUTE;
export const DESKTOP_AI_BASE_ROUTE = EPICENTER_DESKTOP_AI_BASE_ROUTE;
export const DESKTOP_AI_TRANSCRIPTIONS_ROUTE = `${DESKTOP_AI_BASE_ROUTE}${API_ROUTES.ai.transcriptions.pattern}`;

const SESSION_COOKIE = 'epicenter_session';
const MAX_BROWSER_SESSIONS = 32;
const SESSION_SHELL = `<!doctype html><html><head><meta charset="utf-8"><title>Epicenter</title><script>window.__EPICENTER_SESSION_READY__.then(() => window.location.reload())</script></head><body></body></html>`;
const ATTACHMENT_GATE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Attach local Epicenter data</title><style>html{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}.card{box-sizing:border-box;width:min(34rem,calc(100% - 2rem));padding:1.5rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:.75rem}h1{font-size:1.2rem;margin:0 0 1rem}p{line-height:1.5;color:color-mix(in srgb,CanvasText 72%,transparent)}.actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}button{font:inherit;padding:.65rem 1rem;border-radius:.5rem;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);cursor:pointer}button[data-choice=bring]{background:#2563eb;color:white;border-color:#2563eb}button[data-choice=discard]{background:#b91c1c;color:white;border-color:#b91c1c}button:disabled{opacity:.55;cursor:wait}#error{color:#dc2626;min-height:1.5rem}</style></head><body><main class="card"><h1>Choose what to do with local Epicenter data</h1><p>Bring keeps records saved by Home, Whispering, and installed apps, then adds them to your account. Discard permanently removes all local Epicenter records before syncing.</p><div class="actions"><button data-choice="bring">Bring local data</button><button data-choice="discard">Discard all local data</button></div><p id="error" role="alert"></p></main><script>for(const button of document.querySelectorAll('button[data-choice]'))button.addEventListener('click',async()=>{for(const item of document.querySelectorAll('button'))item.disabled=true;document.querySelector('#error').textContent='';try{const response=await fetch('${DESKTOP_RECORD_ATTACHMENT_ROUTE}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({choice:button.dataset.choice})});if(!response.ok)throw new Error(await response.text()||'Could not attach local Epicenter data');location.reload()}catch(error){document.querySelector('#error').textContent=error instanceof Error?error.message:String(error);for(const item of document.querySelectorAll('button'))item.disabled=false}})</script></body></html>`;

export function createHomeServer({
	host,
	origin,
	launchToken,
	staticAssets,
	appCatalog = { apps: [] },
	recordOwner,
	snapshotQueries,
	proposalService,
	dataInspection,
	recordAttachment,
	readRecordingAudio,
	chooseFirstAttachment,
	desktopAuth,
	deploymentFetch: injectedDeploymentFetch,
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
		`${Object.values(surfacePages).join('\n')}\n${SESSION_SHELL}\n${ATTACHMENT_GATE_PAGE}`,
	);
	const deploymentFetch =
		injectedDeploymentFetch ?? createDesktopAuthorityFetch(desktopAuth);
	let recordTransitionTail = Promise.resolve();
	const runRecordTransition = <T>(work: () => Promise<T>): Promise<T> => {
		const operation = recordTransitionTail.then(work);
		recordTransitionTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
	const requiresFirstAttachmentChoice = () => {
		if (desktopAuth.bootSnapshot.state.status !== 'signed-in') return false;
		const attachment = recordAttachment();
		return attachment.kind === 'unattached' && attachment.requiresChoice;
	};
	const shouldServeAttachmentGate = requiresFirstAttachmentChoice;
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
	const requireNativeHost = async (c: Context, next: Next) => {
		const header = c.req.header('authorization');
		const candidate = header?.startsWith('Bearer ')
			? header.slice('Bearer '.length)
			: undefined;
		if (candidate === undefined || !tokensMatch(candidate, launchToken)) {
			return c.text('Unauthorized', 401);
		}
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
			if (shouldServeAttachmentGate()) return c.html(ATTACHMENT_GATE_PAGE);
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
			if (shouldServeAttachmentGate()) return c.html(ATTACHMENT_GATE_PAGE);
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
		if (asset.isDocument) {
			return c.html(
				shouldServeAttachmentGate()
					? ATTACHMENT_GATE_PAGE
					: surfacePages.whispering,
			);
		}
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
		if (asset.isDocument && shouldServeAttachmentGate()) {
			return c.html(ATTACHMENT_GATE_PAGE);
		}
		return c.body(asset.file.stream());
	});
	app.get('/apps/*', (c) => c.text('Not Found', 404));

	app.use('/api/apps', requireBrowserSession);
	app.use('/api/home/data/*', async (c, next) => {
		if (c.req.method === 'GET') return requireBrowserSession(c, next);
		return requirePrivateBroker(c, next);
	});
	app.use('/api/home/*', requireBrowserSession);
	app.use(DESKTOP_RECORD_ROUTE, requirePrivateBroker);
	app.use(DESKTOP_RECORD_ATTACHMENT_ROUTE, requirePrivateBroker);
	app.use(DESKTOP_AI_TRANSCRIPTIONS_ROUTE, requirePrivateBroker);
	app.use(DESKTOP_WHISPERING_AUDIO_ROUTE, requireBrowserSession);
	app.use(NATIVE_WHISPERING_AUDIO_ROUTE, requireNativeHost);
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

	app.get(HOME_DATA_OVERVIEW_ROUTE.pattern, async (c) => {
		if (dataInspection === undefined) return c.text('Not Found', 404);
		c.header('Cache-Control', 'no-store');
		try {
			return c.json(await dataInspection.overview());
		} catch {
			return c.text('Live data inspection failed', 500);
		}
	});

	app.get(HOME_DATA_COLLECTION_ROUTE.pattern, async (c) => {
		if (dataInspection === undefined) return c.text('Not Found', 404);
		const lens = c.req.param('lens');
		const collection = c.req.param('collection');
		const after = c.req.query('after');
		const rawLimit = c.req.query('limit');
		const limit = rawLimit === undefined ? 100 : Number(rawLimit);
		if (
			!isHomeDataLens(lens) ||
			collection === undefined ||
			collection.length === 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			return c.text('Invalid live data request', 400);
		}
		c.header('Cache-Control', 'no-store');
		try {
			return c.json(
				await dataInspection.collection({
					lens,
					collection,
					...(after === undefined ? {} : { after }),
					limit,
				}),
			);
		} catch {
			return c.text('Invalid live data request', 400);
		}
	});

	app.post(HOME_SNAPSHOT_CAPTURE_ROUTE.pattern, async (c) => {
		if (snapshotQueries === undefined) return c.text('Not Found', 404);
		const input = await readJsonObject(c.req.raw, MAX_HOME_SNAPSHOT_BODY_BYTES);
		if (
			input === null ||
			Object.keys(input).some((key) => key !== 'lens') ||
			!isHomeSnapshotLens(input.lens)
		) {
			return c.text('Invalid snapshot capture', 400);
		}
		const lens = input.lens;
		return runRecordTransition(async () => {
			try {
				return c.json(await snapshotQueries.capture(lens), 201);
			} catch {
				return c.text('Snapshot capture failed', 500);
			}
		});
	});

	app.post(HOME_SNAPSHOT_QUERY_ROUTE.pattern, async (c) => {
		if (snapshotQueries === undefined) return c.text('Not Found', 404);
		const snapshotId = c.req.param('snapshotId');
		const input = await readJsonObject(c.req.raw, MAX_HOME_SNAPSHOT_BODY_BYTES);
		if (
			snapshotId === undefined ||
			!/^[a-f0-9]{32}$/u.test(snapshotId) ||
			input === null ||
			Object.keys(input).some((key) => key !== 'sql') ||
			typeof input.sql !== 'string'
		) {
			return c.text('Invalid snapshot query', 400);
		}
		const sql = input.sql;
		try {
			return c.json(await snapshotQueries.query(snapshotId, sql));
		} catch (cause) {
			return c.json(SnapshotRouteError.QueryFailed({ cause }), 400);
		}
	});

	app.get(HOME_PROPOSALS_ROUTE.pattern, async (c) => {
		if (proposalService === undefined) return c.text('Not Found', 404);
		c.header('Cache-Control', 'no-store');
		return runRecordTransition(async () => {
			try {
				return c.json(await proposalService.list());
			} catch (cause) {
				return c.json(ProposalRouteError.OperationFailed({ cause }), 500);
			}
		});
	});

	app.post(HOME_PROPOSALS_ROUTE.pattern, async (c) => {
		if (proposalService === undefined) return c.text('Not Found', 404);
		const input = await readJsonObject(c.req.raw, MAX_HOME_SNAPSHOT_BODY_BYTES);
		if (
			input === null ||
			Object.keys(input).some((key) => key !== 'lens' && key !== 'selection') ||
			!isHomeProposalLens(input.lens) ||
			!Object.hasOwn(input, 'selection')
		) {
			return c.text('Invalid Proposal creation', 400);
		}
		const lens = input.lens;
		const selection = input.selection;
		return runRecordTransition(async () => {
			try {
				return c.json(
					await proposalService.create({
						lens,
						selection,
					}),
					201,
				);
			} catch (cause) {
				return c.json(ProposalRouteError.OperationFailed({ cause }), 400);
			}
		});
	});

	app.post(HOME_PROPOSAL_COMPILE_ROUTE.pattern, async (c) => {
		if (proposalService === undefined) return c.text('Not Found', 404);
		const proposalId = c.req.param('proposalId');
		if (!isHomeProposalId(proposalId)) {
			return c.text('Invalid Proposal ID', 400);
		}
		return runRecordTransition(async () => {
			try {
				return c.json(await proposalService.compile(proposalId));
			} catch (cause) {
				return c.json(ProposalRouteError.OperationFailed({ cause }), 400);
			}
		});
	});

	app.post(HOME_PROPOSAL_APPLY_ROUTE.pattern, async (c) => {
		if (proposalService === undefined) return c.text('Not Found', 404);
		const proposalId = c.req.param('proposalId');
		if (!isHomeProposalId(proposalId)) {
			return c.text('Invalid Proposal ID', 400);
		}
		return runRecordTransition(async () => {
			if (requiresFirstAttachmentChoice()) {
				return c.text('Local data attachment choice required', 409);
			}
			try {
				return c.json(await proposalService.apply(proposalId));
			} catch (cause) {
				return c.json(ProposalRouteError.OperationFailed({ cause }), 400);
			}
		});
	});

	app.delete(HOME_PROPOSAL_ROUTE.pattern, async (c) => {
		if (proposalService === undefined) return c.text('Not Found', 404);
		const proposalId = c.req.param('proposalId');
		if (!isHomeProposalId(proposalId)) {
			return c.text('Invalid Proposal ID', 400);
		}
		return runRecordTransition(async () => {
			try {
				await proposalService.delete(proposalId);
				return c.body(null, 204);
			} catch (cause) {
				return c.json(ProposalRouteError.OperationFailed({ cause }), 400);
			}
		});
	});

	app.post(DESKTOP_RECORD_ROUTE, async (c) => {
		const input = await c.req.json().catch(() => undefined);
		if (!isDesktopRecordMutationRequest(input)) {
			const response = await recordOwner.execute(input);
			return c.json(response, response.error === null ? 200 : 400);
		}
		return runRecordTransition(async () => {
			if (requiresFirstAttachmentChoice()) {
				const blocked =
					DesktopRecordProtocolError.EpicenterDesktopRecordAttachmentRequiredError();
				const response: DesktopRecordResponse = {
					result: null,
					error: blocked.error,
				};
				return c.json(response, 409);
			}
			const response = await recordOwner.execute(input);
			return c.json(response, response.error === null ? 200 : 400);
		});
	});

	app.post(DESKTOP_RECORD_ATTACHMENT_ROUTE, async (c) => {
		const input = await c.req.json().catch(() => undefined);
		if (
			typeof input !== 'object' ||
			input === null ||
			Object.keys(input).length !== 1 ||
			!('choice' in input) ||
			(input.choice !== 'bring' && input.choice !== 'discard')
		) {
			return c.text('Invalid attachment choice', 400);
		}
		return runRecordTransition(async () => {
			try {
				await host.runRecordAttachmentTransition(input.choice, () =>
					chooseFirstAttachment(input.choice),
				);
				return c.body(null, 204);
			} catch {
				return c.text('Could not attach local Epicenter data', 409);
			}
		});
	});

	app.post(DESKTOP_AI_TRANSCRIPTIONS_ROUTE, async (c) => {
		const contentType = c.req.header('content-type');
		if (!contentType?.toLowerCase().startsWith('multipart/form-data;')) {
			return c.text('Unsupported Media Type', 415);
		}
		const contentLength = parseContentLength(c.req.header('content-length'));
		if (contentLength === null) return c.text('Bad Request', 400);
		if (
			contentLength !== undefined &&
			contentLength > MAX_DESKTOP_TRANSCRIPTION_BODY_BYTES
		) {
			return c.text('Payload Too Large', 413);
		}
		let body: ArrayBuffer | null;
		try {
			body =
				c.req.raw.body === null
					? null
					: await readBoundedBody(
							c.req.raw.body,
							MAX_DESKTOP_TRANSCRIPTION_BODY_BYTES,
						);
		} catch (cause) {
			return c.text(
				cause instanceof BodyTooLargeError
					? 'Payload Too Large'
					: 'Bad Request',
				cause instanceof BodyTooLargeError ? 413 : 400,
			);
		}
		try {
			const upstream = await deploymentFetch(
				API_ROUTES.ai.transcriptions.url(desktopAuth.baseURL),
				{
					method: 'POST',
					headers: { 'content-type': contentType },
					body,
				},
			);
			const headers = new Headers({ 'cache-control': 'no-store' });
			const responseType = upstream.headers.get('content-type');
			if (responseType) headers.set('content-type', responseType);
			return new Response(upstream.body, {
				status: upstream.status,
				statusText: upstream.statusText,
				headers,
			});
		} catch {
			return c.text('Transcription gateway unavailable', 502);
		}
	});

	app.get(DESKTOP_WHISPERING_AUDIO_ROUTE, (c) =>
		serveRecordingAudio(c, readRecordingAudio),
	);

	app.get(NATIVE_WHISPERING_AUDIO_ROUTE, (c) =>
		serveRecordingAudio(c, readRecordingAudio),
	);

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
					void runRecordTransition(async () => {
						if (requiresFirstAttachmentChoice()) return;
						await host.handleCommand(command);
						push(ws);
					});
				},
				onClose() {
					unsubscribe?.();
				},
			};
		}),
	);

	return { app, websocket };
}

function isHomeSnapshotLens(value: unknown): value is HomeSnapshotLens {
	return (
		value === 'raw' ||
		value === 'chat' ||
		value === 'honeycrisp' ||
		value === 'whispering'
	);
}

function isHomeProposalId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{24}$/u.test(value);
}

const MAX_DESKTOP_TRANSCRIPTION_BODY_BYTES = 64 * 1024 * 1024;

function parseContentLength(
	value: string | undefined,
): number | undefined | null {
	if (value === undefined) return undefined;
	if (!/^\d+$/u.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<ArrayBuffer> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			received += next.value.byteLength;
			if (received > maxBytes) throw new BodyTooLargeError();
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new ArrayBuffer(received);
	const bytes = new Uint8Array(buffer);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer;
}

async function serveRecordingAudio(
	c: Context,
	readRecordingAudio: HomeServerOptions['readRecordingAudio'],
) {
	const recordingId = c.req.param('recordingId');
	if (recordingId === undefined || !/^[a-z0-9]{24}$/u.test(recordingId)) {
		return c.text('Not Found', 404);
	}
	const audio = await readRecordingAudio(recordingId);
	if (audio === null) return c.text('Not Found', 404);
	if (
		!Number.isSafeInteger(audio.byteLength) ||
		audio.byteLength < 0 ||
		audio.byteLength > MAX_RECORD_BLOB_BYTES
	) {
		await audio.bytes.cancel();
		return c.text('Not Found', 404);
	}
	c.header('cache-control', 'no-store');
	c.header('content-type', safeRecordingMediaType(audio.mediaType));
	c.header('accept-ranges', 'bytes');
	const range = parseByteRange(c.req.header('range'), audio.byteLength);
	if (range === null) {
		await audio.bytes.cancel();
		c.header('content-range', `bytes */${audio.byteLength}`);
		return c.body(null, 416);
	}
	if (range === undefined) {
		c.header('content-length', String(audio.byteLength));
		return c.body(audio.bytes);
	}
	c.header('content-length', String(range.end - range.start + 1));
	c.header(
		'content-range',
		`bytes ${range.start}-${range.end}/${audio.byteLength}`,
	);
	return c.body(sliceByteStream(audio.bytes, range.start, range.end), 206);
}

function parseByteRange(
	value: string | undefined,
	byteLength: number,
): { start: number; end: number } | undefined | null {
	if (value === undefined) return undefined;
	if (byteLength === 0) return null;
	const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
	if (match === null) return null;
	const [, startText = '', endText = ''] = match;
	if (startText === '' && endText === '') return null;
	if (startText === '') {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
		return {
			start: Math.max(0, byteLength - suffixLength),
			end: byteLength - 1,
		};
	}
	const start = Number(startText);
	if (!Number.isSafeInteger(start) || start >= byteLength) return null;
	if (endText === '') return { start, end: byteLength - 1 };
	const end = Number(endText);
	if (!Number.isSafeInteger(end) || end < start) return null;
	return { start, end: Math.min(end, byteLength - 1) };
}

function sliceByteStream(
	stream: ReadableStream<Uint8Array>,
	start: number,
	end: number,
): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	let skip = start;
	let remaining = end - start + 1;
	return new ReadableStream({
		async pull(controller) {
			while (remaining > 0) {
				const next = await reader.read();
				if (next.done) {
					controller.error(
						new Error('Recording audio ended before its cited length'),
					);
					return;
				}
				let chunk = next.value;
				if (skip >= chunk.byteLength) {
					skip -= chunk.byteLength;
					continue;
				}
				if (skip > 0) {
					chunk = chunk.subarray(skip);
					skip = 0;
				}
				const selected = chunk.subarray(
					0,
					Math.min(chunk.byteLength, remaining),
				);
				remaining -= selected.byteLength;
				controller.enqueue(selected);
				if (remaining === 0) {
					await reader.cancel();
					controller.close();
				}
				return;
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

function safeRecordingMediaType(value: string): string {
	const mediaType = value.trim().toLowerCase();
	return /^(?:audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(mediaType)
		? mediaType
		: 'application/octet-stream';
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
	maxBytes?: number,
): Promise<Record<string, unknown> | null> {
	try {
		const value: unknown =
			maxBytes === undefined
				? await request.json()
				: await (async () => {
						const contentLength = parseContentLength(
							request.headers.get('content-length') ?? undefined,
						);
						if (
							contentLength === null ||
							(contentLength !== undefined && contentLength > maxBytes) ||
							request.body === null
						) {
							return undefined;
						}
						return JSON.parse(
							new TextDecoder().decode(
								await readBoundedBody(request.body, maxBytes),
							),
						);
					})();
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
