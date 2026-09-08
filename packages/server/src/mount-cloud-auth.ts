/**
 * Mount public auth shells and database-backed Better Auth endpoints.
 * Returns the same database/auth middleware for protected resource mounts.
 * The deployment must attach it before each resource's authentication guard.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { every } from 'hono/combine';
import { type CloudAuthBindings, createAuth } from './auth/create-auth.js';
import { mountAuthRoutes } from './routes/auth.js';
import type { CloudEnv } from './types.js';

export { CloudAuthBindings } from './auth/create-auth.js';

export function mountCloudAuth(
	app: Hono<CloudEnv>,
	opts: {
		database: MiddlewareHandler<CloudEnv>;
		/**
		 * Resolve this cloud deployment's relational-auth secrets
		 * ({@link CloudAuthBindings}) from its own env. The secrets are NOT in the
		 * portable `ServerBindings` (the relational-auth substrate is Cloud-only,
		 * ADR-0076), so the cloud supplies them at its own edge: the Worker casts its
		 * deploy-gated `c.env as Cloudflare.Env`, the Bun host closes over its
		 * validated env. Read per request because a Worker has no module-scope env.
		 */
		resolveAuthSecrets: (c: Context<CloudEnv>) => CloudAuthBindings;
		resolveSessionCallbacks: (c: Context<CloudEnv>) => readonly string[];
		/**
		 * Serve the SvelteKit fallback shell for hosted auth browser surfaces after
		 * auth route policy has run. The app deployment owns the concrete asset
		 * source; the shared server package only calls it.
		 */
		serveAuthUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
	},
): MiddlewareHandler<CloudEnv> {
	const auth: MiddlewareHandler<CloudEnv> = async (c, next) => {
		c.set(
			'auth',
			createAuth({
				db: c.var.db,
				env: opts.resolveAuthSecrets(c),
				baseURL: c.var.authBaseURL,
				trustedOrigins: c.var.trustedOrigins,
				sessionCallbacks: opts.resolveSessionCallbacks(c),
			}),
		);
		await next();
	};
	const setup = every(opts.database, auth);
	mountAuthRoutes(app, { setup, serveAuthUiShell: opts.serveAuthUiShell });
	return setup;
}
