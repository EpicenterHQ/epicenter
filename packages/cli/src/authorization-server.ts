/**
 * The authorization server for an Epicenter's public address (ADR-0871).
 *
 * Better Auth signs people in with passkeys and connectors in with OAuth.
 * Its state is `access.local.sqlite` and its secret is `access.local.key`,
 * both beside `EPICENTER.md` and `.local`, so nothing commits them
 * (ADR-0870). `serve` and `epicenter access` open the same file at once:
 * WAL lets one write while the other reads, and the busy timeout makes a
 * writer wait for the other instead of failing.
 *
 * A person exists once a passkey is registered from an invite, and the
 * passkey is the account: each invite makes one person, with a placeholder
 * email Better Auth requires. A grant is one connector (a CIMD client) as
 * one person approved it: their consent, and the refresh families its code
 * exchanges started.
 *
 * A grant has generations, and only the current one works. Better Auth's
 * refresh grant never reads consent and its access tokens are JWTs, so
 * deleting rows alone leaves races: a code exchange or a rotation that read
 * its row before a revoke writes a new family after it. SQL triggers on
 * Better Auth's own tables close them in the database, whichever process
 * writes:
 *
 * ```txt
 * codeIssued          each authorization code, when SQLite's clock issued it
 * grantRevocation     each revoke of a (client, person), when SQLite's clock ended it
 * verification        a code inserts only under a live consent
 * oauthRefreshToken   a row inserts only under a consent, from a code issued after the last revoke
 * oauthConsent        approving narrower scopes deletes the families that hold more
 * ```
 *
 * Every MCP call then checks its access token against the same tables
 * (`isGrantLive`), so a revoke ends a token at once rather than when it
 * expires.
 */
import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { passkey } from '@better-auth/passkey';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { APIError, getSessionFromCtx } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { fetchClientMetadataResource } from './cimd-fetch.ts';
import { writeErr } from './output.ts';

export const ACCESS_DATABASE = 'access.local.sqlite';
export const ACCESS_KEY = 'access.local.key';

/** Where `serve` sends a browser to sign in, and to approve a connector. */
export const SIGN_IN_PATH = '/.sign-in';
export const ALLOW_PATH = '/.allow';
/** Better Auth's routes live under this path on the public address. */
export const AUTH_BASE_PATH = '/.auth';

/** The scopes a connector can hold: `read` runs read-only actions, `write` every action. */
export const SCOPES = ['read', 'write', 'offline_access'] as const;

/** How long an access token lasts; a revoked connector keeps one at most this long. */
const ACCESS_TOKEN_SECONDS = 15 * 60;
/** How long a person's session lasts; it is not extended by use. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;
/** How long an invite link works. */
export const INVITE_SECONDS = 15 * 60;

/** A verification row that holds an invite: the token's digest, never the token. */
const inviteIdentifier = (token: string) =>
	`epicenter-invite:${createHash('sha256').update(token).digest('base64url')}`;

/** The public address as Better Auth and MCP name it. */
export function publicNames(url: string) {
	const origin = new URL(url).origin;
	return {
		/** `https://host:port`, the origin every page and cookie belongs to. */
		origin,
		/** The MCP resource: the origin with its `/`, matched exactly by Better Auth. */
		resource: `${origin}/`,
		/** The token issuer, Better Auth's base URL. */
		issuer: `${origin}${AUTH_BASE_PATH}`,
	};
}

/** What the refresh-family trigger raises; the token endpoint answers it as `invalid_grant`. */
const REVOKED_GRANT = 'epicenter: this grant was revoked';

/** SQLite's clock in milliseconds, so a code and a revoke compare on one clock. */
const NOW_MS = `cast(unixepoch('subsec') * 1000 as integer)`;

/**
 * A field of a `verification` row's JSON value, or null. Better Auth's DPoP
 * replay store writes values there that are not JSON, and `json_extract` on
 * one raises an error that would abort that insert, or a revoke; SQLite does
 * not promise that `and` stops early, so every extraction carries the guard.
 */
const codeField = (row: 'new' | 'verification', path: string) =>
	`(case when json_valid(${row}.value) then json_extract(${row}.value, '${path}') end)`;

/** An authorization code row in `verification`. */
const IS_CODE = (row: 'new' | 'verification') =>
	`${codeField(row, '$.type')} = 'authorization_code'`;

