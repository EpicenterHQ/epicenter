/**
 * Hosted sign-in and Better Auth's session/provider endpoints.
 * The sign-in UI performs the explicit POST handoff; a GET never issues a code.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { CloudEnv } from '../types.js';

export function mountAuthRoutes(
	app: Hono<CloudEnv>,
	opts: {
		setup: MiddlewareHandler<CloudEnv>;
		serveAuthUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
	},
): void {
	app
		.on('GET', ['/sign-in', '/session/callback'], async (c) => {
			const shell = await opts.serveAuthUiShell(c);
			const headers = new Headers(shell.headers);
			headers.set('Cache-Control', 'no-store');
			headers.set('Referrer-Policy', 'no-referrer');
			return new Response(shell.body, { status: shell.status, headers });
		})
		.on(
			['GET', 'POST'],
			'/auth/*',
			opts.setup,
			describeRoute({ description: 'Better Auth handler', tags: ['auth'] }),
			(c) => c.var.auth.handler(c.req.raw),
		);
}
