/**
 * `/api/session`: the authenticated session projection.
 *
 * Returns the authenticated principal. Clients cache the principal id so
 * store boot and local-storage keying work offline.
 *
 * {@link mountSessionApp} wires the deployment's auth middleware so
 * `c.var.principal` is populated before the handler runs. Deployment shape is
 * not on the wire; it is a property of the server (see `PrincipalId` in
 * `@epicenter/principal`).
 */

import type { ApiSessionResponse } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { Env } from '../types.js';

/**
 * Mount the session surface on a deployment's server app.
 *
 * The deployment supplies `requireBearerPrincipal` with its session or
 * instance-token resolver. Bundles that auth and the route mount into one call.
 */
export function mountSessionApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { auth: MiddlewareHandler<E> },
): void {
	app.get(
		API_ROUTES.session.pattern,
		opts.auth,
		describeRoute({
			description: 'Return the authenticated session projection',
			tags: ['auth'],
		}),
		async (c: Context<Env>) => {
			const principal = c.var.principal;
			return c.json({
				principalId: principal.id,
				email: principal.email,
			} satisfies ApiSessionResponse);
		},
	);
}
