/**
 * CORS middleware.
 *
 * Skips WebSocket upgrades because the 101 response headers are
 * immutable. Trusted origins are the deployment-supplied `c.var.trustedOrigins`
 * (set in `createServerApp`), shared with Better Auth and the cookie-CSRF guard
 * so all three agree on one allow-list.
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { isWebSocketUpgrade } from '../is-websocket-upgrade.js';
import type { Env } from '../types.js';

export const corsMiddleware = createMiddleware<Env>(async (c, next) => {
	if (isWebSocketUpgrade(c)) return next();
	const { trustedOrigins } = c.var;
	return cors({
		origin: (origin) =>
			origin && trustedOrigins.includes(origin) ? origin : undefined,
		credentials: true,
		// `If-None-Match` and an exposed `ETag` used to be here for the document
		// pull's conditional read. No route on this server reads or emits either
		// one now. The blob store's `If-None-Match: *` is not a counterexample:
		// that header rides a presigned PUT straight to S3, which never passes
		// through this middleware and answers to the bucket's own CORS config.
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'Upgrade',
			'X-Epicenter-Principal',
		],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
