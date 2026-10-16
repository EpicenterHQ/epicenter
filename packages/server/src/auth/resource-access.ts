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
	/**
	 * The namespace the role is in: the requested one, or, when the request
	 * names a repository that has moved, the namespace it lives in now.
	 */
	namespaceId: string;
	/**
	 * The repository the requested name resolves to, by its name or by an
	 * alias a move or rename left (ADR-0546); null when the request named
	 * none, or no repository has that name.
	 */
	repository: { id: string; name: string } | null;
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
	/**
	 * The grant's target: `*`, `ns:<id>` for one namespace (ADR-0549), or
	 * null for a grant that reaches no namespace.
	 */
	target: string | null;
};

type AccessRow = {
	account_id: string;
	client_id: string;
	has_audience: boolean;
	has_scope: boolean;
	in_target: boolean;
	role: NamespaceRole | null;
	namespace_id: string;
	repository_id: string | null;
	repository_name: string | null;
};

/**
 * Decide one request. Returns the account and its role in `namespaceId`, or
 * the refusal to send. When the request names a `repository`, the same
 * statement resolves `<namespaceId>/<repository>` through `repository`, then
 * `repository_alias`; a repository that has moved is checked against the
 * namespace it lives in now, never the one in the old URL.
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
		repository,
	}: {
		token: string | null;
		/** This resource's identifier, the token's required audience. */
		audience: string;
		scope: OAuthScope;
		namespaceId: string;
		/** A repository name in `namespaceId` to resolve in the same statement. */
		repository?: string;
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
	const name = repository ?? null;
	const { rows } = await db.execute<AccessRow>(sql`
		with named as (
			select r.id, r.namespace_id, r.name, 0 as via_alias
			from repository r
			where r.namespace_id = ${namespaceId} and r.name = ${name}
			union all
			select r.id, r.namespace_id, r.name, 1 as via_alias
			from repository_alias a
			join repository r on r.id = a.repository_id
			where a.namespace_id = ${namespaceId} and a.name = ${name}
			order by via_alias
			limit 1
		)
		select t.user_id as account_id,
		       t.client_id,
		       ${audience} = any(t.resources) as has_audience,
		       ${scope} = any(t.scopes) as has_scope,
		       coalesce(t.reference_id in ('*', 'ns:' || coalesce(n.namespace_id, ${namespaceId})), false) as in_target,
		       m.role,
		       coalesce(n.namespace_id, ${namespaceId}) as namespace_id,
		       n.id as repository_id,
		       n.name as repository_name
		from oauth_access_token t
		left join named n on true
		left join namespace_member m
		       on m.account_id = t.user_id
		      and m.namespace_id = coalesce(n.namespace_id, ${namespaceId})
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
		namespaceId: row.namespace_id,
		repository:
			row.repository_id !== null && row.repository_name !== null
				? { id: row.repository_id, name: row.repository_name }
				: null,
	});
}

type AccountRow = {
	account_id: string;
	client_id: string;
	email: string;
	target: string | null;
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
		/**
		 * This resource's identifier, the token's required audience, or the
		 * identifiers of which the token needs one; the first names the
		 * resource's metadata.
		 */
		audience: string | readonly [string, ...string[]];
		scope: OAuthScope;
	},
): Promise<Result<AccountAccess, ResourceRefusal>> {
	const audiences = typeof audience === 'string' ? [audience] : audience;
	const metadata = `resource_metadata="${protectedResourceMetadataUrl(audiences[0])}"`;
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
		       t.reference_id as target,
		       t.resources && array[${sql.join(
							audiences.map((one) => sql`${one}`),
							sql`, `,
						)}]::text[] as has_audience,
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
		target: row.target,
	});
}
