/**
 * Real Better Auth session validation through the mounted Hono resource route.
 * Proves renewal, revocation, credential isolation, and infrastructure failures.
 */
import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { Hono } from 'hono';
import { BASE_AUTH_CONFIG } from '../auth/base-config.js';
import { authPlugins } from '../auth/plugins.js';
import { mountSessionApp } from '../routes/session.js';
import type { CloudEnv } from '../types.js';
import {
	requireBearerPrincipal,
	resolveRequestSessionPrincipal,
} from './require-auth.js';

const baseURL = 'http://localhost:8787';
const secret = 'session-resource-test-secret-1234567890';
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
		session: {
			expiresIn: 30 * 86400,
			updateAge: 86400,
			cookieCache: { enabled: false },
		},
	});
	const ctx = await auth.$context;
	async function issue(email: string) {
		const user = await ctx.internalAdapter.createUser({
			name: email,
			email,
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
	const alice = await issue('alice@example.com');
	const bob = await issue('bob@example.com');
	const app = new Hono<CloudEnv>();
	app.use('*', async (c, next) => {
		c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
		await next();
	});
	mountSessionApp(app, {
		auth: requireBearerPrincipal(resolveRequestSessionPrincipal),
	});
	const request = (headers: HeadersInit = {}) =>
		app.request('/api/session', { headers });
	return { db, auth, alice, bob, request, ctx };
}

test('the explicit bearer selects Alice even with Bob cookies and returns no credential', async () => {
	const { alice, bob, request } = await setup();
	const response = await request({
		authorization: `Bearer ${alice.token}`,
		cookie: bob.cookie,
	});
	expect(response.status).toBe(200);
	expect((await response.json()) as unknown).toEqual({
		principalId: alice.user.id,
		email: alice.user.email,
	});
	expect(response.headers.get('set-cookie')).toBeNull();
	expect(response.headers.get('set-auth-token')).toBeNull();
});

test('cookies cannot rescue missing malformed unsigned or invalid bearers', async () => {
	const { alice, bob, request } = await setup();
	for (const authorization of [
		'',
		'Basic nope',
		'Bearer bogus',
		`Bearer ${alice.session.token}`,
		`Bearer ${alice.token}x`,
	]) {
		const response = await request({ authorization, cookie: bob.cookie });
		expect(response.status).toBe(401);
		expect(response.headers.get('www-authenticate')).toBe(
			'Bearer error="invalid_token"',
		);
	}
});

test('ordinary resource traffic extends expiry without changing session age or token', async () => {
	const { db, alice, request } = await setup();
	const row = db.session!.find((row) => row.id === alice.session.id)!;
	const createdAt = new Date(Date.now() - 5 * 86400_000);
	row.createdAt = createdAt;
	row.expiresAt = new Date(Date.now() + 28 * 86400_000);
	const previousExpiry = row.expiresAt.getTime();
	expect(
		(await request({ authorization: `Bearer ${alice.token}` })).status,
	).toBe(200);
	const renewed = db.session!.find((row) => row.id === alice.session.id)!;
	expect(renewed.expiresAt.getTime()).toBeGreaterThan(
		previousExpiry + 86400_000,
	);
	expect(renewed.createdAt).toEqual(createdAt);
	expect(renewed.token).toBe(alice.session.token);
});

test('revocation refuses the selected session while another client remains usable', async () => {
	const { alice, bob, request, ctx } = await setup();
	await ctx.internalAdapter.deleteSession(alice.session.token);
	expect(
		(await request({ authorization: `Bearer ${alice.token}` })).status,
	).toBe(401);
	expect((await request({ authorization: `Bearer ${bob.token}` })).status).toBe(
		200,
	);
});

test('database read failures are 503 instead of invalid credentials', async () => {
	const { alice, request, ctx } = await setup();
	ctx.internalAdapter.findSession = async () => {
		throw new Error('database unavailable');
	};
	const response = await request({ authorization: `Bearer ${alice.token}` });
	expect(response.status).toBe(503);
	expect(response.headers.get('www-authenticate')).toBeNull();
});

test('a concurrent deletion during renewal remains an authentication refusal', async () => {
	const { db, alice, request, ctx } = await setup();
	db.session!.find((row) => row.id === alice.session.id)!.expiresAt = new Date(
		Date.now() + 28 * 86400_000,
	);
	ctx.internalAdapter.updateSession = async () => null;
	expect(
		(await request({ authorization: `Bearer ${alice.token}` })).status,
	).toBe(401);
});

test('database renewal failures remain retryable without rejecting the credential', async () => {
	const { db, alice, request, ctx } = await setup();
	db.session!.find((row) => row.id === alice.session.id)!.expiresAt = new Date(
		Date.now() + 28 * 86400_000,
	);
	ctx.internalAdapter.updateSession = async () => {
		throw new Error('database unavailable');
	};
	const response = await request({ authorization: `Bearer ${alice.token}` });
	expect(response.status).toBe(503);
	expect(response.headers.get('www-authenticate')).toBeNull();
});
