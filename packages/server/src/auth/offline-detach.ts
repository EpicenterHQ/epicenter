/**
 * An `offline_access` grant (the desktop app, the CLI) outlives
 * the browser session that approved it (ADR-0549). The provider copies the
 * approving session's id onto the refresh token, every rotation copies it
 * forward, and a token whose session has expired is inactive. Clearing
 * `sessionId` at issuance detaches the grant; the device grant never has one.
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
						const refresh = await ctx.context.adapter.findOne<{ id: string }>({
							model: 'oauthRefreshToken',
							where: [{ field: 'token', value: refreshHash }],
						});
						if (!refresh) return;
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
