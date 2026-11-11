/**
 * The authorization server for an Epicenter's connectors (ADR-0871, ADR-0881).
 *
 * Better Auth signs connectors in with OAuth. Its state is
 * `connectors.local.sqlite` and its secret is `connectors.local.key`, both beside
 * `EPICENTER.md` and `.local`, so nothing commits them (ADR-0870). `serve`
 * and `epicenter connectors` open the same file at once: WAL lets one write while
 * the other reads, and the busy timeout makes a writer wait for the other
 * instead of failing.
 *
 * There is one person, the owner, a `user` row this creates once. People
 * reach the Epicenter over the tailnet, so no one signs in: a connector's
 * authorization goes to the approval page on the tailnet listener, and
 * `approve` grants it as the owner through Better Auth's consent endpoint,
 * with a session made for that approval. A grant is one connector (a CIMD
 * client) the owner approved: their consent, and the refresh families its
 * code exchanges started.
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
 * grantRevocation     each revoke of a (client, user), when SQLite's clock ended it
 * verification        a code inserts only under a live consent
 * oauthRefreshToken   a row inserts only under a consent that covers its scopes, from a code issued after the last revoke
 * oauthConsent        approving narrower scopes deletes the families that hold more
 * ```
 *
 * Every MCP call then checks its access token against the same tables
 * (`isGrantLive`), so a revoke ends a token at once rather than when it
 * expires.
 */
import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cimd } from '@better-auth/cimd';
import { mcp } from '@better-auth/mcp';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { bearer, jwt } from 'better-auth/plugins';
import { fetchClientMetadataResource } from './cimd-fetch.ts';
import { writeErr } from './output.ts';
import type { Connectors } from './root.ts';

export const CONNECTORS_DATABASE = 'connectors.local.sqlite';
export const CONNECTORS_KEY = 'connectors.local.key';

/** The approval page's path on the tailnet listener. */
export const ALLOW_PATH = '/.allow';

/** The scopes a connector can hold: `read` runs read-only actions, `write` every action. */
export const SCOPES = ['read', 'write', 'offline_access'] as const;

/** How long an access token lasts; a revoked connector keeps one at most this long. */
const ACCESS_TOKEN_SECONDS = 15 * 60;
/**
 * How long an authorization code lasts, Better Auth's default, and so the
 * session an approval makes: the code's exchange needs it, and refresh does not.
 */
const CODE_SECONDS = 10 * 60;

/** The owner's placeholder email; Better Auth requires one on a user. */
const OWNER_EMAIL = 'owner@epicenter.invalid';

