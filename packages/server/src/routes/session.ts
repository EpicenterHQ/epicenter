/**
 * `/api/session`: the profile read. Despite the historical path, it reads an
 * access token's account, not a Better Auth session.
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
 * Mount the profile read on a deployment's server app.
 *
 * The deployment supplies the guard: an access token for its API audience
 * with the `profile` scope (ADR-0549).
 */
export function mountSessionApp<E extends Env = Env>(
	app: Hono<E>,
	opts: { auth: MiddlewareHandler<E> },
): void {
	app.get(
		API_ROUTES.session.pattern,
		opts.auth,
		describeRoute({
			description: 'Return the account the access token acts for',
			tags: ['auth'],
		}),
		async (c: Context<Env>) => {
			return c.json({
				principalId: c.var.principal.id,
				email: c.var.principal.email,
			} satisfies ApiSessionResponse);
		},
	);
}
