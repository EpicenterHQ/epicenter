/**
 * The session-cookie guard for account management (ADR-0549) through a mounted
 * route over a real Better Auth instance: the cookie selects the account, an
 * access token or session token in `Authorization` does not, another origin
 * and a state change that names no origin are refused, and an unreadable
 * database is a retryable 503. No refusal carries a bearer challenge.
 */
import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { Hono } from 'hono';
import { BASE_AUTH_CONFIG } from '../auth/base-config.js';
import { authPlugins } from '../auth/plugins.js';
import type { CloudEnv } from '../types.js';
import { requireSessionCookie } from './require-auth.js';

const baseURL = 'http://localhost:8787';
const secret = 'session-cookie-test-secret-1234567890';

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
		baseURL,
		secret,
		database: memoryAdapter(db),
		plugins: authPlugins(baseURL),
	});
	const ctx = await auth.$context;
	async function issue(email: string) {
		const user = await ctx.internalAdapter.createUser(
			{ name: email, email, emailVerified: true },
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
	const alice = await issue('alice@example.com');
	const bob = await issue('bob@example.com');
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('authBaseURL', baseURL);
		c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
		await next();
	});
	app.on(
		['GET', 'POST'],
		'/api/billing/overview',
		requireSessionCookie(),
		(c) => c.json(c.var.principal),
	);
	const request = (headers: HeadersInit = {}, method = 'GET') =>
		app.request('/api/billing/overview', { headers, method });
	return { alice, bob, request, ctx };
}

test('the cookie selects its account, whatever Authorization carries', async () => {
	const { alice, bob, request } = await setup();
	const response = await request({
		cookie: alice.cookie,
		authorization: `Bearer ${bob.token}`,
	});
	expect(response.status).toBe(200);
	expect((await response.json()) as unknown).toEqual({
		id: alice.user.id,
		email: alice.user.email,
	});
});

test('a session token or access token without the cookie is refused', async () => {
	const { alice, request } = await setup();
	for (const authorization of [
		`Bearer ${alice.token}`,
		'Bearer ep_at_access-token',
		'',
	]) {
		const response = await request({ authorization });
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBeNull();
		expect(await response.json()).toMatchObject({
			error: { name: 'SessionRequired' },
		});
	}
});

test('another origin is refused even when the browser sends the cookie', async () => {
	const { alice, request } = await setup();
	expect(
		(await request({ cookie: alice.cookie, origin: 'http://localhost:5173' }))
			.status,
	).toBe(403);
	expect(
		(await request({ cookie: alice.cookie, origin: baseURL })).status,
	).toBe(200);
});

test('a state change must name this origin; a read need not', async () => {
	const { alice, request } = await setup();
	const cookie = alice.cookie;
	// A bearer beside the cookie does not excuse a missing origin.
	const originless: Record<string, string>[] = [
		{ cookie },
		{ cookie, authorization: 'Bearer ep_at_access-token' },
	];
	for (const headers of originless)
		expect((await request(headers, 'POST')).status).toBe(403);
	expect((await request({ cookie, origin: baseURL }, 'POST')).status).toBe(200);
	expect((await request({ cookie })).status).toBe(200);
});

test('a revoked session is refused while another stays usable', async () => {
	const { alice, bob, request, ctx } = await setup();
	await ctx.internalAdapter.deleteSession(alice.session.token);
	expect((await request({ cookie: alice.cookie })).status).toBe(401);
	expect((await request({ cookie: bob.cookie })).status).toBe(200);
});

test('a database read failure is a 503, not a refused credential', async () => {
	const { alice, request, ctx } = await setup();
	ctx.internalAdapter.findSession = async () => {
		throw new Error('database unavailable');
	};
	const response = await request({ cookie: alice.cookie });
	expect(response.status).toBe(503);
	expect(response.headers.get('www-authenticate')).toBeNull();
});

test('a page that names another account than the cookie is refused', async () => {
	const { alice, bob, request } = await setup();
	expect(
		(
			await request({
				cookie: alice.cookie,
				'x-epicenter-principal': bob.user.id,
			})
		).status,
	).toBe(403);
	expect(
		(
			await request({
				cookie: alice.cookie,
				'x-epicenter-principal': alice.user.id,
			})
		).status,
	).toBe(200);
});