/** The public address as Better Auth and MCP name it. */
function publicNames(url: string) {
	const origin = new URL(url).origin;
	return {
		/** `https://host:port`, the public origin. */
		origin,
		/** The MCP resource: the origin with its `/`, matched exactly by Better Auth. */
		resource: `${origin}/`,
		/** The token issuer, Better Auth's base URL: the origin, with no path. */
		issuer: origin,
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
	or exists (
		select 1 from json_each(new.scopes) s
		 where s.value not in (
		       select value from json_each(
		              (select k.scopes from oauthConsent k
		                where k.clientId = new.clientId and k.userId = new.userId))))
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
function openAccessDatabase(folder: string) {
	const path = join(folder, CONNECTORS_DATABASE);
	closeSync(openSync(path, 'a', 0o600));
	const db = new Database(path);
	db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
	return db;
}

/** Better Auth's configuration: the MCP, CIMD, and bearer plugins over this database. */
function authOptions(
	folder: string,
	connectors: Connectors,
	db: Database,
	fetchMetadata: typeof fetchClientMetadataResource,
) {
	const { origin, resource } = publicNames(connectors.url);
	const allow = `${new URL(connectors.tailnet).origin}${ALLOW_PATH}`;
	return {
		appName: 'Epicenter',
		baseURL: origin,
		basePath: '/',
		secret: readOrCreateSecret(join(folder, CONNECTORS_KEY)),
		database: db,
		telemetry: { enabled: false },
		// Better Auth warns at every start that SQLite stores arrays as text.
		logger: {
			level: 'error',
			log: (_level, message) => writeErr(`Connectors: ${message}`),
		},
		// Better Auth still answers its own API errors; any other error an
		// endpoint throws leaves `auth.handler`, for `handle` to answer.
		onAPIError: { throw: true },
		rateLimit: { enabled: true, storage: 'memory' },
		// Every session is one `approve` made, and its code's exchange needs it.
		session: { expiresIn: CODE_SECONDS, disableSessionRefresh: true },
		advanced: {
			// Better Auth skips its Origin check when NODE_ENV is `test` or TEST is
			// set, and decides more from NODE_ENV; this server decides each itself.
			disableOriginCheck: false,
			disableCSRFCheck: false,
			// Every request comes through the tunnel from 127.0.0.1, so the client
			// the rate limit counts is the address the tunnel adds last to
			// X-Forwarded-For.
			ipAddress: {
				ipAddressHeaders: ['x-forwarded-for'],
				trustedProxies: ['127.0.0.1', '::1'],
			},
		},
		plugins: [
			// How `approve` presents the session it made for an approval, which
			// never reaches a browser. First, so its hook turns the header into
			// a session before any other plugin's hook looks for one.
			bearer(),
			jwt(),
			mcp({
				resource,
				// No one signs in: with no session, an authorization goes straight
				// to the approval page on the tailnet listener.
				loginPage: allow,
				consentPage: allow,
				scopes: [...SCOPES],
				accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
				codeExpiresIn: CODE_SECONDS,
				grantTypes: ['authorization_code', 'refresh_token'],
			}),
			cimd({
				fetchClientMetadataResource: fetchMetadata,
				metadataProfile: 'mcp-2026-07-28',
			}),
		],
	} satisfies BetterAuthOptions;
}

export type AuthorizationServer = Awaited<
	ReturnType<typeof openAuthorizationServer>
>;

/** Why an approval did not happen, from Better Auth's own answer. */
export class ApprovalError extends Error {}

/**
 * Open the authorization server for the Epicenter at `folder` with these
 * `connectors`, creating its tables, its signing key, and its owner on first
 * use. Better Auth's own environment variables are cleared first: the server
 * is configured only by `EPICENTER.md` and these files.
 */
export async function openAuthorizationServer(
	folder: string,
	connectors: Connectors,
	fetchMetadata = fetchClientMetadataResource,
) {
	for (const name of Object.keys(process.env))
		if (name.startsWith('BETTER_AUTH_') || name === 'AUTH_SECRET')
			delete process.env[name];
	const db = openAccessDatabase(folder);
	const options = authOptions(folder, connectors, db, fetchMetadata);
	// Tables first: Better Auth checks the schema as soon as it is created.
	await (await getMigrations(options)).runMigrations();
	// The generation triggers name Better Auth's tables, so they come after.
	db.exec(GENERATIONS);
	const auth = betterAuth(options);
	// Better Auth finishes starting in the background; wait, so a caller that
	// closes the database at once does not cut that work off.
	const context = await auth.$context;
	await (context as { checkSchema?: () => Promise<unknown> }).checkSchema?.();
	const owner =
		(await context.internalAdapter.findUserByEmail(OWNER_EMAIL))?.user ??
		(await context.internalAdapter.createUser(
			{ name: 'owner', email: OWNER_EMAIL, emailVerified: false },
			{ method: 'epicenter-owner' },
		));
	const liveGrants = db.query<
		{ scopes: string; revokedAt: number | null },
		[string, string]
	>(
		`select k.scopes,
		        (select max(g.revokedAt) from grantRevocation g
		          where g.clientId = k.clientId and g.userId = k.userId) as revokedAt
		   from oauthConsent k
		  where k.clientId = ?1 and k.userId = ?2`,
	);
	/**
	 * Answer the authorization whose signed query is `oauth_query` as the
	 * owner, through Better Auth's consent endpoint, which checks the
	 * signature and that `scope` narrows what was asked. The session it needs
	 * lasts as long as the code, whose exchange needs it (`session.expiresIn`);
	 * expired ones go first.
	 */
	const consent = async (body: {
		accept: boolean;
		scope?: string;
		oauth_query: string;
	}) => {
		await context.adapter.deleteMany({
			model: 'session',
			where: [{ field: 'expiresAt', operator: 'lt', value: new Date() }],
		});
		const session = await context.internalAdapter.createSession(owner.id);
		let answer: { url?: unknown };
		try {
			answer = (await auth.api.oauth2Consent({
				body,
				headers: new Headers({ authorization: `Bearer ${session.token}` }),
			})) as { url?: unknown };
		} catch (error) {
			const said = (
				error as { body?: { error_description?: unknown; message?: unknown } }
			).body;
			const why = said?.error_description || said?.message;
			throw new ApprovalError(
				typeof why === 'string'
					? why
					: 'This request expired or was changed. Start connecting again.',
			);
		}
		if (typeof answer.url !== 'string')
			throw new ApprovalError('Better Auth answered with no address');
		return answer.url;
	};
	return {
		/** The Epicenter's folder; its name is what the approval page calls it. */
		folder,
		auth,
		db,
		...publicNames(connectors.url),
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
				writeErr(`Connectors: ${message}`);
				return new Response(null, { status: 500 });
			}
		},
		/**
		 * Grant the authorization whose signed query is `oauthQuery` with
		 * `scope`, which must keep `offline_access` so its code exchange starts
		 * a refresh family the generation trigger checks. Answers the
		 * connector's callback with its code; throws `ApprovalError`.
		 */
		approve(oauthQuery: string, scope: string) {
			if (!scope.split(' ').includes('offline_access'))
				throw new ApprovalError('An approval must include offline_access');
			return consent({ accept: true, scope, oauth_query: oauthQuery });
		},
		/** Refuse the authorization: the connector's callback with `access_denied`. */
		deny(oauthQuery: string) {
			return consent({ accept: false, oauth_query: oauthQuery });
		},
		/**
		 * Whether a verified access token's grant is still the one that issued
		 * it: the owner's, under a consent for (`azp`, `sub`) covering its
		 * scopes, and issued in a later second than the grant's last revoke. A
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
				sub !== owner.id ||
				typeof iat !== 'number'
			)
				return false;
			const scopes =
				typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
			return liveGrants.all(azp, owner.id).some((grant) => {
				const consented = new Set(parseScopes(grant.scopes));
				return (
					scopes.every((each) => consented.has(each)) &&
					(grant.revokedAt === null || iat > Math.floor(grant.revokedAt / 1000))
				);
			});
		},
		close: () => db.close(),
	};
}

/** C0 and C1 controls, which a terminal reads as escapes, and bidirectional controls, which reorder text. */
const CONTROLS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point.
	/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

/** Text a connector's metadata document supplied, safe to print or render. */
export const cleanText = (text: string) => text.replace(CONTROLS, '');

/**
 * A grant: one connector the owner approved. Each code exchange starts a
 * refresh family, so `families` above one means the connector holds more
 * than one connection under this approval.
 */
export type Grant = {
	/** The connector's client_id, the URL of its metadata document. */
	clientId: string;
	/** The host serving that document: who the connector is. */
	host: string;
	/** What the document calls the connector, cleaned; any connector can claim any name. */
	name: string;
	scope: string;
	/** When it was last approved. */
	approved: string;
	lastRefresh?: string;
	families: number;
};

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

/**
 * Every grant of the owner's, oldest first. A grant a person made before
 * ADR-0881 is not the owner's, never works again, and is not listed;
 * revoking its connector still deletes it.
 */
export function listGrants(db: Database): Grant[] {
	return db
		.query<
			{
				clientId: string;
				name: string | null;
				scopes: string | null;
				approved: string;
				lastRefresh: string | null;
				families: number;
			},
			[string, string]
		>(
			`select k.clientId, c.name, k.scopes, k.updatedAt as approved,
			        (select max(r.createdAt) from oauthRefreshToken r
			          where r.clientId = k.clientId and r.userId = k.userId) as lastRefresh,
			        (select count(distinct r.authorizationCodeId) from oauthRefreshToken r
			          where r.clientId = k.clientId and r.userId = k.userId
			            and r.revoked is null and r.expiresAt > ?1) as families
			   from oauthConsent k
			   join "user" u on u.id = k.userId and u.email = ?2
			   left join oauthClient c on c.clientId = k.clientId
			  order by k.createdAt`,
		)
		.all(new Date().toISOString(), OWNER_EMAIL)
		.map(({ clientId, name, scopes, lastRefresh, ...grant }): Grant => {
			const held = new Set(parseScopes(scopes));
			const host = cleanText(hostOf(clientId));
			return {
				clientId: cleanText(clientId),
				host,
				name: cleanText(name ?? '') || host,
				scope: SCOPES.filter((known) => held.has(known)).join(' '),
				...grant,
				...(lastRefresh ? { lastRefresh } : {}),
			};
		});
}

/**
 * End every grant of the connector `clientId` in one transaction. Each gets a
 * `grantRevocation` row, so no code or refresh family from before it works
 * again and an access token issued before it fails its next call. Its
 * consent, refresh tokens, access-token rows, and pending codes are deleted
 * as cleanup; correctness rests on the revocation row, so a row missed here
 * fails closed.
 */
export function revokeConnector(db: Database, clientId: string) {
	db.transaction(() => {
		const holders = db
			.query<{ userId: string }, [string]>(
				`select userId from oauthConsent where clientId = ?1 and userId is not null
				  union select userId from oauthRefreshToken where clientId = ?1`,
			)
			.all(clientId);
		for (const { userId } of holders) {
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
	})();
}
