/** Authenticated access to one application's current Personal or Shared library. */
import {
	CURRENT_ROUTE,
	DATA_ID,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	STORE_SYNC_ROUTE,
} from '@epicenter/sync';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import { createMiddleware } from 'hono/factory';
import { extractUpgradeBearer } from '../auth/extract-upgrade-bearer.js';
import { OAuthError } from '../auth/oauth-errors.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { resolveLibraryPrefix } from '../library.js';
import { setPrincipalOrReject } from '../middleware/require-auth.js';
import { storeCollectionName } from '../principal.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';

export type StoreAuthorityStub = { fetch(request: Request): Promise<Response> };
/** Historical ledger access is only used to refuse implicit migration. */
export type GenerationsLedgerStub = {
	list(): number[] | Promise<number[]>;
};
export type ResolveStore = (env: ServerBindings) => {
	authority(name: string): StoreAuthorityStub;
	ledger(name: string): GenerationsLedgerStub;
};

export function mountStoreSyncApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		setup?: MiddlewareHandler<E>;
		resolveBearerPrincipal: ResolveBearerPrincipal<E>;
		resolveStore: ResolveStore;
		shared?: boolean;
	},
): void {
	const bearer = createMiddleware<E>(async (c, next) => {
		const token = extractUpgradeBearer(c.req.raw.headers);
		return setPrincipalOrReject(
			c,
			next,
			token
				? await opts.resolveBearerPrincipal(c, token)
				: OAuthError.InvalidToken(),
		);
	});
	const auth = opts.setup ? every(opts.setup, bearer) : bearer;
	function address(
		c: Context<Env>,
		appId: string | undefined,
		library: string | undefined,
		dataId: string | undefined,
	) {
		if (!dataId || !DATA_ID.test(dataId) || dataId.length > 128) return;
		const prefix = resolveLibraryPrefix(
			appId,
			library,
			c.var.principal.id,
			opts.shared === true,
		);
		if (!prefix) return;
		// A supplied owner is never an authorization mechanism.
		if (c.req.query('principalId') || c.req.query('owner')) return;
		return `${prefix}/data/${dataId}`;
	}
	app.post(CURRENT_ROUTE.pattern, auth, async (c: Context<Env>) => {
		const appId = c.req.param('appId');
		const library = c.req.param('library');
		const dataId = c.req.param('dataId');
		const name = address(c, appId, library, dataId);
		if (!name) return c.text('Library access refused', 403);
		const store = opts.resolveStore(c.env);
		// The new address cannot discover independently writable historical objects.
		// Refuse rather than adopting a maximum or opening an empty replacement.
		if (
			library === 'personal' &&
			(
				await store
					.ledger(storeCollectionName(c.var.principal.id, dataId!))
					.list()
			).length > 0
		)
			return c.text(
				'Historical library requires an explicit migration decision',
				409,
			);
		return store.authority(name).fetch(c.req.raw);
	});
	app.get(STORE_SYNC_ROUTE.pattern, auth, async (c: Context<Env>) => {
		if (!isWebSocketUpgrade(c))
			return c.text('The store transport is WebSocket-only', 426);
		const name = address(
			c,
			c.req.query('appId'),
			c.req.query('library'),
			c.req.query('dataId'),
		);
		if (!name) return c.text('Library access refused', 403);
		const generation = Number(c.req.query('generation'));
		if (!Number.isSafeInteger(generation) || generation < 1)
			return c.text('Invalid generation', 400);
		const offered = parseSubprotocols(
			c.req.header('sec-websocket-protocol') ?? null,
		);
		if (offered.length && !offered.includes(MAIN_SUBPROTOCOL))
			return c.text('Invalid store subprotocol', 400);
		const response = await opts
			.resolveStore(c.env)
			.authority(name)
			.fetch(c.req.raw);
		if (response.status !== 101) return response;
		return new Response(response.body, {
			status: 101,
			webSocket: (response as unknown as { webSocket: WebSocket }).webSocket,
			headers: offered.length
				? { 'sec-websocket-protocol': MAIN_SUBPROTOCOL }
				: undefined,
		});
	});
}
