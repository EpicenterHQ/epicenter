/**
 * Direct-session storage accepts exactly token and principalId.
 * Obsolete OAuth cells and malformed credentials never become an identity.
 */
import { expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';
import { parsePersistedAuth } from './persisted-auth-storage.js';

test('the direct-session cell round-trips without grant metadata', () => {
	const cell = { token: 'signed-session', principalId: 'alice' };
	expect(
		JSON.stringify(PersistedAuth.assert(JSON.parse(JSON.stringify(cell)))),
	).toBe(JSON.stringify(cell));
});

test('missing fields, empty tokens, old grants and extra fields are refused', () => {
	for (const value of [
		{},
		{ token: 'token' },
		{ principalId: 'alice' },
		{ token: '', principalId: 'alice' },
		{
			grant: { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: 0 },
			principalId: 'alice',
		},
		{ token: 'a', principalId: 'alice', grant: {} },
	])
		expect(parsePersistedAuth(JSON.stringify(value))).toBeNull();
});
