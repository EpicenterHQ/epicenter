/**
 * Hosted sign-in and Better Auth's session/provider endpoints.
 * The sign-in UI performs the explicit POST handoff; a GET never issues a code.
 */
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import type { CloudEnv } from '../types.js';

export const authApp = new Hono<CloudEnv>()
	.get('/sign-in', async (c) => {
		const shell = await c.var.authUiShell(c);
		const headers = new Headers(shell.headers);
		headers.set('Cache-Control', 'no-store');
		headers.set('Referrer-Policy', 'no-referrer');
		return new Response(shell.body, { status: shell.status, headers });
	})
	.on(
		['GET', 'POST'],
		'/auth/*',
		describeRoute({ description: 'Better Auth handler', tags: ['auth'] }),
		(c) => c.var.auth.handler(c.req.raw),
	);
