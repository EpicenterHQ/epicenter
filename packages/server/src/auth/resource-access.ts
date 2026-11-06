/**
 * The one check every resource runs on an access token (ADR-0549): one SQL
 * statement over the token's SHA-256 hash that decides revocation, expiry,
 * audience, scope, and, for a grant tied to a browser session, that
 * session's life, and for a folder, the account's membership and the
 * token's reach (ADR-0811): an app's token reaches the folders attached to
 * it, and a token with `folders:all` every folder its person holds. Nothing
 * is cached, so a revocation, a removed member, or a detached app takes
 * effect on the very next request.
 */
import type { FolderRole } from '@epicenter/definition/site';
import { sql } from 'drizzle-orm';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Db } from '../db/create-db.js';
import {
	hashPrefixedToken,
	type OAuthScope,
	TOKEN_PREFIX,
} from './oauth-policy.js';

/** Who the token acts for on one folder. */
export type FolderAccess = {
	accountId: string;
	/** The account's role in the folder, which it has accepted. */
	role: FolderRole;
	/** The OAuth client the token was issued to. */
	clientId: string;
	folder: string;
	/** Null for a token with `folders:all`, else the app whose attached folders it reaches: its client id. */
	app: string | null;
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

/** Who the token acts for on a resource that names no folder. */
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

type FolderRow = {
	account_id: string;
	client_id: string;
	has_audience: boolean;
	has_scope: boolean;
	every_folder: boolean;
	role: FolderRole | null;
	attached: boolean;
};

/**
 * Decide one request on the folder `folder`. Returns the account and its
 * role there, or the refusal to send:
 *
 * - 401 `invalid_token` for a missing, unknown, expired, or revoked token, a
 *   token whose approving browser session ended, or a token whose audience is
 *   not exactly this resource;
 * - 403 `insufficient_scope` when the token lacks `scope`;
 * - 403 `forbidden` when the account does not hold the folder (a folder that
 *   does not exist is refused the same way, so a refusal says nothing of
 *   whether it does), or the folder is not attached to the token's app and
 *   the token lacks `folders:all`.
 *
 * A token naming several audiences is refused at each. Every scope rides on
 * every token (`oauthResourceInputs`), so the audience alone keeps a Git
 * token out of inference, and the library issues a token for every bound
 * audience when a token request omits `resource`. Refusing those makes one
 * audience per token a server invariant rather than each client's discipline.
 */
export async function authorizeFolderRequest(
	db: Db,
	{
		token,
		audience,
		scope,
		folder,
	}: {
		token: string | null;
		/** This resource's identifier, the token's required audience. */
		audience: string;
		scope: OAuthScope;
		folder: string;
	},
): Promise<Result<FolderAccess, ResourceRefusal>> {
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
	const { rows } = await db.execute<FolderRow>(sql`
		select t.user_id as account_id,
		       t.client_id,
		       t.resources = array[${audience}]::text[] as has_audience,
		       ${scope} = any(t.scopes) as has_scope,
		       'folders:all' = any(t.scopes) as every_folder,
		       m.role,
		       exists (
		         select 1 from folder_app a
		         where a.folder_id = ${folder} and a.app = t.client_id
		       ) as attached
		from oauth_access_token t
		left join folder_member m
		       on m.folder_id = ${folder}
		      and m.account_id = t.user_id
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
	if (!row.role || !(row.every_folder || row.attached))
		return Err({
			status: 403,
			challenge: `Bearer ${metadata}`,
			body: {
				error: 'forbidden',
				error_description: row.role
					? 'That folder is not attached to this app.'
					: 'This account does not hold that folder.',
			},
		});
	return Ok({
		accountId: row.account_id,
		role: row.role,
		clientId: row.client_id,
		folder,
		app: row.every_folder ? null : row.client_id,
	});
}

type AccountRow = {
	account_id: string;
	client_id: string;
	email: string;
	every_folder: boolean;
	has_audience: boolean;
	has_scope: boolean;
};

/**
 * Decide one request to a resource that acts on the person's account rather
 * than one folder: inference, transcription, and the folder listing, which
 * applies the token's reach itself. The same statement as
 * {@link authorizeFolderRequest} without the folder check:
 *
 * - 401 `invalid_token` for a missing, unknown, expired, or revoked token, a
 *   token whose approving browser session ended, or a token whose audience is
 *   not exactly this resource (see {@link authorizeFolderRequest});
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
