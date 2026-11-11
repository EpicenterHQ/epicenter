/**
 * Historical on-disk compatibility tests for `PersistedAuth`.
 *
 * The PersistedAuth cell is JSON written to localStorage, chrome.storage.local,
 * or a mode-0600 file on disk. Existing cells on every signed-in machine
 * use specific field names. Renaming a field or adding a required field can
 * make those cells unreadable. JSON property order has no bearing on parsing.
 * Keep a literal historical cell so schema changes cannot update both the
 * writer and the test fixture together.
 *
 * The fixtures are deliberately minimal: short bearer tokens, ASCII-only ids.
 * The intent is not to test auth flow (other tests do that) but to lock the
 * shape consumers serialize against.
 */

import { expect, test } from 'bun:test';
import { PersistedAuth } from './auth-types.js';
import { parsePersistedAuth } from './persisted-auth-storage.js';

const FIXTURE = {
	grant: {
		accessToken: 'a',
		refreshToken: 'r',
		accessTokenExpiresAt: 1_700_000_000_000,
	},
	principalId: 'alice',
};

const HISTORICAL_JSON = `{"grant":{"accessToken":"a","refreshToken":"r","accessTokenExpiresAt":1700000000000},"principalId":"alice"}`;

test('the historical on-disk cell still parses regardless of JSON key order', () => {
	expect(parsePersistedAuth(HISTORICAL_JSON)).toEqual(FIXTURE);
	expect(
		parsePersistedAuth(
			`{"principalId":"alice","grant":{"refreshToken":"r","accessTokenExpiresAt":1700000000000,"accessToken":"a"}}`,
		),
	).toEqual(FIXTURE);
});

test('PersistedAuth rejects a cell missing any required field', () => {
	// arktype treats `{...FIXTURE, x: undefined}` as "x is missing" because
	// `x: string` rejects undefined. Verified manually; do not switch to a
	// strip pattern (e.g. delete broken.x) which would defeat the type-narrow
	// loop.
	const required = ['grant', 'principalId'] as const;
	for (const field of required) {
		const broken = { ...FIXTURE, [field]: undefined };
		expect(
			() => PersistedAuth.assert(broken),
			`expected PersistedAuth.assert to reject cell missing '${field}'`,
		).toThrow();
	}
});

test('PersistedAuth strips unknown top-level fields rather than rejecting', () => {
	const withExtra = { ...FIXTURE, legacyUnlock: { foo: 'bar' } };
	const parsed = PersistedAuth.assert(withExtra) as Record<string, unknown>;
	expect('legacyUnlock' in parsed).toBe(false);
	expect(parsed).toEqual(FIXTURE);
});

test('PersistedAuth strips legacy keyring fields rather than rejecting', () => {
	const withLegacyKeyring = {
		...FIXTURE,
		keyring: [
			{
				version: 1,
				keyBytesBase64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
			},
		],
	};
	const parsed = PersistedAuth.assert(withLegacyKeyring) as Record<
		string,
		unknown
	>;
	expect('keyring' in parsed).toBe(false);
	expect(parsed).toEqual(FIXTURE);
});