/**
 * The generation tables and triggers, installed after Better Auth's migrations
 * on every start in one transaction. Tables are created once; triggers are
 * dropped and created again, so a change to their SQL reaches a database that
 * already has them. Neither table is pruned: a family's `codeIssued` row is
 * needed for as long as the family rotates.
 */
const GENERATIONS = `
begin immediate;
drop trigger if exists epicenterCodeNeedsConsent;
drop trigger if exists epicenterCodeIssued;
drop trigger if exists epicenterRefreshCurrentGeneration;
drop trigger if exists epicenterNarrowedConsent;
create table if not exists grantRevocation (
	clientId text not null,
	userId text not null,
	revokedAt integer not null
);
create index if not exists grantRevocationByGrant on grantRevocation (clientId, userId, revokedAt);
create table if not exists codeIssued (
	identifier text primary key,
	clientId text,
	userId text,
	issuedAt integer not null
);
create trigger epicenterCodeNeedsConsent
before insert on verification
when ${IS_CODE('new')}
	and not exists (
		select 1 from oauthConsent k
		 where k.clientId = ${codeField('new', '$.query.client_id')}
		   and k.userId = ${codeField('new', '$.userId')})
begin
	select raise(abort, 'epicenter: no consent for this authorization code');
end;
create trigger epicenterCodeIssued
after insert on verification
when ${IS_CODE('new')}
begin
	insert or ignore into codeIssued (identifier, clientId, userId, issuedAt)
	values (
		new.identifier,
		${codeField('new', '$.query.client_id')},
		${codeField('new', '$.userId')},
		${NOW_MS});
end;
create trigger epicenterRefreshCurrentGeneration
before insert on oauthRefreshToken
when not exists (
		select 1 from oauthConsent k
		 where k.clientId = new.clientId and k.userId = new.userId)
	or not exists (
		select 1 from codeIssued c
		 where c.identifier = new.authorizationCodeId
		   and c.clientId = new.clientId
		   and c.userId = new.userId
		   and c.issuedAt > coalesce(
		       (select max(g.revokedAt) from grantRevocation g
		         where g.clientId = new.clientId and g.userId = new.userId), -1))
begin
	select raise(abort, '${REVOKED_GRANT}');
end;
create trigger epicenterNarrowedConsent
after update of scopes on oauthConsent
begin
	delete from oauthRefreshToken
	 where clientId = new.clientId and userId = new.userId
	   and exists (
	       select 1 from json_each(oauthRefreshToken.scopes) s
	        where s.value not in (select value from json_each(new.scopes)));
end;
commit;
`;

