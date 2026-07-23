/**
 * Library types shared by sub-app factories and middleware.
 *
 * Per-request state lives on the Hono context (`c.var.principal`, `c.var.db`,
 * etc.). The authenticated principal id is the partition key by definition.
 */

import type { Principal } from '@epicenter/auth';
import type { PrincipalId } from '@epicenter/identity';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Context } from 'hono';
import type { Result } from 'wellcrafted/result';
import type { CloudAuthBindings, createAuth } from './auth/create-auth.js';
import type { OAuthError } from './auth/oauth-errors.js';
import type * as schema from './db/schema/index.js';
import type { ServerBindings } from './server-bindings.js';

/**
 * How an explicit bearer token resolves to the calling principal: the one auth
 * seam.
 *
 * The surface wrappers (`requireCookieOrBearerPrincipal`, `requireBearerPrincipal`,
 * the WebSocket upgrade wrappers) own credential EXTRACTION:
 * each knows where its transport carries the token (`Authorization` header, or
 * the `bearer.<token>` WebSocket subprotocol for rooms) and hands the resolver
 * a bare token. The resolver only VERIFIES; it never reads request headers, so
 * no transport ever has to fake another transport's header to authenticate.
 * The deployment builds each wrapper by closing it over its resolver
 * (`requireBearerPrincipal(resolveBearerPrincipal)`), so the resolver is held in
 * the wrapper's closure, not stamped on the context: there is no
 * `c.var.resolveBearerPrincipal`.
 *
 * The cloud closes over the real resolver (`resolveRequestOAuthPrincipal`: an
 * OAuth bearer verified against JWKS); an instance closes over its env-token
 * resolver (`createEnvTokenResolver`). A dev-only entrypoint closes over a trivial
 * `dev:<principalId>` resolver so the runtime-parity smoke needs no interactive
 * login; that bypass lives in a dev entry production never imports, never an
 * env-gated branch in this library.
 *
 * Returns the same `Result<Principal, OAuthError>` every resolver returns, so a
 * different resolver slots in without touching the wrappers' error handling
 * (HTTP 401, the OAuth `WWW-Authenticate` challenge, or a WebSocket close).
 *
 * Generic over the context it reads: the instance's env-token resolver needs only
 * the portable {@link Env}; the cloud's `resolveRequestOAuthPrincipal` reads
 * `c.var.auth` + `c.var.db`, so it is a `ResolveBearerPrincipal<CloudEnv>`. The
 * wrapper that closes over a resolver carries the same `E`, so a cloud resolver
 * only composes onto a cloud app.
 */
export type ResolveBearerPrincipal<E extends Env = Env> = (
	c: Context<E>,
	bearer: string,
) => Promise<Result<Principal, OAuthError>>;

export type DocumentAuthorization = {
	principal: Principal;
	authorizationExpiresAt: number;
};

/** Bearer verification plus the deadline at which a socket must reauthorize. */
export type ResolveDocumentPrincipal<E extends Env = Env> = (
	c: Context<E>,
	bearer: string,
) => Promise<Result<DocumentAuthorization, OAuthError>>;

/**
 * Per-connection identity and runtime state, stamped onto the Cloudflare
 * Durable Object WebSocket attachment so presence survives hibernation.
 *
 * `nodeId` identifies one Epicenter app on one persistent storage scope
 * (browser tab, Tauri window, extension service worker, CLI process; tabs
 * sharing localStorage share an id). The client generates and persists its
 * own; lifespan is the client's concern.
 *
 * `connectedAt` is stamped at upgrade time and surfaced in presence frames so
 * receivers can render an "online since" affordance and tie-break multi-tab
 * same-node (newest wins).
 *
 * Every connection to a given room carries the authenticated principal id that
 * selected the partition. The room stays deployment-blind and never branches on
 * where that principal came from.
 */
