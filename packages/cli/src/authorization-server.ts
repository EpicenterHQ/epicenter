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
 * email Better Auth requires. A connector is a CIMD client that a person
 * approved; its consent and refresh tokens are what `revoke` deletes, since
 * the refresh grant never reads consent.
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
	const auth = betterAuth(options);
	// Better Auth finishes starting in the background; wait, so a caller that
	// closes the database at once does not cut that work off.
	const context = await auth.$context;
	await (context as { checkSchema?: () => Promise<unknown> }).checkSchema?.();
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

/** A person: one passkey, named when its invite was made. */
export type Person = {
	kind: 'person';
	id: string;
	name: string;
	approved: string;
	lastUsed?: string;
};

/** A connector a person approved: its CIMD name and host, and the scope it holds. */
export type Connector = {
	kind: 'connector';
	id: string;
	name: string;
	host: string;
	scope: string;
	approved: string;
	lastUsed?: string;
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

/** Everyone and everything that can reach the public address now. */
export function listAccess(db: Database): (Person | Connector)[] {
	const people = db
		.query<
			{ id: string; name: string; approved: string; lastUsed: string | null },
			[]
		>(
			`select p.id, coalesce(p.name, u.name) as name, p.createdAt as approved,
			        (select max(s.createdAt) from session s where s.userId = p.userId) as lastUsed
			   from passkey p join user u on u.id = p.userId
			  order by p.createdAt`,
		)
		.all()
		.map(
			({ lastUsed, ...person }): Person => ({
				kind: 'person',
				...person,
				...(lastUsed ? { lastUsed } : {}),
			}),
		);
	// Each person who approves a connector gives it a consent of its own; the
	// connector is one entry, approved at its first, holding every scope given.
	const connectors = new Map<string, Connector>();
	const consents = db
		.query<
			{
				clientId: string;
				name: string | null;
				scopes: string | null;
				approved: string;
				lastUsed: string | null;
			},
			[]
		>(
			`select c.clientId, c.name, k.scopes, k.createdAt as approved,
			        (select max(r.createdAt) from oauthRefreshToken r where r.clientId = c.clientId) as lastUsed
			   from oauthClient c join oauthConsent k on k.clientId = c.clientId
			  order by k.createdAt`,
		)
		.all();
	for (const { clientId, name, scopes, approved, lastUsed } of consents) {
		const seen = connectors.get(clientId);
		const scope = new Set([
			...(seen?.scope.split(' ') ?? []),
			...parseScopes(scopes),
		]);
		connectors.set(clientId, {
			kind: 'connector',
			id: clientId,
			name: name ?? hostOf(clientId),
			host: hostOf(clientId),
			scope: [...SCOPES].filter((known) => scope.has(known)).join(' '),
			approved: seen?.approved ?? approved,
			...(lastUsed ? { lastUsed } : {}),
		});
	}
	return [...people, ...connectors.values()];
}

/**
 * End `target`'s access in one transaction. A connector loses its consent,
 * its refresh tokens, and any authorization code not yet exchanged, so it
 * cannot get another access token; one it holds works until it expires. A
 * person loses the passkey and every session it signed in.
 */
export function revokeAccess(db: Database, target: Person | Connector) {
	db.transaction(() => {
		if (target.kind === 'connector') {
			db.query('delete from oauthConsent where clientId = ?').run(target.id);
			db.query('delete from oauthRefreshToken where clientId = ?').run(
				target.id,
			);
			db.query('delete from oauthAccessToken where clientId = ?').run(
				target.id,
			);
			db.query(
				`delete from verification
				  where json_valid(value)
				    and json_extract(value, '$.type') = 'authorization_code'
				    and json_extract(value, '$.query.client_id') = ?`,
			).run(target.id);
			return;
		}
		const row = db
			.query<{ userId: string }, [string]>(
				'select userId from passkey where id = ?',
			)
			.get(target.id);
		if (!row) return;
		db.query('delete from session where userId = ?').run(row.userId);
		db.query('delete from passkey where id = ?').run(target.id);
	})();
}
