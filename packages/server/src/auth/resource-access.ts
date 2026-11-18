/**
 * Check a token's revocation, expiry, audience, scope, and approving session
 * in one SQL statement. The next request sees revocation or sign-out.
 */
import { sql } from 'drizzle-orm';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Db } from '../db/create-db.js';
import {
	hashPrefixedToken,
	type OAuthScope,
	PROTECTED_RESOURCE_METADATA_PATH,
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

/** Read an access token from `Authorization`: a Bearer token, or null. */
export function readAccessToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	return /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() || null;
}

export type AccountAccess = {
	accountId: string;
	email: string;
};

type AccountRow = {
	account_id: string;
	email: string;
	has_audience: boolean;
	has_scope: boolean;
};

/**
 * A missing, expired, revoked, or wrong-audience token gets 401. A token
 * whose approving session has ended also gets 401. A missing scope gets 403.
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
	const metadata = `resource_metadata="${audience}${PROTECTED_RESOURCE_METADATA_PATH}"`;
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
		       u.email,
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
	});
}
