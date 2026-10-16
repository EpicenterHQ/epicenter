/**
 * What the authorization server issues (ADR-0549, ADR-0565): the scopes, each
 * resource's audience and scope ceiling, token lifetimes, and the token
 * prefixes. The deployment names its audiences and its first-party clients;
 * this module owns the policy every deployment shares.
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
 * The scopes each audience's routes check, as its protected resource metadata
 * (RFC 9728) lists them. This is what a client asks for to use the audience,
 * not what a token for it may carry: see {@link oauthResourceInputs}.
 */
export const SCOPES_SUPPORTED = {
	api: ['ai', 'profile', 'folders:read'],
	git: ['folders:read', 'folders:write'],
	mcp: ['folders:read', 'folders:write'],
} as const satisfies Record<keyof OAuthAudiences, readonly OAuthScope[]>;

/**
 * The `oauthResource` rows for a deployment's audiences.
 *
 * `allowedScopes` is what a token for the audience may carry. The library
 * intersects a request's scopes with it and stores the result on the refresh
 * token as well as the access token, so a list narrower than the grant would
 * shrink the grant on its first refresh for that audience. The first-party
 * audiences, `api` and `git`, therefore allow every scope: a refresh never
 * narrows the grant, and the audience alone keeps a Git token out of
 * inference. `mcp` allows only its own scopes, plus `openid` and
 * `offline_access`, as the ceiling for third-party clients, whose only
 * audience it is.
 */
export function oauthResourceInputs(
	audiences: OAuthAudiences,
): OAuthResourceInput[] {
	const allowedScopes = {
		api: [...OAUTH_SCOPES],
		git: [...OAUTH_SCOPES],
		mcp: ['openid', 'offline_access', ...SCOPES_SUPPORTED.mcp],
	} satisfies Record<keyof OAuthAudiences, OAuthScope[]>;
	return (Object.keys(allowedScopes) as (keyof OAuthAudiences)[]).map(
		(kind) => ({
			identifier: audiences[kind],
			accessTokenTtl: ACCESS_TOKEN_TTL_SECONDS,
			allowedScopes: allowedScopes[kind],
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
