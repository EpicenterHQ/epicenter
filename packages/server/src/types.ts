/**
 * Library types shared by sub-app factories and middleware.
 *
 * Per-request state lives on the Hono context (`c.var.principal`, `c.var.db`,
 * etc.). The authenticated principal id is the partition key by definition.
 */

import type { Principal } from '@epicenter/auth';
import type { createAuth } from './auth/create-auth.js';
import type { OAuthAudiences } from './auth/oauth-policy.js';
import type { Db } from './db/create-db.js';
import type { ServerBindings } from './server-bindings.js';

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
 * `Variables` are populated by request-scoped middleware: the resolved origin,
 * trust set, and token audiences, and the resolved principal.
 * The library does NOT carry `planId` (apps/api billing) or any Postgres /
 * Better Auth handle (cloud-only, {@link CloudEnv}).
 */
export type Env = {
	Bindings: ServerBindings;
	Variables: {
		authBaseURL: string;
		/**
		 * Origins this deployment trusts for CORS and Better Auth's origin and
		 * redirect allow-list. Supplied by the deployment
		 * (`createServerApp`'s `resolveTrustedOrigins`), never hardcoded in the
		 * library.
		 */
		trustedOrigins: string[];
		/**
		 * This deployment's OAuth token audiences, resolved from `authBaseURL`
		 * by the deployment (`createServerApp`'s `resolveAudiences`).
		 */
		audiences: OAuthAudiences;
		principal: Principal;
	};
};

/**
 * The CLOUD context: the portable {@link Env} plus the relational-auth state only
 * apps/api composes on both runtimes (Better Auth + Postgres). The cloud's auth
 * wrappers, `createCloudContextMiddleware`,
 * and the hosted auth routes type against this; the portable surfaces stay on `Env`.
 */
export type CloudEnv = {
	Bindings: ServerBindings;
	Variables: Env['Variables'] & {
		/**
		 * The per-request Postgres handle. Populated by `createCloudContextMiddleware`. Read by
		 * Better Auth and hosted account/billing operations.
		 */
		db: Db;
		/** The per-request Better Auth instance, set by createCloudContextMiddleware. */
		auth: ReturnType<typeof createAuth>;
		/**
		 * Per-request queue of fire-and-forget promises that must outlive the HTTP
		 * response (billing's Autumn charges). `createCloudContextMiddleware` drains the whole queue
		 * (`Promise.allSettled(...).then(close)`) through the deployment's
		 * `afterResponse` hook (`executionCtx.waitUntil` on Workers, the live process
		 * on Bun), then closes the db handle. The queue is the data; the hook is how
		 * it is kept alive.
		 */
		afterResponseQueue: Promise<unknown>[];
	};
};
