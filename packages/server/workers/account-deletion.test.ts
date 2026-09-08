/**
 * Drives the real hosted deletion route through its session gate in workerd.
 * Successful admission reaches the first storage step, intentionally unavailable
 * in this fixture; rejected requests cannot start deletion or select a cookie user.
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
		const user = await ctx.internalAdapter.createUser({
			email,
			name: email,
			emailVerified: true,
		});
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
	app.use('*', async (c, next) => {
		c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
		await next();
		principal = c.var.principal?.id;
	});
	mountAccountDeletionApi(app);
	const remove = (headers: HeadersInit) =>
		app.request('/api/account', { method: 'DELETE', headers }, {});
	return { db, alice, bob, ctx, remove, principal: () => principal };
}

test('deletion admits only the explicit fresh principal even with another browser cookie', async () => {
	const { alice, bob, remove, principal } = await setup();
	const response = await remove({
		authorization: `Bearer ${alice.token}`,
		cookie: bob.cookie,
		'x-epicenter-principal': alice.user.id,
	});
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: { failedStep: 'blobs' },
	});
	expect(principal()).toBe(alice.user.id);
});

test('missing invalid mixed or wrong-principal credentials cannot reach deletion', async () => {
	const { alice, bob, remove, principal } = await setup();
	const rejected: HeadersInit[] = [
		{ cookie: alice.cookie },
		{
			authorization: 'Bearer invalid',
			cookie: bob.cookie,
			'x-epicenter-principal': bob.user.id,
		},
		{
			authorization: `Bearer ${alice.session.token}`,
			cookie: alice.cookie,
			'x-epicenter-principal': alice.user.id,
		},
	];
	for (const headers of rejected) {
		expect((await remove(headers)).status).toBe(401);
		expect(principal()).toBeUndefined();
	}
	for (const expected of ['', bob.user.id]) {
		expect(
			(
				await remove({
					authorization: `Bearer ${alice.token}`,
					'x-epicenter-principal': expected,
				})
			).status,
		).toBe(403);
		expect(principal()).toBeUndefined();
	}
});

test('stale or revoked sessions cannot delete and database outages remain retryable', async () => {
	const { db, alice, remove, ctx } = await setup();
	const headers = {
		authorization: `Bearer ${alice.token}`,
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
