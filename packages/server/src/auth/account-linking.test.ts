/**
 * Real management routes enforce this origin, the session cookie, the expected
 * principal, and ten-minute freshness. An `Authorization` header is never a
 * credential here. Account deletion passes the same checks and then refuses
 * before any destructive work.
 * Explicit callbacks retain their protected target after sign-out/replacement;
 * implicit linking follows verified email. Only upstream token exchange and
 * user-info responses are stubbed; these tests make no live provider claims.
 */
import { expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { betterAuth, type Session, type User } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { authPlugins } from './plugins.js';
import { requireAccountSession } from './session-policy.js';

const baseURL = 'http://localhost:47878';
const secret = 'test-secret-test-secret-test-secret';
/** Each management route, its body, and its status once every check passes. */
const routes = [
	['/unlink-account', { accountId: 'alice-github' }, 200],
	['/passkey/generate-register-options', undefined, 200],
	['/passkey/delete-passkey', { id: 'alice-passkey' }, 200],
	['/link-social', { provider: 'google', callbackURL: baseURL }, 200],
	// Hosted erasure is not yet complete (ADR-0360), so deletion refuses.
	['/delete-user', {}, 503],
] as const;

async function setup() {
	const db: MemoryDB = {
		user: [],
		session: [],
		account: [],
		verification: [],
		passkey: [],
	};
	const auth = betterAuth({
		...BASE_AUTH_CONFIG,
		database: memoryAdapter(db),
		baseURL,
		secret,
		logger: { disabled: true },
		socialProviders: {
			google: { clientId: 'fixture', clientSecret: 'fixture' },
			github: { clientId: 'fixture', clientSecret: 'fixture' },
		},
		plugins: authPlugins(baseURL),
		hooks: {
			before: requireAccountSession(
				(headers): Promise<{ session: Session; user: User } | null> =>
					auth.api.getSession({
						headers,
						query: { disableCookieCache: true, disableRefresh: true },
					}),
			),
		},
	});
	const ctx = await auth.$context;
	async function seed(name: string) {
		const user = await ctx.internalAdapter.createUser(
			{
				name,
				email: `${name.toLowerCase()}@example.test`,
				emailVerified: true,
			},
			{ method: 'admin' },
		);
		const session = await ctx.internalAdapter.createSession(user.id, false);
		assert(session);
		const token = `${session.token}.${await makeSignature(session.token, secret)}`;
		// Better Auth 1.7 unlinks by account row id, so the rows get known ids.
		for (const providerId of ['github', 'google'])
			await ctx.adapter.create({
				model: 'account',
				data: {
					id: `${name.toLowerCase()}-${providerId}`,
					userId: user.id,
					providerId,
					accountId: `${name}-${providerId}`,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
				forceAllowId: true,
			});
		await ctx.adapter.create({
			model: 'passkey',
			data: {
				id: `${name.toLowerCase()}-passkey`,
				userId: user.id,
				name,
				publicKey: 'fixture',
				credentialID: `${name}-credential`,
				counter: 0,
				deviceType: 'singleDevice',
				backedUp: false,
				createdAt: new Date(),
			},
			forceAllowId: true,
		});
		return {
			user,
			session,
			token,
			cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(token)}`,
		};
	}
	const alice = await seed('Alice');
	const bob = await seed('Bob');
	function request(
		path: string,
		body?: unknown,
		headers: Record<string, string> = {},
	) {
		return auth.handler(
			new Request(`${baseURL}/auth${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					origin: baseURL,
					'content-type': 'application/json',
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	}
	function stubProvider(
		id: 'google' | 'github',
		email: string,
		emailVerified: boolean,
	) {
		assert(Array.isArray(ctx.socialProviders));
		const provider = ctx.socialProviders.find((provider) => provider.id === id);
		assert(provider);
		provider.validateAuthorizationCode = async () => ({
			accessToken: 'synthetic-upstream-token',
		});
		// Better Auth 1.7 keys the provider account on `accountSubject`, never on
		// the mapped user.
		provider.accountSubject = () => 'new-provider-identity';
		provider.getUserInfo = async () => ({
			user: { name: 'Provider fixture', email, emailVerified },
			data: {},
		});
	}
	async function callback(start: Response, provider: string, cookie = '') {
		expect(start.status).toBe(200);
		const body = await start.json();
		assert(
			body &&
				typeof body === 'object' &&
				'url' in body &&
				typeof body.url === 'string',
		);
		const state = new URL(body.url).searchParams.get('state');
		assert(state);
		const stateCookies = start.headers
			.getSetCookie()
			.map((value) => value.split(';')[0])
			.join('; ');
		return request(
			`/callback/${provider}?code=synthetic-code&state=${encodeURIComponent(state)}`,
			undefined,
			{ cookie: [stateCookies, cookie].filter(Boolean).join('; ') },
		);
	}
	return { db, auth, ctx, alice, bob, request, stubProvider, callback };
}

// Management route credential selection and freshness.
for (const [path, body, admitted] of routes) {
	test(`${path} accepts a fresh cookie with its expected principal`, async () => {
		const { alice, request } = await setup();
		const response = await request(path, body, {
			cookie: alice.cookie,
			'x-epicenter-principal': alice.user.id,
		});
		expect(response.status).toBe(admitted);
	});
	test(`${path} refuses another origin even with the cookie`, async () => {
		const { db, alice, request } = await setup();
		const before = structuredClone(db);
		const response = await request(path, body, {
			cookie: alice.cookie,
			origin: 'https://todos.example.test',
			'x-epicenter-principal': alice.user.id,
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: 'FORBIDDEN_ORIGIN' });
		expect(db).toEqual(before);
	});
	for (const age of [599_999, 600_000, 600_001]) {
		test(`${path} ${age < 600_000 ? 'accepts' : 'refuses'} a session aged ${age}ms`, async () => {
			const { db, alice, request } = await setup();
			const now = Date.now();
			const clock = spyOn(Date, 'now').mockReturnValue(now);
			try {
				db.session!.find((row) => row.id === alice.session.id)!.createdAt =
					new Date(now - age);
				const before = structuredClone({
					accounts: db.account,
					passkeys: db.passkey,
				});
				const response = await request(path, body, {
					cookie: alice.cookie,
					'x-epicenter-principal': alice.user.id,
				});
				expect(response.status).toBe(age < 600_000 ? admitted : 403);
				if (age >= 600_000) {
					expect(await response.json()).toMatchObject({
						code: 'SESSION_NOT_FRESH',
					});
					expect({ accounts: db.account, passkeys: db.passkey }).toEqual(
						before,
					);
				}
			} finally {
				clock.mockRestore();
			}
		});
	}
	test(`${path} takes no session token or access token in Authorization`, async () => {
		const { db, alice, request } = await setup();
		for (const authorization of [
			`Bearer ${alice.token}`,
			'Bearer ep_at_access-token',
			'Basic ignored',
		]) {
			const before = structuredClone(db);
			const response = await request(path, body, {
				authorization,
				'x-epicenter-principal': alice.user.id,
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
			expect(db).toEqual(before);
		}
	});
	test(`${path} acts for the cookie's account only with its expected ID, whatever Authorization carries`, async () => {
		const { db, alice, bob, request } = await setup();
		for (const expected of [undefined, bob.user.id]) {
			const before = structuredClone(db);
			const response = await request(path, body, {
				authorization: `Bearer ${bob.token}`,
				cookie: alice.cookie,
				...(expected ? { 'x-epicenter-principal': expected } : {}),
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: 'PRINCIPAL_MISMATCH',
			});
			expect(db).toEqual(before);
		}
		const response = await request(path, body, {
			authorization: `Bearer ${bob.token}`,
			cookie: alice.cookie,
			'x-epicenter-principal': alice.user.id,
		});
		expect(response.status).toBe(admitted);
		if (path === '/delete-user') {
			expect(await response.json()).toMatchObject({
				code: 'ACCOUNT_DELETION_UNAVAILABLE',
			});
			// No deletion started: the account and its session remain.
			expect(db.user!.map((row) => row.id)).toContain(alice.user.id);
			expect(db.session!.map((row) => row.userId)).toContain(alice.user.id);
		} else if (path === '/unlink-account') {
			expect(
				db
					.account!.filter((row) => row.userId === alice.user.id)
					.map((row) => row.providerId),
			).toEqual(['google']);
			expect(
				db.account!.filter((row) => row.userId === bob.user.id),
			).toHaveLength(2);
		} else if (path === '/passkey/delete-passkey') {
			expect(db.passkey!.map((row) => row.userId)).toEqual([bob.user.id]);
		} else if (path === '/passkey/generate-register-options') {
			expect(await response.json()).toMatchObject({
				user: { name: alice.user.email },
				excludeCredentials: [{ id: 'Alice-credential' }],
			});
		}
	});
	test(`${path} distinguishes database outage from missing authentication`, async () => {
		const { ctx, alice, request } = await setup();
		expect((await request(path, body)).status).toBe(401);
		const failure = spyOn(ctx.internalAdapter, 'findSession').mockRejectedValue(
			new Error('database unavailable'),
		);
		try {
			const response = await request(path, body, {
				cookie: alice.cookie,
				'x-epicenter-principal': alice.user.id,
			});
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({
				code: 'SESSION_UNAVAILABLE',
			});
		} finally {
			failure.mockRestore();
		}
	});
}

// Real OAuth state and callbacks; no provider network requests.
for (const replacement of [false, true]) {
	test(`explicit callback links Alice after source sign-out${replacement ? ' and Bob replacement' : ''}`, async () => {
		const { db, alice, bob, request, stubProvider, callback } = await setup();
		stubProvider('google', 'different@example.test', true);
		const start = await request(
			'/link-social',
			{ provider: 'google', callbackURL: baseURL },
			{
				cookie: alice.cookie,
				'x-epicenter-principal': alice.user.id,
			},
		);
		expect(
			(await request('/sign-out', {}, { cookie: alice.cookie })).status,
		).toBe(200);
		expect(db.session!.some((row) => row.id === alice.session.id)).toBe(false);
		const response = await callback(
			start,
			'google',
			replacement ? bob.cookie : '',
		);
		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe(baseURL);
		expect(
			db.account!.filter((row) => row.accountId === 'new-provider-identity'),
		).toMatchObject([{ userId: alice.user.id }]);
		expect(response.headers.get('set-auth-token')).toBeNull();
	});
}
for (const provider of ['google', 'github'] as const) {
	for (const ambient of ['none', 'bob'] as const) {
		test(`verified ${provider} same-email sign-in links Alice with ${ambient} ambient account`, async () => {
			const { db, alice, bob, request, stubProvider, callback, auth, ctx } =
				await setup();
			stubProvider(provider, alice.user.email, true);
			const headers: Record<string, string> =
				ambient === 'bob'
					? { cookie: bob.cookie, 'x-epicenter-principal': bob.user.id }
					: {};
			const start = await request(
				'/sign-in/social',
				{ provider, callbackURL: baseURL },
				headers,
			);
			const response = await callback(
				start,
				provider,
				ambient === 'bob' ? bob.cookie : '',
			);
			expect(response.status).toBe(302);
			expect(response.headers.get('location')).toBe(baseURL);
			expect(db.user).toHaveLength(2);
			expect(
				db.account!.filter((row) => row.accountId === 'new-provider-identity'),
			).toMatchObject([{ userId: alice.user.id }]);
			const cookie = response.headers
				.getSetCookie()
				.map((value) => value.split(';')[0])
				.find((value) =>
					value?.startsWith(`${ctx.authCookies.sessionToken.name}=`),
				);
			assert(cookie);
			expect(
				(await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user
					.id,
			).toBe(alice.user.id);
		});
	}
}
for (const ambient of ['none', 'bob'] as const) {
	test(`unverified untrusted GitHub refuses same-email linking with ${ambient} ambient account`, async () => {
		const { db, alice, bob, request, stubProvider, callback } = await setup();
		stubProvider('github', alice.user.email, false);
		const before = structuredClone({
			accounts: db.account,
			sessions: db.session,
			users: db.user,
		});
		const start = await request(
			'/sign-in/social',
			{ provider: 'github', callbackURL: baseURL },
			ambient === 'bob'
				? { cookie: bob.cookie, 'x-epicenter-principal': bob.user.id }
				: {},
		);
		const response = await callback(
			start,
			'github',
			ambient === 'bob' ? bob.cookie : '',
		);
		expect(response.status).toBe(302);
		expect(
			new URL(response.headers.get('location')!).searchParams.get('error'),
		).toBe('account_not_linked');
		expect({
			accounts: db.account,
			sessions: db.session,
			users: db.user,
		}).toEqual(before);
		expect(response.headers.get('set-auth-token')).toBeNull();
	});
}
