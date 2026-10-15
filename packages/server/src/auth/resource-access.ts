/**
 * The one check every resource runs on an access token (ADR-0549): one SQL
 * statement over the token's SHA-256 hash that decides revocation, expiry,
 * audience, scope, grant target, membership, and, for a grant tied to a
 * browser session, that session's life. Nothing is cached, so a revocation or
 * a removed member takes effect on the very next request.
 */
import { sql } from 'drizzle-orm';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Db } from '../db/create-db.js';
import type { NamespaceRole } from '../namespace-roles.js';
import {
	hashPrefixedToken,
	type OAuthScope,
	TOKEN_PREFIX,
} from './oauth-policy.js';

/** Who the token acts for in the requested namespace. */
export type ResourceAccess = {
	accountId: string;
	role: NamespaceRole;
	clientId: string;
};

/** A refusal, ready to send: status, challenge header, and JSON body. */
export type ResourceRefusal = {
	status: 401 | 403;
	/** The RFC 6750 challenge, always naming the resource's metadata (RFC 9728). */
	challenge: string;
	body: {
		error: 'invalid_token' | 'insufficient_scope' | 'forbidden';
		error_description: string;
	};
};

/**
 * Where a resource's RFC 9728 metadata lives: the well-known segment goes
 * between the audience's origin and its path.
 */
export function protectedResourceMetadataUrl(audience: string): string {
	const url = new URL(audience);
	const path = url.pathname === '/' ? '' : url.pathname;
	return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * Read an access token from `Authorization`: a Bearer token, or the password
 * of Basic credentials with any username, which is how Git sends it.
 */
export function readAccessToken(authorization: string | null | undefined) {
	if (!authorization) return null;
	const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
	if (bearer) return bearer;
	const basic = /^Basic\s+(.+)$/i.exec(authorization)?.[1]?.trim();
	if (!basic) return null;
	let decoded: string;
	try {
		decoded = atob(basic);
	} catch {
		return null;
	}
	const separator = decoded.indexOf(':');
	return separator < 0 ? null : decoded.slice(separator + 1) || null;
}

/** Who the token acts for on a resource that names no namespace. */
export type AccountAccess = {
	accountId: string;
	email: string;
	clientId: string;
};

type AccessRow = {
	account_id: string;
	client_id: string;
	has_audience: boolean;
	has_scope: boolean;
	in_target: boolean;
	role: NamespaceRole | null;
};

/**
 * Decide one request. Returns the account and its role in `namespaceId`, or
 * the refusal to send:
 *
 * - 401 `invalid_token` for a missing, unknown, expired, or revoked token, a
 *   token whose approving browser session ended, or another audience's token;
 * - 403 `insufficient_scope` when the token lacks `scope`;
 * - 403 `forbidden` when the namespace is outside the grant's target or the
 *   account is not a member of it.
 */
export async function authorizeResourceRequest(
	db: Db,
	{
		token,
		audience,
		scope,
		namespaceId,
	}: {
		token: string | null;
		/** This resource's identifier, the token's required audience. */
		audience: string;
		scope: OAuthScope;
		namespaceId: string;
	},
): Promise<Result<ResourceAccess, ResourceRefusal>> {
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
	// Compare against the client's clock the way Better Auth writes these
	// columns: a JS Date into a timestamp without time zone.
	const now = new Date();
	const { rows } = await db.execute<AccessRow>(sql`
		select t.user_id as account_id,
		       t.client_id,
		       ${audience} = any(t.resources) as has_audience,
		       ${scope} = any(t.scopes) as has_scope,
		       coalesce(t.reference_id in ('*', 'ns:' || ${namespaceId}), false) as in_target,
		       m.role
		from oauth_access_token t
		left join namespace_member m
		       on m.account_id = t.user_id and m.namespace_id = ${namespaceId}
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
	if (!row.in_target || !row.role)
		return Err({
			status: 403,
			challenge: `Bearer ${metadata}`,
			body: {
				error: 'forbidden',
				error_description: row.in_target
					? 'This account is not a member of that namespace.'
					: "That namespace is outside this grant's folders.",
			},
		});
	return Ok({
		accountId: row.account_id,
		role: row.role,
		clientId: row.client_id,
	});
}

type AccountRow = {
	account_id: string;
	client_id: string;
	email: string;
	has_audience: boolean;
	has_scope: boolean;
};

/**
 * Decide one request to a resource that acts on the person's account rather
 * than a namespace: inference, transcription, and the profile read. The same
 * statement as {@link authorizeResourceRequest} without the grant target or
 * membership, since none of these reach a folder:
 *
 * - 401 `invalid_token` for a missing, unknown, expired, or revoked token, a
 *   token whose approving browser session ended, or another audience's token;
 * - 403 `insufficient_scope` when the token lacks `scope`.
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
	const now = new Date();
	const { rows } = await db.execute<AccountRow>(sql`
		select t.user_id as account_id,
		       t.client_id,
		       u.email,
		       ${audience} = any(t.resources) as has_audience,
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
	});
}
