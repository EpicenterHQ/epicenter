/**
 * What the authorization server issues (ADR-0549): the scopes, each resource's
 * audience and scope ceiling, token lifetimes, and the token prefixes. The
 * deployment names its audiences and its first-party clients; this module owns
 * the policy every deployment shares.
 */
import type { OAuthResourceInput } from '@better-auth/oauth-provider';

/**
 * Every scope the server grants. A scope exists only while some route refuses
 * a token without it; none of them changes the account.
 */
export const OAUTH_SCOPES = [
	'openid',
	'offline_access',
	'profile',
	'ai',
	'folders:read',
	'folders:write',
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** GitHub's lifetime for user tokens; every request still checks revocation. */
export const ACCESS_TOKEN_TTL_SECONDS = 8 * 60 * 60;
/** Each rotation issues a fresh refresh token, so this is 30 days unused. */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** A replay inside this window receives the cached rotation response. */
export const REFRESH_TOKEN_REUSE_INTERVAL_SECONDS = 60;

/** Prefixes make a leaked token recognizable to secret scanners. */
export const TOKEN_PREFIX = {
	access: 'ep_at_',
	refresh: 'ep_rt_',
} as const;

/** The token audiences of one deployment, named by the deployment. */
export type OAuthAudiences = {
	/** Inference, transcription, `GET /api/repos`, profile and usage reads. */
	api: string;
	/** Git smart HTTP and LFS. */
	git: string;
	/** The folder MCP server. */
	mcp: string;
};

/**
 * The scopes each audience accepts. `openid` and `offline_access` ride along
 * on every audience: the library intersects requested scopes with each
 * resource's list, so leaving `offline_access` out would silently withhold
 * the refresh token.
 */
const AUDIENCE_SCOPES = {
	api: ['ai', 'profile', 'folders:read'],
	git: ['folders:read', 'folders:write'],
	mcp: ['folders:read', 'folders:write'],
} as const satisfies Record<keyof OAuthAudiences, readonly OAuthScope[]>;

/** The `oauthResource` rows for a deployment's audiences. */
export function oauthResourceInputs(
	audiences: OAuthAudiences,
): OAuthResourceInput[] {
	return (Object.keys(AUDIENCE_SCOPES) as (keyof OAuthAudiences)[]).map(
		(kind) => ({
			identifier: audiences[kind],
			accessTokenTtl: ACCESS_TOKEN_TTL_SECONDS,
			allowedScopes: ['openid', 'offline_access', ...AUDIENCE_SCOPES[kind]],
		}),
	);
}

/** SHA-256, base64url without padding: the provider's stored token form. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(token),
	);
	return Buffer.from(digest).toString('base64url');
}

/** Hash a prefixed token the way the provider stored it, or null if unprefixed. */
export function hashPrefixedToken(
	token: string,
	prefix: string,
): Promise<string> | null {
	return token.startsWith(prefix)
		? hashToken(token.slice(prefix.length))
		: null;
}
