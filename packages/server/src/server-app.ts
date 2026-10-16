/**
 * Server app factory. Wires the portable per-request lifecycle (origin + trust
 * resolution, CORS) and returns a `Hono` instance the deployment mounts
 * every other sub-app on.
 *
 * It takes exactly one thing, the single axis a deployment varies on: an
 * {@link Identity}, who THIS deployment is on the web (its canonical origin, the
 * origins it trusts, and its token audiences). That varies per deployment, NOT
 * per runtime, so `apps/api` passes the same identity whether it runs on Workers or Bun.
 *
 * Nothing else here is runtime-specific. The cloud's Postgres connection and
 * `waitUntil` drain are cloud concerns the cloud installs itself
 * ({@link createCloudContextMiddleware}) on database-dependent routes. Public shells
 * bypass that middleware; the instance composes no Postgres.
 *
 * Generic over the context `E`: the cloud composes `createServerApp<CloudEnv>` so
 * it can add db + Better Auth state, the instance composes `createServerApp()`
 * (portable {@link Env}) and the type cannot name a cloud variable.
 */

import { Hono } from 'hono';
import type { OAuthAudiences } from './auth/oauth-policy.js';
import { corsMiddleware } from './middleware/cors.js';
import type { ServerBindings } from './server-bindings.js';
import type { Env } from './types.js';

/**
 * Who this deployment IS on the web. Orthogonal to the runtime: these vary per
 * deployment, not per runtime, so they are supplied explicitly and the auth
 * origin is never inferred from the request.
 */
export type Identity = {
	/**
	 * This deployment's canonical public origin, resolved from the per-request
	 * `env`. Becomes the Better Auth `baseURL` and hosted callback origin,
	 * so it must be stable per deployment and never inferred from `c.req.url`.
	 * `apps/api` returns `env.API_PUBLIC_ORIGIN ?? PRODUCTION_API_URL` (dev
	 * override, else the baked constant); its Bun entry returns
	 * `API_PUBLIC_ORIGIN` or its localhost listen origin.
	 */
	resolveOrigin: (env: ServerBindings) => string;
	/**
	 * The origins this deployment trusts for CORS and Better Auth's origin
	 * and redirect allow-list. The library hardcodes none: `apps/api`
	 * supplies the Epicenter app origins. Receives
	 * the resolved `baseURL` so a deployment can include its own origin without
	 * restating it, and the per-request `env` so a deployment whose trust set is
	 * operator-configured can read its own binding. A deployment that resolves
	 * its trust set at boot (any Bun host) should close over the result and
	 * ignore both parameters.
	 */
	resolveTrustedOrigins: (baseURL: string, env: ServerBindings) => string[];
	/**
	 * This deployment's OAuth token audiences, which the deployment names
	 * (ADR-0326). Receives the resolved `baseURL`: `apps/api` passes
	 * `resolveOAuthAudiences`, which puts the hosted cloud's audiences on
	 * their own hosts and any other deployment's under its origin. Every
	 * resource guard, mount, and the authorization server reads the result
	 * from `c.var.audiences`.
	 */
	resolveAudiences: (baseURL: string) => OAuthAudiences;
};

/**
 * Construct the parent `Hono` app every deployment mounts sub-apps onto.
 *
 * Installs the ordered portable request-scoped middlewares:
 *
 *   1. Origin, trust, and audience resolution (a pure read of the env binding).
 *   2. CORS.
 *
 * Cookie routes guard their own origin: `requireSessionCookie` refuses another
 * origin and a state change that names none.
 *
 * The deployment is responsible for exposing a health endpoint on `/`. The cloud's
 * relational-auth context (`c.var.auth`, `c.var.db`) is NOT installed here: the
 * cloud adds it via {@link createCloudContextMiddleware} on the routes that need it.
 */
export function createServerApp<E extends Env = Env>({
	resolveOrigin,
	resolveTrustedOrigins,
	resolveAudiences,
}: Identity): Hono<E> {
	const app = new Hono<E>();

	// 1. Deployment auth origin, trust set, and token audiences. Resolved
	// first (a pure read of the env binding, no DB) so downstream middleware,
	// including CORS, can scope the trusted-origin allow-list to this
	// deployment. The origin is supplied explicitly and never inferred from the
	// request, so hosted callback URLs are stable per deployment.
	app.use('*', async (c, next) => {
		const baseURL = resolveOrigin(c.env);
		c.set('authBaseURL', baseURL);
		c.set('trustedOrigins', resolveTrustedOrigins(baseURL, c.env));
		c.set('audiences', resolveAudiences(baseURL));
		await next();
	});

	// 2. CORS
	app.use('*', corsMiddleware);

	return app;
}
