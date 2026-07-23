/**
 * Mount the AttachRelay behind a deployment-owned bearer gate. A self-hosted
 * instance resolves a per-device grant to the instance principal; Epicenter
 * Cloud resolves an OAuth bearer to the signed-in principal.
 * This is the one way the relay is reached: every attach is authenticated and
 * the principal is stamped server-side, so there is no unauthenticated path and
 * no second principal-resolution model.
 *
 * ## Why this surface stamps the principal
 *
 * The relay addresses endpoints only (`principalId`, `hostId`, `deviceId`,
 * `attachId`). On the authenticated mount, `principalId` is NOT read from the
 * query: the bearer resolves server-side to the one principal this deployment
 * admits (the literal `instance` principal on self-host, ADR-0075), and that
 * resolved id is stamped onto the socket. A client that puts a different
 * `principalId` in its query cannot address another partition, and a client
 * with no valid bearer cannot connect at all: the surface is fail-closed behind
 * the deployment's configured attach credential.
 *
 * ## Not a route surface
 *
 * There is one path (`/attach`) and the query carries only the endpoint
 * quadruple plus `role`. This adds no route, channel, capability, action, or
 * per-host directory; it only authenticates the one relay surface the
 * coordinator already shaped. The credential rides `Authorization` (a
 * non-browser client) or the `bearer.<token>` subprotocol (a browser), and the
 * 101 echoes only the main subprotocol so the token never round-trips.
 */

import {
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
} from '@epicenter/sync/auth-subprotocol';
import { Hono, type MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import { extractUpgradeBearer } from '../auth/extract-upgrade-bearer.js';
import { OAuthError } from '../auth/oauth-errors.js';
import { createOAuthUnauthorizedResourceResponse } from '../auth/oauth-resource.js';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import { setPrincipalOrReject } from '../middleware/require-auth.js';
import type { ServerBindings } from '../server-bindings.js';
import type { Env, ResolveBearerPrincipal } from '../types.js';
import type { AttachRelayUpgradeHandler } from './contracts.js';
import { ATTACH_RELAY_ROUTE } from './route.js';

/**
 * Bearer auth for the attach surface. It owns WebSocket credential extraction
 * ({@link extractUpgradeBearer}: an
 * `Authorization` header first, else a single `bearer.<token>` subprotocol) and
 * feeds the same {@link ResolveBearerPrincipal} every bearer surface uses, so a
 * browser cookie can never authenticate an attach.
 *
 * On failure it answers a standard OAuth 401. A failed handshake is
 * fail-closed: the attach cannot proceed.
 */
function requireAttachBearer<E extends Env>(
	resolveBearerPrincipal: ResolveBearerPrincipal<E>,
): MiddlewareHandler<E> {
	return createMiddleware<E>(async (c, next) => {
		const bearer = extractUpgradeBearer(c.req.raw.headers);
		const resolution = bearer
			? await resolveBearerPrincipal(c, bearer)
			: OAuthError.InvalidToken();
		return setPrincipalOrReject(c, next, resolution, (error) =>
			createOAuthUnauthorizedResourceResponse(c, error),
		);
	});
}

/**
 * The one `/attach` upgrade route, on the concrete portable {@link Env} so it
 * reads the resolved `c.var.principal`. The generic bearer gate is applied
 * upstream by {@link mountAttachRelayApp}; by the time this runs, `principal` is
 * set. Reads only `role`, `hostId`, `deviceId`, and `attachId` from the query;
 * the principal is stamped from auth, never the query.
 *
 * The backend is resolved per request from `c.env`, the one genuinely
 * runtime-specific concern (a Bun singleton coordinator, or a Cloudflare Durable
 * Object namespace bound only at request time).
 */
function createAttachRelayApp(
	resolveRelay: (env: ServerBindings) => AttachRelayUpgradeHandler,
): Hono<Env> {
	return new Hono<Env>().get(
		ATTACH_RELAY_ROUTE.pattern,
		describeRoute({
			description: 'Upgrade to the AttachRelay WebSocket',
			tags: ['attach-relay'],
		}),
		(c) => {
			if (!isWebSocketUpgrade(c)) {
				return new Response('The attach relay is WebSocket-only', {
					status: 426,
				});
			}
			// An upgrade offering subprotocols must offer the main one: the backend
			// echoes only `epicenter` on the 101, and a compliant browser fails a
			// handshake whose 101 selects a protocol it did not offer. A client
			// offering no subprotocols (a non-browser caller using `Authorization`)
			// is fine; there is nothing to echo.
			const offered = parseSubprotocols(
				c.req.header('sec-websocket-protocol') ?? null,
			);
			if (offered.length > 0 && !offered.includes(MAIN_SUBPROTOCOL)) {
				return new Response(
					`WebSocket upgrade must offer the ${MAIN_SUBPROTOCOL} subprotocol`,
					{ status: 400 },
				);
			}

			return resolveRelay(c.env).handleUpgrade({
				request: c.req.raw,
				// Server-side principal: never the query's. On self-host this is the
				// literal instance principal the attach grant resolves to.
				principalId: c.var.principal.id,
				role: c.req.query('role'),
				hostId: c.req.query('hostId'),
				deviceId: c.req.query('deviceId'),
				attachId: c.req.query('attachId'),
				// Directory metadata for a `role=host` connect; the backend records
				// it in the host directory and never hands it to the coordinator.
				label: c.req.query('label'),
			});
		},
	);
}

/**
 * Mount the attach relay surface on a deployment's server app.
 *
 * Bundles the bearer gate and the one `/attach` upgrade route. The route reads
 * only `role`, `hostId`, `deviceId`, and `attachId` from the query; the
 * authenticated principal is stamped from `c.var.principal.id`, never the query,
 * so this surface cannot be pointed at another partition.
 *
 * `resolveRelay` binds this runtime's relay backend from the per-request env,
 * the same shape as other deployment-owned resolver seams: a Bun host
 * closes over its one coordinator (`() => attachRelay`); the Cloud Worker builds
 * a Durable Object registry over its bound namespace
 * (`(env) => createDurableObjectAttachRelay((env as Cloudflare.Env).ATTACH_RELAY)`).
 */
export function mountAttachRelayApp<E extends Env = Env>(
	app: Hono<E>,
	opts: {
		resolveBearerPrincipal: ResolveBearerPrincipal<E>;
		resolveRelay: (env: ServerBindings) => AttachRelayUpgradeHandler;
	},
): void {
	app.use(
		ATTACH_RELAY_ROUTE.pattern,
		requireAttachBearer(opts.resolveBearerPrincipal),
	);
	app.route('/', createAttachRelayApp(opts.resolveRelay));
}
