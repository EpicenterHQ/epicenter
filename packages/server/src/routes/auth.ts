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
import { type OAuthAudiences, SCOPES_SUPPORTED } from '../auth/oauth-policy.js';
import { protectedResourceMetadataUrl } from '../auth/resource-access.js';
import type { CloudEnv } from '../types.js';

/** The browser pages this server owns, served from the deployment's UI shell. */
const AUTH_PAGES = ['/sign-in', '/consent', '/device'];

/** The RFC 9728 document for one audience: the scopes its routes check. */
function protectedResourceMetadata(
	kind: keyof OAuthAudiences,
	audience: string,
	issuer: string,
) {
	return {
		resource: audience,
		authorization_servers: [issuer],
		scopes_supported: SCOPES_SUPPORTED[kind],
		bearer_methods_supported: ['header'],
	};
}

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

	// RFC 9728: each audience names this issuer. A resource's 401 points here
	// through `resource_metadata`, on the resource's own host: an audience on
	// another host (`git.epicenter.so`) is answered when
	// that host routes to this server, and never from the API's host.
	app.get('/.well-known/oauth-protected-resource/*', (c) =>
		protectedResource(c),
	);
	app.get('/.well-known/oauth-protected-resource', (c) => protectedResource(c));
	function protectedResource(c: Context<CloudEnv>) {
		const requested = new URL(c.req.url);
		const issuer = `${new URL(c.var.authBaseURL).origin}/auth`;
		const { audiences } = c.var;
		for (const kind of Object.keys(audiences) as (keyof OAuthAudiences)[]) {
			const metadataUrl = new URL(
				protectedResourceMetadataUrl(audiences[kind]),
			);
			if (
				metadataUrl.origin === requested.origin &&
				metadataUrl.pathname === requested.pathname
			)
				return c.json(
					protectedResourceMetadata(kind, audiences[kind], issuer),
					200,
					{ 'Cache-Control': 'public, max-age=3600' },
				);
		}
		return c.notFound();
	}

	app.on(
		['GET', 'POST'],
		'/auth/*',
		opts.setup,
		describeRoute({ description: 'Better Auth handler', tags: ['auth'] }),
		(c) => c.var.auth.handler(c.req.raw),
	);
}
