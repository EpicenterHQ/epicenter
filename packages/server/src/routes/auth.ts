/**
 * Hosted sign-in, the authorization server's pages and discovery, and Better
 * Auth's endpoints. The sign-in UI performs the explicit POST handoff; a GET
 * never issues a code.
 */
import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { describeRoute } from 'hono-openapi';
import { OAUTH_SCOPES, type OAuthAudiences } from '../auth/oauth-policy.js';
import { protectedResourceMetadataUrl } from '../auth/resource-access.js';
import type { CloudEnv } from '../types.js';

/** The browser pages this server owns, served from the deployment's UI shell. */
const AUTH_PAGES = ['/sign-in', '/session/callback', '/consent', '/device'];

/** The RFC 9728 document for one audience this origin serves. */
function protectedResourceMetadata(audience: string, issuer: string) {
	return {
		resource: audience,
		authorization_servers: [issuer],
		scopes_supported: OAUTH_SCOPES.filter(
			(scope) => scope !== 'openid' && scope !== 'offline_access',
		),
		bearer_methods_supported: ['header'],
	};
}

export function mountAuthRoutes(
	app: Hono<CloudEnv>,
	opts: {
		/** Builds the request's Better Auth instance with the authorization server. */
		setup: MiddlewareHandler<CloudEnv>;
		serveAuthUiShell: (c: Context<CloudEnv>) => Response | Promise<Response>;
		/** This deployment's token audiences; the same ones `setup` composes. */
		resolveAudiences: (c: Context<CloudEnv>) => OAuthAudiences;
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

	// RFC 9728: each audience this origin serves names this issuer. A
	// resource's 401 points here through `resource_metadata`.
	app.get('/.well-known/oauth-protected-resource/*', (c) =>
		protectedResource(c),
	);
	app.get('/.well-known/oauth-protected-resource', (c) => protectedResource(c));
	function protectedResource(c: Context<CloudEnv>) {
		const requested = new URL(c.req.url).pathname;
		const origin = new URL(c.var.authBaseURL).origin;
		for (const audience of Object.values(opts.resolveAudiences(c))) {
			const metadataUrl = new URL(protectedResourceMetadataUrl(audience));
			if (metadataUrl.origin === origin && metadataUrl.pathname === requested)
				return c.json(
					protectedResourceMetadata(audience, `${origin}/auth`),
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
