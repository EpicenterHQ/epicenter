import { describe, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { Ok } from 'wellcrafted/result';
import type { AuthFetch } from './auth-contract.js';
import type { OAuthTokenGrant, PersistedAuth } from './auth-types.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import type {
	OAuthLauncher,
	OAuthLaunchResult,
} from './oauth-launchers/contract.js';

const baseURL = 'https://api.epicenter.so';
const clientId = 'client-1';

function sessionBody(principalId = 'principal-1') {
	return {
		principalId,
		email: `${principalId}@example.com`,
	};
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** A grant whose access token never looks stale, so refresh is a no-op. */
function grant(overrides: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
		...overrides,
	};
}

function persistedAuth(): PersistedAuth {
	return {
		grant: grant(),
		principalId: asPrincipalId('principal-1'),
	};
}

/**
 * In-memory persisted-auth cell seeded with an optional initial record. Exposes
 * the live `current` value (a structural superset of `PersistedAuthStorage`) so a
 * test can assert what was persisted.
 */
function inMemoryStorage(initial: PersistedAuth | null = null) {
	let current = initial;
	return {
		initial,
		set(value: PersistedAuth | null) {
			current = value;
		},
		get current() {
			return current;
		},
	};
}

/** A launcher that completes sign-in immediately with the given grant. */
function completingLauncher(g: OAuthTokenGrant): OAuthLauncher {
	return {
		async startSignIn() {
			const result: OAuthLaunchResult = { status: 'completed', grant: g };
			return Ok(result);
		},
	};
}

describe('createOAuthAppAuth /api/session verification', () => {
	test('completing sign-in verifies /api/session and installs signed-in with the principalId', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const storage = inMemoryStorage();
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: storage,
			launcher: completingLauncher(grant()),
			fetch,
		});

		const { error } = await auth.startSignIn();
		expect(error).toBeNull();
		expect(auth.state).toMatchObject({
			status: 'signed-in',
			account: { principalId: asPrincipalId('principal-1') },
		});
		// The verified grant and the ids the session reported are persisted.
		expect(storage.current).toEqual(persistedAuth());

		const sessionCall = calls.find(
			(call) => call.url === `${baseURL}/api/session`,
		);
		expect(sessionCall).toBeDefined();
		expect(new Headers(sessionCall?.init?.headers).get('authorization')).toBe(
			'Bearer access-1',
		);
		expect(sessionCall?.init?.credentials).toBe('omit');
	});

	test('a 401 from /api/session during sign-in fails sign-in and stays signed-out', async () => {
		const fetch: AuthFetch = async () => json({}, 401);
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(),
			launcher: completingLauncher(grant()),
			fetch,
		});

		const { error } = await auth.startSignIn();
		expect(error?.name).toBe('StartSignInFailed');
		expect(auth.state.status).toBe('signed-out');
	});

	test('an unreachable /api/session during sign-in fails sign-in', async () => {
		const fetch: AuthFetch = async () => {
			throw new Error('offline');
		};
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(),
			launcher: completingLauncher(grant()),
			fetch,
		});

		const { error } = await auth.startSignIn();
		expect(error?.name).toBe('StartSignInFailed');
		expect(auth.state.status).toBe('signed-out');
	});

	test('a fetch to the API verifies /api/session, then attaches the bearer (audience-scoped)', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(persistedAuth()),
			launcher: completingLauncher(grant()),
			fetch,
		});
		// Boots signed-in (unverified) from the persisted cell.
		expect(auth.state).toMatchObject({
			status: 'signed-in',
			account: { principalId: asPrincipalId('principal-1') },
		});

		await selectedAccount(auth).fetch('/api/blobs');

		const sessionCall = calls.find(
			(call) => call.url === `${baseURL}/api/session`,
		);
		expect(sessionCall).toBeDefined();
		const resourceCall = calls.find(
			(call) => call.url === `${baseURL}/api/blobs`,
		);
		expect(new Headers(resourceCall?.init?.headers).get('authorization')).toBe(
			'Bearer access-1',
		);
	});

	test('the bearer is never attached to a foreign origin', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetch: AuthFetch = async (input, init) => {
			calls.push({ url: String(input), init });
			return json(sessionBody());
		};
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(persistedAuth()),
			launcher: completingLauncher(grant()),
			fetch,
		});

		await expect(
			selectedAccount(auth).fetch(
				'https://someone-elses-inference.example.com/v1/models',
			),
		).rejects.toThrow('own server');
		const cross = calls.find(
			(call) =>
				call.url === 'https://someone-elses-inference.example.com/v1/models',
		);
		expect(new Headers(cross?.init?.headers).has('authorization')).toBe(false);
		// A foreign target never triggers a session verification.
		expect(calls.some((call) => call.url === `${baseURL}/api/session`)).toBe(
			false,
		);
	});

	test('a 401 from /api/session verification pauses network auth (reauth-required)', async () => {
		const fetch: AuthFetch = async (input) =>
			String(input).endsWith('/api/session') ? json({}, 401) : json({}, 200);
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(persistedAuth()),
			launcher: completingLauncher(grant()),
			fetch,
		});

		await expect(
			selectedAccount(auth).fetch('/api/blobs'),
		).rejects.toMatchObject({ code: 'reauth-required' });
		expect(auth.state).toMatchObject({
			status: 'reauth-required',
			account: { principalId: asPrincipalId('principal-1') },
		});
	});

	test('getProfile reads the user from /api/session', async () => {
		const fetch: AuthFetch = async () => json(sessionBody());
		const auth = createOAuthAppAuth({
			baseURL,
			clientId,
			persistedAuthStorage: inMemoryStorage(persistedAuth()),
			launcher: completingLauncher(grant()),
			fetch,
		});

		const { data, error } = await auth.getProfile();
		expect(error).toBeNull();
		expect(data).toEqual({
			id: asPrincipalId('principal-1'),
			email: 'principal-1@example.com',
		});
	});
});

function selectedAccount(auth: import('./auth-contract.js').AuthClient) {
	const state = auth.state;
	if (state.status === 'signed-out')
		throw new Error('Expected a selected account');
	return state.account;
}
