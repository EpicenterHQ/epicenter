/**
 * OAuth policy shared by the Bun and Worker deployments (ADR-0549, ADR-0565).
 */
import type { OAuthResourceInput } from '@better-auth/oauth-provider';

/**
 * Every scope the server grants. A scope exists only while some route refuses
 * a token without it, or userinfo withholds a claim without it (`email`);
 * none of them changes the account.
 */
export const OAUTH_SCOPES = [
	'openid',
	'offline_access',
	'profile',
	'email',
	'ai',
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

export const PROTECTED_RESOURCE_METADATA_PATH =
	'/.well-known/oauth-protected-resource';

/** The OAuth resource row for inference and transcription. */
export function oauthResourceInputs(origin: string): OAuthResourceInput[] {
	return [
		{
			identifier: origin,
			accessTokenTtl: ACCESS_TOKEN_TTL_SECONDS,
			allowedScopes: [...OAUTH_SCOPES],
		},
	];
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
