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
		allowHeaders: [
			'Content-Type',
			'Authorization',
			'Upgrade',
			'X-Epicenter-Principal',
			'If-Match',
			'If-Range',
			'Range',
		],
		allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		exposeHeaders: ['ETag', 'Content-Range', 'Accept-Ranges'],
	})(c, next);
});
