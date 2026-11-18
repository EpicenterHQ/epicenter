/**
 * Hosted sign-in, the authorization server's pages and discovery, and Better
 * Auth's endpoints.
 */
import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { PROTECTED_RESOURCE_METADATA_PATH } from '../auth/oauth-policy.js';
import type { CloudEnv } from '../types.js';

/** The browser pages this server owns, served from the deployment's UI shell. */
const AUTH_PAGES = ['/sign-in', '/consent', '/device'];

export function mountAuthRoutes(
	app: Hono<CloudEnv>,
	opts: {
		/** Builds the request's Better Auth instance with the authorization server. */
		setup: MiddlewareHandler<CloudEnv>;
		serveAuthUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
	},
): void {
	app.on('GET', AUTH_PAGES, async (c) => {
		const shell = await opts.serveAuthUiShell(c);
		const headers = new Headers(shell.headers);
		headers.set('Cache-Control', 'no-store');
		headers.set('Referrer-Policy', 'no-referrer');
		return new Response(shell.body, { status: shell.status, headers });
	});

	// The issuer is `<origin>/auth`, so RFC 8414 discovery inserts the
	// well-known segment before the path, and OpenID's appends it.
	app.get('/.well-known/oauth-authorization-server/auth', opts.setup, (c) =>
		oauthProviderAuthServerMetadata(c.var.auth)(c.req.raw),
	);
	app.get('/auth/.well-known/openid-configuration', opts.setup, (c) =>
		oauthProviderOpenIdConfigMetadata(c.var.auth)(c.req.raw),
	);

	// A resource's 401 links to this RFC 9728 document on the API origin.
	app.get(PROTECTED_RESOURCE_METADATA_PATH, (c) => {
		const origin = c.var.authBaseURL;
		const requestUrl = new URL(c.req.url);
		if (
			requestUrl.origin !== origin ||
			requestUrl.pathname !== PROTECTED_RESOURCE_METADATA_PATH
		)
			return c.notFound();
		return c.json(
			{
				resource: origin,
				authorization_servers: [`${origin}/auth`],
				scopes_supported: ['ai'],
				bearer_methods_supported: ['header'],
			},
			200,
			{ 'Cache-Control': 'public, max-age=3600' },
		);
	});

	app.on(
		['GET', 'POST'],
		'/auth/*',
		opts.setup,
		describeRoute({ description: 'Better Auth handler', tags: ['auth'] }),
		(c) => c.var.auth.handler(c.req.raw),
	);
}
