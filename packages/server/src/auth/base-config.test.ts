/**
 * Guards the credential-lockdown security posture (the account-takeover fix).
 *
 * The rest of the suite re-enables `emailAndPassword` locally to mint test
 * sessions, so nothing else asserts that the PRODUCTION config actually closes
 * local credentials or that GitHub was kept out of the trusted-linking set.
 * These tests build Better Auth from the real {@link BASE_AUTH_CONFIG} and pin
 * both invariants.
 */

import { describe, expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { authPlugins } from './plugins.js';

const baseURL = 'http://localhost:8787';

function createProductionShapedAuth() {
	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: memoryAdapter({ user: [], account: [], session: [], verification: [], passkey: [] }),
		baseURL,
		secret: 'test-secret-test-secret-test-secret',
		socialProviders: { google: { clientId: 'x', clientSecret: 'y' } },
		plugins: authPlugins(baseURL),
	});
}

describe('credential lockdown (BASE_AUTH_CONFIG)', () => {
	test('email/password is disabled and only Google is a trusted linking provider', () => {
		// trustedProviders bypasses the incoming emailVerified check, so it must
		// hold only IdPs that always assert a verified email. GitHub (which can
		// return an unverified email) must never be added here.
		expect(BASE_AUTH_CONFIG.emailAndPassword.enabled).toBe(false);
		expect(BASE_AUTH_CONFIG.account.accountLinking.trustedProviders).toEqual([
			'google',
		]);
	});

	test('different-email linking is allowed for the explicit link-social flow', () => {
		// Enables the account page to link a work/personal provider whose email
		// differs from the account email. Safe only because it pairs with the
		// fresh-session gate (see account-linking.test.ts); it does NOT enable
		// different-email IMPLICIT linking during sign-in (structurally impossible).
		expect(BASE_AUTH_CONFIG.account.accountLinking.allowDifferentEmails).toBe(
			true,
		);
	});

	test('POST /auth/sign-up/email does not create a session', async () => {
		const auth = createProductionShapedAuth();
		const res = await auth.handler(
			new Request(`${baseURL}/auth/sign-up/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: 'attacker@example.com',
					password: 'password123',
					name: 'Attacker',
				}),
			}),
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.headers.get('set-cookie')).toBeNull();
	});

	test('POST /auth/sign-in/email does not create a session', async () => {
		const auth = createProductionShapedAuth();
		const res = await auth.handler(
			new Request(`${baseURL}/auth/sign-in/email`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					email: 'attacker@example.com',
					password: 'password123',
				}),
			}),
		);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.headers.get('set-cookie')).toBeNull();
	});
});
