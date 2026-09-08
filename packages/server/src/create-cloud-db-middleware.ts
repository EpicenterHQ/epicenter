/**
 * Cloud database middleware for routes that need relational state.
 * Owns one acquired handle and closes it after all queued work settles, even
 * when a handler or queued promise fails. Deployments own acquisition and
 * keeping the drain alive after the response; public routes never install it.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Db } from './db/create-db.js';
import type { ServerBindings } from './server-bindings.js';
import type { CloudEnv } from './types.js';

export function createCloudDbMiddleware(opts: {
	/**
	 * Acquire a per-request database handle and how to close it. The returned
	 * `close` runs after the after-response queue drains. The library depends on
	 * the portable `pg`/drizzle wire (ADR-0066), never a binding shape: the
	 * Cloudflare cloud casts `c.env` to its own `Cloudflare.Env` at the edge.
	 */
	connect: (
		env: ServerBindings,
	) => Promise<{ db: Db; close: () => Promise<void> }>;
	/**
	 * Keep fire-and-forget work alive past the HTTP response. Cloudflare hands the
	 * drain to `c.executionCtx.waitUntil(work)` (holds the isolate open); a Bun
	 * host does nothing (the live process runs it).
	 */
	afterResponse: (c: Context<CloudEnv>, work: Promise<unknown>) => void;
}): MiddlewareHandler<CloudEnv> {
	return async (c, next) => {
		const { db, close } = await opts.connect(c.env);
		const queue: Promise<unknown>[] = [];
		try {
			c.set('db', db);
			c.set('afterResponseQueue', queue);
			await next();
		} finally {
			opts.afterResponse(
				c,
				Promise.allSettled(queue).then(() => close()),
			);
		}
	};
}
