/**
 * Bearer auth middleware integration tests.
 *
 * Drives `requireBearerPrincipal` through a real Hono app with a real Better Auth
 * server hosted on Bun.serve. Covers the production paths:
 *
 * - valid token resolves to the calling principal on `c.var.principal`
 * - verification reads the signing keys in-process, with no network hop
 * - a malformed (non-JWT) bearer returns 401 InvalidToken
 * - a token issued for the wrong audience returns 401 InvalidToken
 * - a token whose user no longer exists returns 401 InvalidToken
 * - a failure reading the signing keys returns 503 ServerError, not 401
 *
 * Header parsing for the bearer scheme lives in `auth/parse-bearer.test.ts`.
 * HTTP and WebSocket failure response shape lives in `auth/oauth-resource.test.ts`.
 */

import { expect, test } from 'bun:test';
import { oauthProvider } from '@better-auth/oauth-provider';
import { Principal } from '@epicenter/auth';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth-clients';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { JWT_SIGNING_ALG } from '../auth/base-config.js';
import { OAuthError } from '../auth/oauth-errors.js';
import {
	createOAuthTestDb,
	isAddressInUse,
	issueOAuthTokens,
	randomOAuthTestPort,
} from '../test-helpers/oauth.js';
import type { CloudEnv } from '../types.js';
import {
	requireBearerPrincipal,
	requireCookieOrBearerPrincipal,
	resolveRequestOAuthPrincipal,
} from './require-auth.js';

test('requireBearerPrincipal resolves a valid API-audience token to c.var.principal', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});
		const tokenUser = setup.db.user?.[0];
		if (!tokenUser) throw new Error('Expected the OAuth token user');
		setup.db.user?.unshift({
			...tokenUser,
			id: 'different-user-id',
			email: 'different@example.com',
		});

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string; email: string };
		expect(body).toEqual({
			id: tokenUser.id,
			email: tokenUser.email,
		});
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerPrincipal verifies a valid token in-process, with no network hop', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});
		// Stopping the auth server proves verification never round-trips to
		// `/auth/jwks`: the signing keys are read in-process from `c.var.auth`.
		setup.server.stop(true);

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: string; email: string };
		expect(body).toEqual({
			id: expect.any(String),
			email: 'middleware-test@example.com',
		});
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerPrincipal rejects a malformed (non-JWT) bearer with 401 InvalidToken', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const response = await setup.app.request('/protected', {
			headers: { authorization: 'Bearer not-a-real-jwt' },
		});

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerPrincipal rejects tokens issued for the wrong audience with 401 InvalidToken', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
			resource: setup.wrongAudience,
		});

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		expect(response.headers.get('WWW-Authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerPrincipal rejects tokens whose user no longer exists with 401 InvalidToken', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});
		setup.db.user = [];

		const response = await setup.app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(401);
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('InvalidToken');
	} finally {
		setup.server.stop(true);
	}
});

test('requireBearerPrincipal returns 503 ServerError when the signing keys cannot be read', async () => {
	const setup = createMiddlewareTestServer();
	try {
		const { accessToken } = await issueOAuthTokens(setup, {
			clientName: 'Bearer Middleware Test',
			email: 'middleware-test@example.com',
			name: 'Middleware Test',
		});

		// Same valid token, but the signing-key read fails. The token decodes far
		// enough to need a key, so verification reaches the failing read: that
		// means the token was never checked, so the client must retry (503), not
		// discard and refresh a token that may be fine (401). No
		// `WWW-Authenticate` challenge belongs on an infrastructure fault.
		const app = new Hono<CloudEnv>()
			.use('*', async (c, next) => {
				c.set('db', createFakeDb(setup.db));
				c.set('authBaseURL', setup.baseURL);
				c.set('auth', {
					api: {
						getJwks: async () => {
							throw new Error('signing keys unreadable');
						},
					},
				} as unknown as CloudEnv['Variables']['auth']);
				await next();
			})
			.get(
				'/protected',
				requireBearerPrincipal(resolveRequestOAuthPrincipal),
				(c) => c.json(c.var.principal),
			);

		const response = await app.request('/protected', {
			headers: { authorization: `Bearer ${accessToken}` },
		});

		expect(response.status).toBe(503);
		expect(response.headers.get('WWW-Authenticate')).toBeNull();
		const body = (await response.json()) as { name: string };
		expect(body.name).toBe('ServerError');
	} finally {
		setup.server.stop(true);
	}
});

test('requireCookieOrBearerPrincipal resolves the principal from a session cookie and skips the bearer path', async () => {
	// The cloud-only cookie path: a present Better Auth session resolves the
	// principal and the injected bearer resolver is never consulted
	// (cookie-first). Stubs `c.var.auth.api.getSession` (the only auth read) and
	// asserts the bearer resolver stays untouched.
	let resolvePrincipalCalls = 0;
	const sessionUser = { id: 'cookie-user-id', email: 'cookie@example.com' };
	const cookieOrBearer = requireCookieOrBearerPrincipal(async () => {
		resolvePrincipalCalls += 1;
		return OAuthError.InvalidToken();
	});
	const app = new Hono<CloudEnv>()
		.use('*', async (c, next) => {
			c.set('auth', {
				api: { getSession: async () => ({ user: sessionUser }) },
			} as unknown as CloudEnv['Variables']['auth']);
			await next();
		})
		.get('/protected', cookieOrBearer, (c) => c.json(c.var.principal));

	const response = await app.request('/protected');

	expect(response.status).toBe(200);
	const body = (await response.json()) as { id: string; email: string };
	expect(body).toEqual(sessionUser);
	expect(resolvePrincipalCalls).toBe(0);
});

