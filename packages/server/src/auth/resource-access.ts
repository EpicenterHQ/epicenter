/**
 * The one check every resource runs on an access token (ADR-0549): one SQL
 * statement over the token's SHA-256 hash that decides revocation, expiry,
 * audience, scope, and, for a grant tied to a browser session, that
 * session's life. Nothing is cached, so a revocation or an ended session
 * takes effect on the very next request.
 */
import { sql } from 'drizzle-orm';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Db } from '../db/create-db.js';
import {
	hashPrefixedToken,
	type OAuthScope,
	TOKEN_PREFIX,
} from './oauth-policy.js';

/** A refusal, ready to send: status, challenge header, and JSON body. */
export type ResourceRefusal = {
	status: 401 | 403;
	/** The RFC 6750 challenge, always naming the resource's metadata (RFC 9728). */
	challenge: string;
	body: {
		error: 'invalid_token' | 'insufficient_scope';
		error_description: string;
	};
};

/**
 * The current time as the UTC wall-clock string the token and session columns
 * hold. They are `timestamp` without a time zone, and Better Auth writes them
 * in UTC; a `Date` parameter would reach Postgres in the host's local time,
 * whose offset the cast to `timestamp` drops, so on a host east of UTC every
 * token would read as expired.
 */
function utcNow(): string {
	return new Date().toISOString();
}

/**
 * Where a resource's RFC 9728 metadata lives: the well-known segment goes
 * between the audience's origin and its path.
 */
export function protectedResourceMetadataUrl(audience: string): string {
	const url = new URL(audience);
	const path = url.pathname === '/' ? '' : url.pathname;
	return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Read an access token from `Authorization`: a Bearer token, or null. */
export function readAccessToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	return /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() || null;
}

/** Who the token acts for on a resource. */
export type AccountAccess = {
	accountId: string;
	email: string;
	clientId: string;
	/**
	 * The folders the token reaches: null for every folder its person holds
	 * (`folders:all`), else the client id of the app whose attached folders
	 * it reaches.
	 */
	app: string | null;
};

type AccountRow = {
	account_id: string;
	client_id: string;
	email: string;
	every_folder: boolean;
	has_audience: boolean;
	has_scope: boolean;
};

/**
 * Decide one request to a resource that acts on the person's account:
 * inference and transcription.
 *
 * - 401 `invalid_token` for a missing, unknown, expired, or revoked token, a
 *   token whose approving browser session ended, or a token whose audience is
 *   not exactly this resource;
 * - 403 `insufficient_scope` when the token lacks `scope`.
 *
 * A token naming several audiences is refused at each. Every scope rides on
 * every token (`oauthResourceInputs`), so the audience alone keeps a folders
 * token out of inference, and the library issues a token for every bound
 * audience when a token request omits `resource`. Refusing those makes one
 * audience per token a server invariant rather than each client's discipline.
 */
export async function authorizeAccountRequest(
	db: Db,
	{
		token,
		audience,
		scope,
	}: {
		token: string | null;
		/** This resource's identifier, the token's required audience. */
		audience: string;
		scope: OAuthScope;
	},
): Promise<Result<AccountAccess, ResourceRefusal>> {
	const metadata = `resource_metadata="${protectedResourceMetadataUrl(audience)}"`;
	const invalid = (description: string) =>
		Err<ResourceRefusal>({
			status: 401,
			challenge: `Bearer error="invalid_token", ${metadata}`,
			body: { error: 'invalid_token', error_description: description },
		});
	const hash = token
		? await hashPrefixedToken(token, TOKEN_PREFIX.access)
		: null;
	if (!hash) return invalid('An Epicenter access token is required.');
	const now = utcNow();
	const { rows } = await db.execute<AccountRow>(sql`
		select t.user_id as account_id,
		       t.client_id,
		       u.email,
		       'folders:all' = any(t.scopes) as every_folder,
		       t.resources = array[${audience}]::text[] as has_audience,
		       ${scope} = any(t.scopes) as has_scope
		from oauth_access_token t
		join "user" u on u.id = t.user_id
		left join session s on s.id = t.session_id
		where t.token = ${hash}
		  and t.revoked is null
		  and t.expires_at > ${now}
		  and (t.session_id is null or s.expires_at > ${now})
	`);
	const row = rows[0];
	if (!row) return invalid('The access token is unknown, expired, or revoked.');
	if (!row.has_audience)
		return invalid('The access token was issued for another resource.');
	if (!row.has_scope)
		return Err({
			status: 403,
			challenge: `Bearer error="insufficient_scope", scope="${scope}", ${metadata}`,
			body: {
				error: 'insufficient_scope',
				error_description: `This operation needs the ${scope} scope.`,
			},
		});
	return Ok({
		accountId: row.account_id,
		email: row.email,
		clientId: row.client_id,
		app: row.every_folder ? null : row.client_id,
	});
}
