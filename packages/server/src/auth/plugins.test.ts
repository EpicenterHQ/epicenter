/**
 * Passkey REST behavior through Better Auth's real handler.
 * Authentication is sessionless; registration uses a fresh expected principal,
 * the API hostname, and base64url challenges. Password sign-in stays disabled.
 */
import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { betterAuth, type Session, type User } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { authPlugins } from './plugins.js';
import { requireAccountSession } from './session-policy.js';

const baseURL = 'http://localhost:47878';
const secret = 'test-secret-test-secret-test-secret';
function setup() {
	const auth = betterAuth({
		...BASE_AUTH_CONFIG,
		baseURL,
		secret,
		database: memoryAdapter({
			user: [],
			session: [],
			account: [],
			verification: [],
			passkey: [],
		}),
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
	function options(
		ceremony: 'authenticate' | 'register',
		headers?: HeadersInit,
	) {
		return auth.handler(
			new Request(`${baseURL}/auth/passkey/generate-${ceremony}-options`, {
				headers,
			}),
		);
	}
	return { auth, options };
}
test('passkey authenticate options are mintable without a session', async () => {
	const { options } = setup();
	const response = await options('authenticate');
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({
		rpId: 'localhost',
		challenge: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
	});
});
test('passkey register options require a session', async () => {
	const { options } = setup();
	expect((await options('register')).status).toBe(401);
});
test('fresh cookie session mints passkey registration options for the expected user', async () => {
	const { auth, options } = setup();
	const ctx = await auth.$context;
	const user = await ctx.internalAdapter.createUser({
		name: 'Alice',
		email: 'alice@example.test',
		emailVerified: true,
	});
	const session = await ctx.internalAdapter.createSession(user.id, false);
	assert(session);
	const signed = `${session.token}.${await makeSignature(session.token, secret)}`;
	const response = await options('register', {
		cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`,
		'x-epicenter-principal': user.id,
	});
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(body).toMatchObject({
		rp: { id: 'localhost', name: 'Epicenter' },
		challenge: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
		user: { name: user.email, id: expect.stringMatching(/^[A-Za-z0-9_-]+$/) },
	});
	expect(auth.options.session).toEqual({
		expiresIn: 30 * 86400,
		updateAge: 86400,
		freshAge: 600,
		cookieCache: { enabled: false },
	});
	expect(auth.options.emailAndPassword?.enabled).toBe(false);
});
