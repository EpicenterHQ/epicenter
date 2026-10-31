/**
 * CORS middleware.
 *
 * Trusted origins are the deployment-supplied `c.var.trustedOrigins` (set in
 * `createServerApp`), shared with Better Auth so both agree on one allow-list.
 */

import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types.js';

export const corsMiddleware = createMiddleware<Env>(async (c, next) => {
	const { trustedOrigins } = c.var;
	return cors({
		origin: (origin) =>
			origin && trustedOrigins.includes(origin) ? origin : undefined,
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization', 'X-Epicenter-Principal'],
		allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
