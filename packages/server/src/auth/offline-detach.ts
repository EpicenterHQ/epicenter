/**
 * An `offline_access` grant to a native client (the desktop app, the CLI)
 * outlives the browser session that approved it (ADR-0549). The provider
 * copies the approving session's id onto the refresh token, every rotation
 * copies it forward, and a token whose session has expired is inactive.
 * Clearing `sessionId` at issuance detaches the grant; the device grant never
 * has one.
 *
 * A web client's grant stays bound. A browser app asks for `offline_access`
 * only to mint one access token per audience in its sign-in callback and
 * keeps no refresh token, so its grant ends with the session: signing out
 * deletes the session, and the foreign keys delete its refresh and access
 * tokens with it.
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { hashPrefixedToken, TOKEN_PREFIX } from './oauth-policy.js';

export function offlineDetach() {
	return {
		id: 'offline-detach',
		hooks: {
			after: [
				{
					matcher: (ctx) =>
						ctx.path === '/oauth2/token' &&
						(ctx.body as { grant_type?: unknown } | undefined)?.grant_type ===
							'authorization_code',
					handler: createAuthMiddleware(async (ctx) => {
						const issued = ctx.context.returned as
							| { refresh_token?: unknown }
							| undefined;
						if (!issued || typeof issued.refresh_token !== 'string') return;
						const refreshHash = await hashPrefixedToken(
							issued.refresh_token,
							TOKEN_PREFIX.refresh,
						);
						if (!refreshHash) return;
						const refresh = await ctx.context.adapter.findOne<{
							id: string;
							clientId: string;
						}>({
							model: 'oauthRefreshToken',
							where: [{ field: 'token', value: refreshHash }],
						});
						if (!refresh) return;
						const client = await ctx.context.adapter.findOne<{
							applicationType: string | null;
						}>({
							model: 'oauthClient',
							where: [{ field: 'clientId', value: refresh.clientId }],
						});
						if (client?.applicationType === 'web') return;
						await ctx.context.adapter.update({
							model: 'oauthRefreshToken',
							where: [{ field: 'id', value: refresh.id }],
							update: { sessionId: null },
						});
						await ctx.context.adapter.updateMany({
							model: 'oauthAccessToken',
							where: [{ field: 'refreshId', value: refresh.id }],
							update: { sessionId: null },
						});
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