/** Read the secret, or create it once, readable only by this user. */
function readOrCreateSecret(path: string) {
	try {
		writeFileSync(path, `${randomBytes(32).toString('base64url')}\n`, {
			flag: 'wx',
			mode: 0o600,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	const secret = readFileSync(path, 'utf8').trim();
	if (secret.length < 32)
		throw new Error(`${path} must hold at least 32 characters`);
	return secret;
}

/** Open the database file, created readable only by this user, in WAL with a busy timeout. */
export function openAccessDatabase(folder: string) {
	const path = join(folder, ACCESS_DATABASE);
	closeSync(openSync(path, 'a', 0o600));
	const db = new Database(path);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
	return db;
}

/** Better Auth's configuration: the passkey, MCP, and CIMD plugins over this database. */
function authOptions(
	folder: string,
	url: string,
	db: Database,
	fetchMetadata: typeof fetchClientMetadataResource,
) {
	const { origin, resource } = publicNames(url);
	return {
		appName: 'Epicenter',
		baseURL: origin,
		basePath: AUTH_BASE_PATH,
		secret: readOrCreateSecret(join(folder, ACCESS_KEY)),
		database: db,
		telemetry: { enabled: false },
		// Better Auth warns at every start that SQLite stores arrays as text.
		logger: {
			level: 'error',
			log: (_level, message) => writeErr(`Sign-in: ${message}`),
		},
		// Better Auth still answers its own API errors; any other error an
		// endpoint throws leaves `auth.handler`, for `handle` to answer.
		onAPIError: { throw: true },
		rateLimit: { enabled: true, storage: 'memory' },
		session: { expiresIn: SESSION_SECONDS, disableSessionRefresh: true },
		advanced: {
			// Better Auth skips its Origin check when NODE_ENV is `test` or TEST is
			// set, and decides more from NODE_ENV; this sign-in decides each itself.
			disableOriginCheck: false,
			disableCSRFCheck: false,
			useSecureCookies: true,
			cookiePrefix: 'epicenter',
			// Every request comes through the tunnel from 127.0.0.1, so the client
			// the rate limit counts is the address the tunnel adds last to
			// X-Forwarded-For.
			ipAddress: {
				ipAddressHeaders: ['x-forwarded-for'],
				trustedProxies: ['127.0.0.1', '::1'],
			},
		},
		plugins: [
			jwt(),
			mcp({
				resource,
				loginPage: SIGN_IN_PATH,
				consentPage: ALLOW_PATH,
				scopes: [...SCOPES],
				accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
				grantTypes: ['authorization_code', 'refresh_token'],
			}),
			cimd({
				fetchClientMetadataResource: fetchMetadata,
				metadataProfile: 'mcp-2026-07-28',
			}),
			passkey({
				// A passkey belongs to this hostname; another one means a new invite.
				rpID: new URL(origin).hostname,
				rpName: 'Epicenter',
				origin,
				// Discoverable, so signing in needs no name; verified, so a found
				// device is not a signed-in one.
				authenticatorSelection: {
					residentKey: 'required',
					userVerification: 'required',
				},
				registration: {
					// The invite is the credential that registers a passkey. With a
					// session, Better Auth registers to that person instead, and
					// `afterVerification` refuses it, so every passkey is a new person.
					requireSession: false,
					resolveUser: async ({ ctx, context }) => {
						const invite = context
							? await ctx.context.internalAdapter.findVerificationValue(
									inviteIdentifier(context),
								)
							: null;
						if (!invite || invite.expiresAt < new Date())
							throw new APIError('UNAUTHORIZED', {
								message: 'This invite is used or expired',
							});
						const { name } = JSON.parse(invite.value) as { name: string };
						// The person is created when the passkey is verified.
						return { id: 'invited', name, displayName: name };
					},
					afterVerification: async ({ ctx, context }) => {
						if (await getSessionFromCtx(ctx))
							throw new APIError('FORBIDDEN', {
								message: 'This device is already signed in',
							});
						// One use: the first verification consumes the invite, and any
						// other registration begun from it fails here.
						const invite = context
							? await ctx.context.internalAdapter.consumeVerificationValue(
									inviteIdentifier(context),
								)
							: null;
						if (!invite)
							throw new APIError('UNAUTHORIZED', {
								message: 'This invite is used or expired',
							});
						const { name } = JSON.parse(invite.value) as { name: string };
						const person = await ctx.context.internalAdapter.createUser(
							{
								name,
								email: `${crypto.randomUUID()}@epicenter.invalid`,
								emailVerified: false,
							},
							{ method: 'epicenter-invite' },
						);
						return { userId: person.id, name };
					},
				},
			}),
		],
	} satisfies BetterAuthOptions;
}

export type AuthorizationServer = Awaited<
	ReturnType<typeof openAuthorizationServer>
>;

/**
 * Open the authorization server for the Epicenter at `folder` whose public
 * address is `url`, creating its tables and its signing key on first use.
 * Better Auth's own environment variables are cleared first: the sign-in is
 * configured only by `EPICENTER.md` and these files.
 */
export async function openAuthorizationServer(
	folder: string,
	url: string,
	fetchMetadata = fetchClientMetadataResource,
) {
	for (const name of Object.keys(process.env))
		if (name.startsWith('BETTER_AUTH_') || name === 'AUTH_SECRET')
			delete process.env[name];
	const db = openAccessDatabase(folder);
	const options = authOptions(folder, url, db, fetchMetadata);
	// Tables first: Better Auth checks the schema as soon as it is created.
	await (await getMigrations(options)).runMigrations();
	// The generation triggers name Better Auth's tables, so they come after.
	db.exec(GENERATIONS);
	const auth = betterAuth(options);
	// Better Auth finishes starting in the background; wait, so a caller that
	// closes the database at once does not cut that work off.
	const context = await auth.$context;
	await (context as { checkSchema?: () => Promise<unknown> }).checkSchema?.();
	const liveGrants = db.query<
		{ scopes: string; hasPasskey: number; revokedAt: number | null },
		[string, string]
	>(
		`select k.scopes,
		        exists (select 1 from passkey p where p.userId = k.userId) as hasPasskey,
		        (select max(g.revokedAt) from grantRevocation g
		          where g.clientId = k.clientId and g.userId = k.userId) as revokedAt
		   from oauthConsent k
		  where k.clientId = ?1 and k.userId = ?2`,
	);
	return {
		/** The Epicenter's folder; its name is what the sign-in pages call it. */
		folder,
		auth,
		db,
		...publicNames(url),
		/**
		 * The public signing keys, read from the database for each check. A copy
		 * kept in memory would miss a key another process created first.
		 */
		jwks: () => auth.api.getJwks(),
		/**
		 * Better Auth's handler. A refresh family the generation trigger refused
		 * returns no token either way; this answers it as RFC 6749's
		 * `invalid_grant`, which tells the connector to authorize again, where
		 * Better Auth would answer 500. Any other error is logged and is a 500.
		 */
		async handle(request: Request) {
			try {
				return await auth.handler(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes(REVOKED_GRANT))
					return Response.json(
						{
							error: 'invalid_grant',
							error_description: 'This connection was revoked',
						},
						{ status: 400, headers: { 'cache-control': 'no-store' } },
					);
				writeErr(`Sign-in: ${message}`);
				return new Response(null, { status: 500 });
			}
		},
		/**
		 * Whether a verified access token's grant is still the one that issued
		 * it: a consent for (`azp`, `sub`) covering its scopes, a passkey for
		 * `sub`, and issued in a later second than the grant's last revoke. A
		 * token issued in the revoke's own second is refused; the connector
		 * authorizes again and gets a later one.
		 */
		isGrantLive(claims: {
			azp?: unknown;
			sub?: unknown;
			scope?: unknown;
			iat?: unknown;
		}) {
			const { azp, sub, scope, iat } = claims;
			if (
				typeof azp !== 'string' ||
				typeof sub !== 'string' ||
				typeof iat !== 'number'
			)
				return false;
			const scopes =
				typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
			return liveGrants.all(azp, sub).some((grant) => {
				const consented = new Set(parseScopes(grant.scopes));
				return (
					grant.hasPasskey === 1 &&
					scopes.every((each) => consented.has(each)) &&
					(grant.revokedAt === null || iat > Math.floor(grant.revokedAt / 1000))
				);
			});
		},
		/** A one-time link that registers a passkey as a new person named `name`. */
		async invite(name: string) {
			const token = randomBytes(32).toString('base64url');
			const expiresAt = new Date(Date.now() + INVITE_SECONDS * 1000);
			await (await auth.$context).internalAdapter.createVerificationValue({
				identifier: inviteIdentifier(token),
				value: JSON.stringify({ name }),
				expiresAt,
			});
			const link = new URL(SIGN_IN_PATH, publicNames(url).origin);
			link.searchParams.set('invite', token);
			return { url: link.href, expiresAt };
		},
		close: () => db.close(),
	};
}

/** C0 and C1 controls, which a terminal reads as escapes, and bidirectional controls, which reorder text. */
const CONTROLS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point.
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

/** Text a connector's metadata document supplied, safe to print or render. */
export const cleanText = (text: string) => text.replace(CONTROLS, '');

/** A person: the passkey an invite registered, and the name it was given. */
export type Person = {
	kind: 'person';
	/** Better Auth's user id. */
	id: string;
	name: string;
	approved: string;
	lastUsed?: string;
};

/**
 * A grant: one connector as one person approved it. Each code exchange
 * starts a refresh family, so `families` above one means the connector holds
 * more than one connection under this approval.
 */
export type Grant = {
	kind: 'grant';
	/** The connector's client_id, the URL of its metadata document. */
	clientId: string;
	/** The host serving that document: who the connector is. */
	host: string;
	/** What the document calls the connector, cleaned; any connector can claim any name. */
	name: string;
	userId: string;
	person: string;
	scope: string;
	/** When the person last approved it. */
	approved: string;
	lastRefresh?: string;
	families: number;
};

/** What `revokeAccess` ends: a person, one grant, or every grant of a connector. */
export type AccessTarget =
	| Pick<Person, 'kind' | 'id'>
	| Pick<Grant, 'kind' | 'clientId' | 'userId'>
	| { kind: 'connector'; clientId: string };

const hostOf = (clientId: string) => {
	try {
		return new URL(clientId).host;
	} catch {
		return clientId;
	}
};

const parseScopes = (text: string | null) => {
	try {
		const value: unknown = JSON.parse(text ?? '[]');
		return Array.isArray(value) ? value.map(String) : [];
	} catch {
		return text ? text.split(' ') : [];
	}
};

/** Everyone who can sign in, and every grant a person made. */
export function listAccess(db: Database): (Person | Grant)[] {
	const people = db
		.query<
			{ id: string; name: string; approved: string; lastUsed: string | null },
			[]
		>(
			`select u.id, u.name,
			        coalesce((select min(p.createdAt) from passkey p where p.userId = u.id), u.createdAt) as approved,
			        (select max(s.createdAt) from session s where s.userId = u.id) as lastUsed
			   from user u
			  order by approved`,
		)
		.all()
		.map(
			({ lastUsed, ...person }): Person => ({
				kind: 'person',
				...person,
				...(lastUsed ? { lastUsed } : {}),
			}),
		);
	const grants = db
		.query<
			{
				clientId: string;
				name: string | null;
				userId: string;
				person: string | null;
				scopes: string | null;
				approved: string;
				lastRefresh: string | null;
				families: number;
			},
			[string]
		>(
			`select k.clientId, c.name, k.userId, u.name as person, k.scopes,
			        k.updatedAt as approved,
			        (select max(r.createdAt) from oauthRefreshToken r
			          where r.clientId = k.clientId and r.userId = k.userId) as lastRefresh,
			        (select count(distinct r.authorizationCodeId) from oauthRefreshToken r
			          where r.clientId = k.clientId and r.userId = k.userId
			            and r.revoked is null and r.expiresAt > ?1) as families
			   from oauthConsent k
			   left join oauthClient c on c.clientId = k.clientId
			   left join user u on u.id = k.userId
			  where k.userId is not null
			  order by k.createdAt`,
		)
		.all(new Date().toISOString())
		.map(({ clientId, name, person, scopes, lastRefresh, ...grant }): Grant => {
			const held = new Set(parseScopes(scopes));
			const host = cleanText(hostOf(clientId));
			return {
				kind: 'grant',
				clientId: cleanText(clientId),
				host,
				name: cleanText(name ?? '') || host,
				person: person ?? grant.userId,
				scope: SCOPES.filter((known) => held.has(known)).join(' '),
				...grant,
				...(lastRefresh ? { lastRefresh } : {}),
			};
		});
	return [...people, ...grants];
}

/**
 * End `target`'s access in one transaction. Each grant it ends gets a
 * `grantRevocation` row, so no code or refresh family from before it works
 * again and an access token issued before it fails its next call. Its
 * consent, refresh tokens, access-token rows, and pending codes are deleted
 * as cleanup; correctness rests on the revocation row, so a row missed here
 * fails closed. A person also loses their passkeys, sessions, any pending
 * code, and their user row.
 */
export function revokeAccess(db: Database, target: AccessTarget) {
	const grantsOf = (sql: string, id: string) =>
		db.query<{ clientId: string; userId: string }, [string]>(sql).all(id);
	db.transaction(() => {
		const grants =
			target.kind === 'grant'
				? [{ clientId: target.clientId, userId: target.userId }]
				: target.kind === 'connector'
					? grantsOf(
							`select clientId, userId from oauthConsent where clientId = ?1 and userId is not null
							  union select clientId, userId from oauthRefreshToken where clientId = ?1`,
							target.clientId,
						)
					: grantsOf(
							`select clientId, userId from oauthConsent where userId = ?1
							  union select clientId, userId from oauthRefreshToken where userId = ?1`,
							target.id,
						);
		for (const { clientId, userId } of grants) {
			db.query(
				`insert into grantRevocation (clientId, userId, revokedAt) values (?, ?, ${NOW_MS})`,
			).run(clientId, userId);
			for (const table of [
				'oauthConsent',
				'oauthRefreshToken',
				'oauthAccessToken',
			])
				db.query(`delete from ${table} where clientId = ? and userId = ?`).run(
					clientId,
					userId,
				);
			db.query(
				`delete from verification
				  where ${IS_CODE('verification')}
				    and ${codeField('verification', '$.query.client_id')} = ?
				    and ${codeField('verification', '$.userId')} = ?`,
			).run(clientId, userId);
		}
		if (target.kind !== 'person') return;
		db.query(
			`delete from verification
			  where ${IS_CODE('verification')}
			    and ${codeField('verification', '$.userId')} = ?`,
		).run(target.id);
		for (const table of ['session', 'passkey'])
			db.query(`delete from ${table} where userId = ?`).run(target.id);
		db.query('delete from user where id = ?').run(target.id);
	})();
}