test('requireCookieOrBearerPrincipal falls back to the bearer resolver when there is no session', async () => {
	// No cookie session -> the resolver the wrapper closed over decides, exactly
	// the bearer path the cloud and an instance share.
	const bearerUser = Principal.assert({
		id: 'bearer-user-id',
		email: 'bearer@example.com',
	});
	const cookieOrBearer = requireCookieOrBearerPrincipal(async () =>
		Ok(bearerUser),
	);
	const app = new Hono<CloudEnv>()
		.use('*', async (c, next) => {
			c.set('auth', {
				api: { getSession: async () => null },
			} as unknown as CloudEnv['Variables']['auth']);
			await next();
		})
		.get('/protected', cookieOrBearer, (c) => c.json(c.var.principal));

	const response = await app.request('/protected', {
		headers: { authorization: 'Bearer whatever' },
	});

	expect(response.status).toBe(200);
	const body = (await response.json()) as { id: string; email: string };
	expect(body).toEqual({ id: 'bearer-user-id', email: 'bearer@example.com' });
});

test('requireBearerPrincipal does not read signing keys for a non-JWT bearer', async () => {
	// A non-JWT never decodes far enough to need a key, so verification fails
	// before `jwksFetch` runs: a garbage bearer costs no database read, and the
	// failure is a 401, not an infrastructure 503.
	let getJwksCalls = 0;
	const app = new Hono<CloudEnv>()
		.use('*', async (c, next) => {
			c.set('authBaseURL', 'http://localhost');
			c.set('auth', {
				api: {
					getJwks: async () => {
						getJwksCalls += 1;
						return { keys: [] };
					},
				},
			} as unknown as CloudEnv['Variables']['auth']);
			await next();
		})
		.get(
			'/protected',
			requireBearerPrincipal(resolveRequestOAuthPrincipal),
			(c) => c.json(c.var.principal),
		);

	const response = await app.request('/protected', {
		headers: { authorization: 'Bearer not-a-real-jwt' },
	});

	expect(response.status).toBe(401);
	expect(getJwksCalls).toBe(0);
});

function createMiddlewareTestServer() {
	const db = createOAuthTestDb();

	for (let attempt = 0; attempt < 200; attempt += 1) {
		const port = randomOAuthTestPort();
		const baseURL = `http://localhost:${port}`;
		const wrongAudience = `${baseURL}/other-resource`;
		const auth = betterAuth({
			database: memoryAdapter(db),
			emailAndPassword: { enabled: true },
			basePath: '/auth',
			baseURL,
			secret: 'test-secret-test-secret-test-secret',
			plugins: [
				jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }),
				oauthProvider({
					loginPage: '/sign-in',
					consentPage: '/consent',
					requirePKCE: true,
					validAudiences: [baseURL, wrongAudience],
					allowDynamicClientRegistration: false,
					scopes: [...EPICENTER_OAUTH_SCOPES],
					silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
				}),
			],
		});

		try {
			const server = Bun.serve({
				port,
				fetch: async (request) => auth.handler(request),
			});

			const app = new Hono<CloudEnv>()
				.use('*', async (c, next) => {
					c.set('db', createFakeDb(db));
					c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
					c.set('authBaseURL', baseURL);
					await next();
				})
				.get(
					'/protected',
					requireBearerPrincipal(resolveRequestOAuthPrincipal),
					(c) => c.json(c.var.principal),
				);

			return { auth, baseURL, db, server, wrongAudience, app };
		} catch (error) {
			if (isAddressInUse(error)) continue;
			throw error;
		}
	}

	throw new Error('Failed to find an available bearer-middleware test port.');
}

/**
 * Stub `c.var.db` shaped for the one Drizzle query the middleware makes.
 *
 * The middleware reads `db.query.user.findFirst({ where: eq(user.id, id) })`.
 * Compile the predicate with the Postgres dialect and select by its bound id.
 * The success test puts a different user first, so ignoring or changing the
 * subject predicate cannot return the token's principal by accident. The
 * signing keys are read separately through `c.var.auth.api`, so the stub does
 * not model the `jwks` table.
 */
function createFakeDb(memoryDb: MemoryDB) {
	const dialect = new PgDialect();
	return {
		query: {
			user: {
				findFirst: async ({ where }: { where: SQL }) => {
					const { sql, params } = dialect.sqlToQuery(where);
					if (
						sql !== '"user"."id" = $1' ||
						params.length !== 1 ||
						typeof params[0] !== 'string'
					) {
						throw new Error(`Unexpected user lookup: ${sql}`);
					}
					return memoryDb.user?.find((user) => user.id === params[0]) ?? null;
				},
			},
		},
	} as unknown as CloudEnv['Variables']['db'];
}
