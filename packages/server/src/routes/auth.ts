/**
 * Auth surface sub-app.
 *
 * Mounts every URL the auth flows live behind:
 *
 *   /sign-in          hosted auth UI shell after redirect policy
 *   /consent          hosted consent UI shell after session policy
 *   /auth/.well-known/openid-configuration   OIDC discovery
 *   /auth/.well-known/oauth-authorization-server   OAuth metadata
 *   /.well-known/oauth-protected-resource   resource server metadata
 *   /auth/*           Better Auth catch-all (all sign-up, sign-in, OAuth,
 *                     consent endpoints Better Auth itself owns)
 *
 * Deployments mount this whole sub-app at root; nothing in here depends on
 * the principal partition because authentication is identity, not data.
 */

import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { oauthProviderResourceClient } from '@better-auth/oauth-provider/resource-client';
import { OAUTH_ROUTES } from '@epicenter/constants/oauth-routes';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import {
	createOAuthIssuerURL,
	OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
	OAUTH_METADATA_CACHE_CONTROL,
	OAUTH_OPENID_CONFIGURATION_PATH,
	OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
} from '../auth/oauth-metadata.js';
import type { CloudEnv } from '../types.js';

/**
 * Auth sub-app. Registration order matters: OAuth discovery routes must
 * register before the `/auth/*` Better Auth catch-all, or the catch-all
 * swallows discovery requests.
 */
export const authApp = new Hono<CloudEnv>()
	// Hosted sign-in UI. Re-entry into OAuth happens when the caller arrives
	// with `?sig=` (signed authorize params); safe callback URLs are resolved
	// before the browser shell renders.
	.get('/sign-in', async (c) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (session) {
			const url = new URL(c.req.url);
			if (url.searchParams.has('sig')) {
				return c.redirect(`${OAUTH_ROUTES.authorize.pattern}${url.search}`);
			}
			const callbackURL = url.searchParams.get('callbackURL');
			const callback = callbackURL?.startsWith('/')
				? URL.parse(callbackURL, url)
				: null;
			if (callback?.origin === url.origin) {
				return c.redirect(
					`${callback.pathname}${callback.search}${callback.hash}`,
				);
			}
		}
		return c.var.authUiShell(c);
	})
	// Hosted consent UI. Requires a session; redirects to sign-in (with a
	// callbackURL pointing back) when missing.
	.get('/consent', async (c) => {
		const session = await c.var.auth.api.getSession({
			headers: c.req.raw.headers,
		});
		if (!session) {
			const consentUrl = `/consent${new URL(c.req.url).search}`;
			return c.redirect(
				`/sign-in?callbackURL=${encodeURIComponent(consentUrl)}`,
			);
		}
		return c.var.authUiShell(c);
	})
	// OAuth discovery. MUST register before /auth/* below; Hono matches in
	// registration order and the catch-all otherwise wins.
	.get(
		OAUTH_OPENID_CONFIGURATION_PATH,
		describeRoute({
			description: 'OpenID Connect discovery metadata',
			tags: ['auth', 'oauth'],
		}),
		(c) =>
			oauthProviderOpenIdConfigMetadata(
				c.var.auth as Parameters<typeof oauthProviderOpenIdConfigMetadata>[0],
			)(c.req.raw),
	)
	.get(
		OAUTH_AUTHORIZATION_SERVER_METADATA_PATH,
		describeRoute({
			description: 'OAuth authorization server metadata',
			tags: ['auth', 'oauth'],
		}),
		(c) =>
			oauthProviderAuthServerMetadata(
				c.var.auth as Parameters<typeof oauthProviderAuthServerMetadata>[0],
			)(c.req.raw),
	)
	.get(
		OAUTH_PROTECTED_RESOURCE_METADATA_PATH,
		describeRoute({
			description: 'OAuth protected resource metadata',
			tags: ['auth', 'oauth'],
		}),
		async (c) => {
			const resource = oauthProviderResourceClient();
			const metadata = await resource
				.getActions()
				.getProtectedResourceMetadata({
					resource: c.var.authBaseURL,
					authorization_servers: [createOAuthIssuerURL(c.var.authBaseURL)],
				});
			c.header('Cache-Control', OAUTH_METADATA_CACHE_CONTROL);
			return c.json(metadata);
		},
	)
	// Better Auth catch-all.
	.on(
		['GET', 'POST'],
		'/auth/*',
		describeRoute({
			description: 'Better Auth handler',
			tags: ['auth'],
		}),
		(c) => c.var.auth.handler(c.req.raw),
	);
