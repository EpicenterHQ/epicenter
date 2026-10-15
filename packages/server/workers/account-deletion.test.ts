/**
 * Drives the real hosted deletion route through its session gate in workerd.
 * A fresh session cookie receives an explicit refusal without deleting account
 * records. Rejected requests, including access-token bearers and other
 * origins, cannot start deletion or select a different user (ADR-0549).
 */
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { mountAccountDeletionApi } from '../../../apps/api/worker/account/routes.js';
import { BASE_AUTH_CONFIG } from '../src/auth/base-config.js';
import { authPlugins } from '../src/auth/plugins.js';
import type { CloudEnv } from '../src/types.js';

async function setup() {
	const secret = 'deletion-route-fixture-secret-1234567890';
	const db: MemoryDB = {
		user: [],
		account: [],
		session: [],
		verification: [],
		passkey: [],
	};
	const auth = betterAuth({
		...BASE_AUTH_CONFIG,
		baseURL: 'https://api.example.test',
		secret,
		database: memoryAdapter(db),
		plugins: authPlugins('https://api.example.test'),
	});
	const ctx = await auth.$context;
	async function issue(email: string) {
		const user = await ctx.internalAdapter.createUser(
			{
				email,
				name: email,
				emailVerified: true,
			},
			{ method: 'admin' },
		);
		const session = await ctx.internalAdapter.createSession(user.id);
		const token = `${session.token}.${await makeSignature(session.token, secret)}`;
		return {
			user,
			session,
			token,
			cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(token)}`,
		};
	}
	const alice = await issue('alice@example.test');
	const bob = await issue('bob@example.test');
	let principal: string | undefined;
	const app = new Hono<CloudEnv>();
	mountAccountDeletionApi(app, {
		setup: async (c, next) => {
			c.set('authBaseURL', 'https://api.example.test');
			c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
			await next();
			principal = c.var.principal?.id;
		},
	});
	const remove = (headers: HeadersInit) =>
		app.request('/api/account', { method: 'DELETE', headers }, {});
	const invalidCookie = `${ctx.authCookies.sessionToken.name}=invalid`;
	return {
		db,
		alice,
		bob,
		ctx,
		invalidCookie,
		remove,
		principal: () => principal,
	};
}

test('deletion refuses the explicit fresh principal without changing either account', async () => {
	const { db, alice, remove, principal } = await setup();
	const before = structuredClone(db);
	const response = await remove({
		cookie: alice.cookie,
		origin: 'https://api.example.test',
		'x-epicenter-principal': alice.user.id,
	});
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { code: 'ACCOUNT_DELETION_UNAVAILABLE' },
	});
	expect(principal()).toBe(alice.user.id);
	expect(db).toEqual(before);
});

test('missing invalid foreign-origin or wrong-principal credentials cannot reach deletion', async () => {
	const { alice, bob, invalidCookie, remove, principal } = await setup();
	const unauthorized: HeadersInit[] = [
		{ 'x-epicenter-principal': alice.user.id },
		// A bearer is no credential for account management.
		{
			authorization: `Bearer ${alice.token}`,
			'x-epicenter-principal': alice.user.id,
		},
		{ cookie: invalidCookie, 'x-epicenter-principal': bob.user.id },
	];
	for (const headers of unauthorized) {
		expect((await remove(headers)).status).toBe(401);
		expect(principal()).toBeUndefined();
	}
	const forbidden: HeadersInit[] = [
		{ cookie: alice.cookie },
		{ cookie: alice.cookie, 'x-epicenter-principal': '' },
		{ cookie: alice.cookie, 'x-epicenter-principal': bob.user.id },
		{
			cookie: alice.cookie,
			origin: 'https://todos.example.test',
			'x-epicenter-principal': alice.user.id,
		},
	];
	for (const headers of forbidden) {
		expect((await remove(headers)).status).toBe(403);
		expect(principal()).toBeUndefined();
	}
});

test('stale or revoked sessions cannot delete and database outages remain retryable', async () => {
	const { db, alice, remove, ctx } = await setup();
	const headers = {
		cookie: alice.cookie,
		'x-epicenter-principal': alice.user.id,
	};
	const row = db.session!.find((row) => row.id === alice.session.id)!;
	row.createdAt = new Date(Date.now() - 600_000);
	expect((await remove(headers)).status).toBe(403);
	await ctx.internalAdapter.deleteSession(alice.session.token);
	expect((await remove(headers)).status).toBe(401);
	ctx.internalAdapter.findSession = async () => {
		throw new Error('database unavailable');
	};
	expect((await remove(headers)).status).toBe(503);
});