export type Connection = {
	principalId: PrincipalId;
	nodeId: string;
	connectedAt: number;
	/**
	 * The catalog agent this connection answers as (ADR-0025), set from the
	 * node's `presence_publish` and mirrored on the wire so a picker can decorate
	 * a durable agent as live. Undefined until published; ordinary participants
	 * never set it. Opaque to the relay (forwarded, never inspected).
	 */
	agentId?: string;
};

/**
 * The PORTABLE Hono context, shared by every library sub-app and BOTH
 * deployments. It carries only the variables every deployment populates, so an
 * instance-mounted route can never reach for a cloud-only one (the type does not
 * name it). The cloud's extra relational-auth state lives on {@link CloudEnv}.
 *
 * `Bindings` is the library's own {@link ServerBindings} contract, NOT
 * `Cloudflare.Env`: the library reads only the portable secrets it declares
 * there, so it never names a Cloudflare type (ADR-0066) and a Bun host
 * typechecks with no Cloudflare types in scope. Each deployment's real env
 * (`Cloudflare.Env` on the Workers edges, a parsed `process.env` on Bun) is a
 * superset assignable to this; a Workers resolver that reads a Cloudflare-only
 * binding casts `env` to its own `Cloudflare.Env` at the `apps/*` edge.
 *
 * `Variables` are populated by request-scoped middleware: the resolved origin and
 * trust set and the resolved principal.
 * The library does NOT carry `planId` (apps/api billing) or any Postgres /
 * Better Auth handle (cloud-only, {@link CloudEnv}).
 */
export type Env = {
	Bindings: ServerBindings;
	Variables: {
		authBaseURL: string;
		/**
		 * Origins this deployment trusts for CORS, cookie-mutation CSRF, and
		 * Better Auth's redirect allow-list. Supplied by the deployment
		 * (`createServerApp`'s `resolveTrustedOrigins`), never hardcoded in the
		 * library: a self-host trusts its own origins, not Epicenter cloud's.
		 */
		trustedOrigins: string[];
		principal: Principal;
		documentAuthorizationExpiresAt: number;
	};
};

/**
 * The CLOUD context: the portable {@link Env} plus the relational-auth state only
 * the hosted cloud composes (Better Auth + Postgres). The single-partition
 * instance composes none of it, so these never appear on the instance's `Env`
 * (ADR-0076): the type makes "the instance reads no cloud secret" a compile fact,
 * not a JSDoc promise. The cloud's auth wrappers, `mountCloudAuth`, `mountCloudDb`,
 * and the `authApp` routes type against this; the portable surfaces stay on `Env`.
 */
export type CloudEnv = {
	Bindings: ServerBindings;
	Variables: Env['Variables'] & {
		/**
		 * The per-request Postgres handle. Populated by `mountCloudDb`. Read by
		 * Better Auth (the only Postgres consumer once room telemetry was deleted).
		 */
		db: NodePgDatabase<typeof schema>;
		/** The per-request Better Auth instance. Populated by `mountCloudAuth`. */
		auth: ReturnType<typeof createAuth>;
		/**
		 * The cloud-only relational-auth secrets ({@link CloudAuthBindings}),
		 * resolved once per request by `mountCloudAuth` from the cloud's own
		 * deploy-gated env so its readers (Better Auth construction and the `authApp`
		 * sign-in page) take them from one resolved value, never the portable `c.env`.
		 */
		authSecrets: CloudAuthBindings;
		/**
		 * Deployment-owned static shell for the hosted auth browser surfaces.
		 * `packages/server` owns auth policy and dispatch, but the deployable owns
		 * where the built SvelteKit fallback comes from: Workers read ASSETS, Bun
		 * can point at local dev or a local build.
		 */
		authUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
		/**
		 * Per-request queue of fire-and-forget promises that must outlive the HTTP
		 * response (billing's Autumn charges). `mountCloudDb` drains the whole queue
		 * (`Promise.allSettled(...).then(close)`) through the deployment's
		 * `afterResponse` hook (`executionCtx.waitUntil` on Workers, the live process
		 * on Bun), then closes the db handle. The queue is the data; the hook is how
		 * it is kept alive.
		 */
		afterResponseQueue: Promise<unknown>[];
	};
};
