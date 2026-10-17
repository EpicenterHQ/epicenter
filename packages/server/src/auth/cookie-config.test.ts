/**
 * Better Auth Cookie Config Tests
 *
 * Verifies that the API auth factory chooses browser-compatible cookie
 * attributes for local development and host-only Lax cookies in production.
 *
 * Key behaviors:
 * - Localhost and loopback (IPv4 and IPv6) use host-only, Lax, non-secure cookies
 * - A deployed origin uses host-only, SameSite=Lax, Secure cookies; there is
 *   no cross-subdomain option (ADR-0079 forbids the halfway `Domain=` cookie)
 */

import { expect, test } from 'bun:test';
import type { BetterAuthOptions } from 'better-auth';
import { getCookies } from 'better-auth/cookies';
import { createCookieAdvancedConfig } from './cookie-config.js';

test.each([
	'http://localhost:8787',
	'http://127.0.0.1:8787',
	'http://[::1]:8787',
])('%s cookies are host-only, Lax, and non-secure', (baseURL) => {
	const cookie = sessionTokenCookie(baseURL);

	expect(cookie.name).toBe('better-auth.session_token');
	expect(cookie.attributes.secure).toBe(false);
	expect(cookie.attributes.sameSite).toBe('lax');
	expect('domain' in cookie.attributes).toBe(false);
});

test('a deployed origin uses host-only, Lax, secure cookies', () => {
	const cookie = sessionTokenCookie('https://api.epicenter.so');

	expect(cookie.name).toBe('__Secure-better-auth.session_token');
	expect(cookie.attributes.secure).toBe(true);
	expect(cookie.attributes.sameSite).toBe('lax');
	expect('domain' in cookie.attributes).toBe(false);
});

function sessionTokenCookie(baseURL: string) {
	const options = {
		baseURL,
		basePath: '/auth',
		advanced: createCookieAdvancedConfig(baseURL),
	} satisfies BetterAuthOptions;
	return getCookies(options).sessionToken;
}
