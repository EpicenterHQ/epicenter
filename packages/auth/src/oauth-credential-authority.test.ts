/**
 * OAuth Credential Authority Tests
 *
 * Verifies the authority-only contract that is intentionally invisible on the
 * public AuthClient: bearer grants carry a generation, refresh advances it,
 * and a late rejection cannot pause a newer credential.
 *
 * Key behaviors:
 * - Session verification makes the current credential network eligible
 * - Refresh produces a new token generation
 * - Only rejection of the current generation pauses network auth
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import type { OAuthTokenGrant, PersistedAuth } from './auth-types.js';
import { createOAuthCredentialAuthority } from './oauth-credential-authority.js';
import type { OAuthLaunchResult } from './oauth-launchers/contract.js';

const now = 1_000_000;
const baseURL = 'http://localhost:8787';

function json(value: unknown) {
	return new Response(JSON.stringify(value), {
		headers: { 'content-type': 'application/json' },
	});
}

function oauthTokenResponse() {
	return json({
		access_token: 'refreshed-access',
		refresh_token: 'refreshed-refresh',
		expires_in: 3600,
		token_type: 'bearer',
	});
}

test('stale rejection cannot pause a refreshed credential generation', async () => {
	const initialGrant: OAuthTokenGrant = {
		accessToken: 'initial-access',
		refreshToken: 'initial-refresh',
		accessTokenExpiresAt: now + 3_600_000,
	};
	let stored: PersistedAuth | null = {
		grant: initialGrant,
		principalId: asPrincipalId('user-1'),
	};
	const authority = createOAuthCredentialAuthority(
		{
			persistedAuthStorage: {
				initial: stored,
				set(value) {
					stored = value;
				},
			},
			launcher: {
				startSignIn: async () =>
					Ok({ status: 'launched' } satisfies OAuthLaunchResult),
			},
			fetch: async (input) => {
				const url = String(input);
				if (url.endsWith('/auth/oauth2/token')) return oauthTokenResponse();
				if (url.endsWith('/api/session')) {
					return json({
						principalId: 'user-1',
						email: 'user-1@example.com',
					});
				}
				throw new Error(`Unexpected auth request: ${url}`);
			},
		},
		{ baseURL, clientId: 'client-1', now: () => now },
	);

	const initial = await authority.authorize();
	expect(initial).toEqual({
		status: 'authorized',
		accessToken: 'initial-access',
		tokenGeneration: 1,
	});
	expect(authority.snapshot.networkEligible).toBe(true);

	const refreshed = await authority.authorize({ forceRefresh: true });
	expect(refreshed).toEqual({
		status: 'authorized',
		accessToken: 'refreshed-access',
		tokenGeneration: 2,
	});
	expect(stored?.grant.accessToken).toBe('refreshed-access');

	if (initial.status !== 'authorized' || refreshed.status !== 'authorized') {
		throw new Error('Expected both authorization attempts to succeed.');
	}
	authority.reportRejected(initial.tokenGeneration);
	expect(authority.snapshot.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('user-1'),
	});

	authority.reportRejected(refreshed.tokenGeneration);
	expect(authority.snapshot).toMatchObject({
		state: {
			status: 'reauth-required',
			principalId: asPrincipalId('user-1'),
		},
		networkEligible: false,
		tokenGeneration: 2,
	});
	authority[Symbol.dispose]();
});
