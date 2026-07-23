/**
 * Auth Client Contract Tests
 *
 * Pins the auth core side of the OAuth split. Launchers may return a token
 * grant, but only auth core can verify `/api/session`, persist identity, refresh
 * the grant, and attach bearer credentials to fetch or WebSocket transports.
 *
 * Covers:
 * - PersistedAuth = { grant, principalId } shape
 * - AuthState three variants; profile data is absent from state
 * - Refresh writes only grant, identity byte-identical
 * - Same-principal guard at /api/session response
 * - Network gate: bearer not attached until /api/session confirms same principal
 * - Cold-boot offline keeps signed-in with principalId and no profile field
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync/auth-subprotocol';
import { Ok, type Result } from 'wellcrafted/result';
// PersistedAuth and OAuthTokenGrant are intentionally not on the public root:
// they are the credential-shaped cell and grant, internal to auth core.
// Import them from their source module.
import type { OAuthTokenGrant, PersistedAuth } from './auth-types.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';
import type { AuthClient, PersistedAuthStorage } from './index.js';
import type { OAuthLaunchResult } from './oauth-launchers/contract.js';

const now = 1_000_000;

function grant({
	accessToken = 'access-token',
	refreshToken = 'refresh-token',
	accessTokenExpiresAt = now + 3_600_000,
}: Partial<OAuthTokenGrant> = {}): OAuthTokenGrant {
	return { accessToken, refreshToken, accessTokenExpiresAt };
}

function launched() {
	return Ok({ status: 'launched' } satisfies OAuthLaunchResult);
}

function completed(g: OAuthTokenGrant) {
	return Ok({ status: 'completed', grant: g } satisfies OAuthLaunchResult);
}

function cell({
	principalId = 'user-1',
	grant: g = grant(),
}: {
	principalId?: string;
	grant?: OAuthTokenGrant;
} = {}): PersistedAuth {
	return {
		grant: g,
		principalId: asPrincipalId(principalId),
	};
}

function createStorage(initial: PersistedAuth | null = null) {
	let current = initial;
	const saved: Array<PersistedAuth | null> = [];
	const storage: PersistedAuthStorage = {
		initial: current,
		set: async (next) => {
			current = next;
			saved.push(next);
		},
	};
	return {
		storage,
		saved,
		get current() {
			return current;
		},
	};
}

function json(value: unknown, init?: ResponseInit) {
	return new Response(JSON.stringify(value), {
		status: 200,
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});
}

function oauthTokenResponse({
	accessToken = 'new-access',
	refreshToken = 'new-refresh',
	expiresIn = 3600,
}: {
	accessToken?: string;
	refreshToken?: string | null;
	expiresIn?: number;
} = {}) {
	const body: Record<string, unknown> = {
		access_token: accessToken,
		expires_in: expiresIn,
		token_type: 'bearer',
	};
	if (refreshToken !== null) body['refresh_token'] = refreshToken;
	return json(body);
}

function apiSessionBody(principalId = 'user-1') {
	return {
		principalId,
		email: `${principalId}@example.com`,
	};
}

function createWebSocketRecorder() {
	const openings: Array<{ url: string; protocols: string[] }> = [];
	const WebSocketRecorder = class {
		constructor(url: string | URL, protocols: string[] = []) {
			openings.push({ url: String(url), protocols });
		}
	} as unknown as typeof WebSocket;

	return { openings, WebSocketRecorder };
}

test('signed-out by default; AuthClient satisfies the public contract', () => {
	const setup = createStorage(null);
	const auth: AuthClient = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
	});

	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('cold-boot signed-in exposes principalId immediately without profile data', () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
	});

	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('user-1'),
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('startSignIn calls /api/session and writes both sections', async () => {
	const setup = createStorage(null);
	const fetches: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'sign-in-access',
					refreshToken: 'sign-in-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input) => {
			fetches.push(String(input));
			return json(apiSessionBody('user-1'));
		},
	});

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(fetches[0]).toBe('http://localhost:8787/api/session');
	expect(setup.saved[0]).toEqual({
		grant: {
			accessToken: 'sign-in-access',
			refreshToken: 'sign-in-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		principalId: asPrincipalId('user-1'),
	});
	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	auth[Symbol.dispose]();
});

test('startSignIn with launched result does not install a session', async () => {
	const setup = createStorage(null);
	let fetches = 0;
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async () => {
			fetches += 1;
			return json(apiSessionBody('user-1'));
		},
	});

	const result = await auth.startSignIn();

	expect(result).toEqual(Ok(undefined));
	expect(fetches).toBe(0);
	expect(setup.saved).toEqual([]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('startSignIn publishes signed-out before installing a different principal', async () => {
	const setup = createStorage(cell({ principalId: 'alice' }));
	const states: string[] = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async () => json(apiSessionBody('bob')),
	});
	auth.onStateChange((state) => {
		states.push(
			state.status === 'signed-out'
				? 'signed-out'
				: `${state.status}:${state.principalId}`,
		);
	});

	const result = await auth.startSignIn();

	expect(result).toEqual(Ok(undefined));
	expect(states).toEqual(['signed-out', 'signed-in:bob']);
	expect(setup.saved).toEqual([
		null,
		{
			grant: {
				accessToken: 'bob-access',
				refreshToken: 'bob-refresh',
				accessTokenExpiresAt: now + 3_600_000,
			},
			principalId: asPrincipalId('bob'),
		},
	]);
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('bob'),
	});
	auth[Symbol.dispose]();
});

test('signOut during startSignIn prevents the in-flight grant from being installed', async () => {
	const setup = createStorage(null);
	let resolveApiSession!: (response: Response) => void;
	let markApiSessionRequested!: () => void;
	const apiSessionRequested = new Promise<void>((r) => {
		markApiSessionRequested = r;
	});
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				markApiSessionRequested();
				return apiSessionPromise;
			}
			return new Response(null, { status: 204 });
		},
	});

	const signInPromise = auth.startSignIn();
	await apiSessionRequested;
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveApiSession(json(apiSessionBody('bob')));
	expect(await signInPromise).toEqual(Ok(undefined));

	expect(setup.current).toBeNull();
	expect(setup.saved.at(-1)).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('concurrent startSignIn shares one launcher flight', async () => {
	const setup = createStorage(null);
	let signInAttempts = 0;
	let resolveLauncher!: (result: Result<OAuthLaunchResult, unknown>) => void;
	const launcherPromise = new Promise<Result<OAuthLaunchResult, unknown>>(
		(r) => {
			resolveLauncher = r;
		},
	);
	let apiSessionCalls = 0;
	let markLauncherStarted!: () => void;
	const launcherStarted = new Promise<void>((r) => {
		markLauncherStarted = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () => {
				signInAttempts += 1;
				markLauncherStarted();
				return launcherPromise;
			},
		},
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				apiSessionCalls += 1;
				return json(apiSessionBody('bob'));
			}
			return new Response(null, { status: 204 });
		},
	});

	const firstSignIn = auth.startSignIn();
	await launcherStarted;
	const secondSignIn = auth.startSignIn();

	expect(signInAttempts).toBe(1);
	resolveLauncher(
		completed({
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		}),
	);

	expect(await firstSignIn).toEqual(Ok(undefined));
	expect(await secondSignIn).toEqual(Ok(undefined));
	expect(apiSessionCalls).toBe(1);
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('bob'),
	});
	expect(setup.current).toEqual({
		grant: {
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		principalId: asPrincipalId('bob'),
	});
	auth[Symbol.dispose]();
});

for (const status of [401, 403] as const) {
	test(`/api/session ${status} pauses network auth without attaching a bearer`, async () => {
		const setup = createStorage(cell());
		const resourceAuths: Array<string | null> = [];
		const auth = createOAuthAppAuth({
			baseURL: 'http://localhost:8787',
			clientId: 'client-1',
			now: () => now,
			persistedAuthStorage: setup.storage,
			launcher: { startSignIn: async () => launched() },
			fetch: async (input, init) => {
				if (String(input).endsWith('/api/session')) {
					return new Response(null, { status });
				}
				resourceAuths.push(new Headers(init?.headers).get('authorization'));
				return new Response(null, { status: 204 });
			},
		});

		const response = await auth.fetch('http://localhost:8787/resource');

		expect(response.status).toBe(204);
		expect(resourceAuths).toEqual([null]);
		expect(auth.state).toEqual({
			status: 'reauth-required',
			principalId: asPrincipalId('user-1'),
		});
		expect(setup.current).toEqual(cell());
		auth[Symbol.dispose]();
	});
}

test('/api/session 503 leaves local auth signed-in without attaching a bearer', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				return new Response(null, { status: 503 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const response = await auth.fetch('http://localhost:8787/resource');

	expect(response.status).toBe(204);
	expect(resourceAuths).toEqual([null]);
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('user-1'),
	});
	expect(setup.current).toEqual(cell());
	auth[Symbol.dispose]();
});

test('stale /api/session verification after principal-switch sign-in cannot replace the new principal', async () => {
	const setup = createStorage(cell({ principalId: 'alice' }));
	let resolveOldApiSession!: (response: Response) => void;
	const oldApiSessionPromise = new Promise<Response>((r) => {
		resolveOldApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: {
			startSignIn: async () =>
				completed({
					accessToken: 'bob-access',
					refreshToken: 'bob-refresh',
					accessTokenExpiresAt: now + 3_600_000,
				}),
		},
		fetch: async (input, init) => {
			const authorization = new Headers(init?.headers).get('authorization');
			if (String(input).endsWith('/api/session')) {
				if (authorization === 'Bearer access-token') {
					return oldApiSessionPromise;
				}
				return json(apiSessionBody('bob'));
			}
			return new Response(null, { status: 204 });
		},
	});

	const staleFetch = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();

	const result = await auth.startSignIn();
	expect(result).toEqual(Ok(undefined));
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('bob'),
	});

	resolveOldApiSession(json(apiSessionBody('alice')));
	await staleFetch;

	expect(setup.current).toEqual({
		grant: {
			accessToken: 'bob-access',
			refreshToken: 'bob-refresh',
			accessTokenExpiresAt: now + 3_600_000,
		},
		principalId: asPrincipalId('bob'),
	});
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('bob'),
	});
	auth[Symbol.dispose]();
});

test('refresh writes ONLY the grant section; identity byte-identical', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	const last = setup.saved.at(-1);
	expect(last?.principalId).toEqual(initial.principalId);
	expect(last?.grant).toEqual({
		accessToken: 'new-access',
		refreshToken: 'new-refresh',
		accessTokenExpiresAt: now + 3_600_000,
	});
	auth[Symbol.dispose]();
});

test('refresh keeps existing refresh token when token response omits rotation', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	const setup = createStorage(initial);
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse({ refreshToken: null });
			}
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(setup.saved.at(-1)?.grant).toEqual({
		accessToken: 'new-access',
		refreshToken: 'refresh-token',
		accessTokenExpiresAt: now + 3_600_000,
	});
	auth[Symbol.dispose]();
});

test('same-principal guard wipes the cell when /api/session returns a different principal', async () => {
	const setup = createStorage(cell({ principalId: 'alice' }));
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('bob'));
			return new Response(null, { status: 204 });
		},
	});

	const response = await auth.fetch('http://localhost:8787/resource');
	expect(response.status).toBe(204);
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('getProfile reads the user through the bearer boundary', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) =>
			String(input).endsWith('/api/session')
				? json(apiSessionBody('user-1'))
				: new Response(null, { status: 404 }),
	});

	const { data, error } = await auth.getProfile();
	expect(error).toBeNull();
	expect(data).toEqual({
		id: asPrincipalId('user-1'),
		email: 'user-1@example.com',
	});
	auth[Symbol.dispose]();
});

test('a 401 from getProfile pauses network auth and reports unavailable', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) =>
			String(input).endsWith('/api/session')
				? new Response(null, { status: 401 })
				: new Response(null, { status: 404 }),
	});

	const { data, error } = await auth.getProfile();
	expect(data).toBeNull();
	expect(error?.name).toBe('ProfileUnavailable');
	expect(auth.state).toEqual({
		status: 'reauth-required',
		principalId: asPrincipalId('user-1'),
	});
	// A pause gates network access; the persisted cell survives for offline use.
	expect(setup.current).toEqual(cell());
	auth[Symbol.dispose]();
});

test('same-principal /api/session preserves state without rewriting identity', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(setup.current).toEqual(cell());
	expect(setup.saved).toEqual([]);
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	auth[Symbol.dispose]();
});

test('network gate: no Authorization header until /api/session confirms same principal', async () => {
	const setup = createStorage(cell());
	const seenAuth: Array<string | null> = [];
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			seenAuth.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	expect(seenAuth).toEqual([]);
	resolveApiSession(json(apiSessionBody('user-1')));
	await fetchPromise;
	expect(seenAuth).toEqual(['Bearer access-token']);
	auth[Symbol.dispose]();
});

test('auth.fetch resolves relative API paths against the auth base URL', async () => {
	const setup = createStorage(cell());
	const fetches: Array<{ url: string; authorization: string | null }> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			fetches.push({
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
			});
			return json(apiSessionBody('user-1'));
		},
	});

	const response = await auth.fetch('/api/session');
	expect(response.status).toBe(200);
	expect(fetches).toEqual([
		{
			url: 'http://localhost:8787/api/session',
			authorization: 'Bearer access-token',
		},
		{
			url: 'http://localhost:8787/api/session',
			authorization: 'Bearer access-token',
		},
	]);
	auth[Symbol.dispose]();
});

test('auth.fetch preserves iterable init headers when attaching bearer', async () => {
	const setup = createStorage(cell());
	const seenHeaders: Array<{
		authorization: string | null;
		custom: string | null;
	}> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				return json(apiSessionBody('user-1'));
			}
			const headers = new Headers(init?.headers);
			seenHeaders.push({
				authorization: headers.get('authorization'),
				custom: headers.get('x-custom'),
			});
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource', {
		headers: new Map([['x-custom', 'from-map']]) as unknown as HeadersInit,
	});

	expect(seenHeaders).toEqual([
		{
			authorization: 'Bearer access-token',
			custom: 'from-map',
		},
	]);
	auth[Symbol.dispose]();
});

test('network gate: no WebSocket bearer protocol until /api/session confirms same principal', async () => {
	const setup = createStorage(cell());
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			return new Response(null, { status: 204 });
		},
	});

	const socketPromise = auth.openWebSocket('ws://localhost:8787/sync', [
		'epicenter.v1',
	]);
	await Promise.resolve();
	expect(openings).toEqual([]);
	resolveApiSession(json(apiSessionBody('user-1')));
	await socketPromise;
	expect(openings).toEqual([
		{
			url: 'ws://localhost:8787/sync',
			protocols: ['epicenter.v1', `${BEARER_SUBPROTOCOL_PREFIX}access-token`],
		},
	]);
	auth[Symbol.dispose]();
});

test('openWebSocket rejects with a permanent denial when signed out', async () => {
	const setup = createStorage(null);
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async () => new Response(null, { status: 204 }),
	});

	await expect(
		auth.openWebSocket('ws://localhost:8787/sync'),
	).rejects.toMatchObject({
		name: 'OpenWebSocketDenied',
		permanence: 'permanent',
		code: 'signed-out',
	});
	expect(openings).toEqual([]);
	auth[Symbol.dispose]();
});

test('openWebSocket rejects with a permanent denial after /api/session rejects the cell', async () => {
	const setup = createStorage(cell());
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				return new Response(null, { status: 401 });
			}
			return new Response(null, { status: 204 });
		},
	});

	await expect(
		auth.openWebSocket('ws://localhost:8787/sync'),
	).rejects.toMatchObject({
		name: 'OpenWebSocketDenied',
		permanence: 'permanent',
		code: 'reauth-required',
	});
	await Promise.resolve();
	expect(openings).toEqual([]);
	auth[Symbol.dispose]();
});

test('openWebSocket rejects with a permanent denial when a stale grant cannot refresh', async () => {
	// Pins current auth-core behavior: refreshGrant pauses network auth on ANY
	// thrown refresh failure, including a transport outage, so a stale grant
	// with an unreachable token endpoint lands in reauth-required and denies
	// permanently. If the gate ever distinguishes refresh outage from refresh
	// rejection, this case should flip to a transient denial.
	const setup = createStorage(
		cell({ grant: grant({ accessTokenExpiresAt: now - 1 }) }),
	);
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async () => {
			throw new Error('token endpoint unreachable');
		},
	});

	await expect(
		auth.openWebSocket('ws://localhost:8787/sync'),
	).rejects.toMatchObject({
		name: 'OpenWebSocketDenied',
		permanence: 'permanent',
		code: 'reauth-required',
	});
	expect(auth.state.status).toBe('reauth-required');
	expect(openings).toEqual([]);
	auth[Symbol.dispose]();
});

test('openWebSocket rejects with a transient denial when /api/session is unreachable', async () => {
	const setup = createStorage(cell());
	const { openings, WebSocketRecorder } = createWebSocketRecorder();
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		WebSocket: WebSocketRecorder,
		fetch: async () => {
			throw new Error('offline');
		},
	});

	await expect(
		auth.openWebSocket('ws://localhost:8787/sync'),
	).rejects.toMatchObject({
		name: 'OpenWebSocketDenied',
		permanence: 'transient',
		code: 'auth-unavailable',
	});
	await Promise.resolve();
	// Offline verification is not a rejection: the cell stays signed-in.
	expect(auth.state.status).toBe('signed-in');
	expect(openings).toEqual([]);
	auth[Symbol.dispose]();
});

test('cold-boot offline keeps signed-in with cached principalId and no profile field', async () => {
	const setup = createStorage(cell());
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async () => {
			throw new Error('offline');
		},
	});

	expect(auth.state).toMatchObject({
		status: 'signed-in',
	});
	expect('email' in auth.state).toBe(false);
	expect(auth.state).toMatchObject({
		principalId: asPrincipalId('user-1'),
	});
	auth[Symbol.dispose]();
});

test('signOut clears cell and network pause even when revoke fails', async () => {
	const setup = createStorage(cell());
	const originalConsoleError = console.error;
	console.error = () => undefined;
	let markRevokeStarted!: () => void;
	let resolveRevoke!: () => void;
	const revokeStarted = new Promise<void>((r) => {
		markRevokeStarted = r;
	});
	const revokePromise = new Promise<void>((resolve) => {
		resolveRevoke = resolve;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session'))
				return json(apiSessionBody('user-1'));
			if (String(input).endsWith('/auth/oauth2/token')) {
				return new Response(null, { status: 503 });
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				markRevokeStarted();
				await revokePromise;
				return new Response(null, { status: 503 });
			}
			return new Response(null, { status: 401 });
		},
	});

	try {
		await auth.fetch('http://localhost:8787/resource');
		expect(auth.state).toEqual({
			status: 'reauth-required',
			principalId: asPrincipalId('user-1'),
		});
		expect('email' in auth.state).toBe(false);

		const signOutPromise = auth.signOut();
		await Promise.resolve();
		expect(setup.current).toBeNull();
		expect(auth.state).toEqual({ status: 'signed-out' });
		expect(await signOutPromise).toEqual(Ok(undefined));
		await revokeStarted;
		resolveRevoke();
		await Promise.resolve();
	} finally {
		console.error = originalConsoleError;
		auth[Symbol.dispose]();
	}
});

test('network verification clears on grant refresh until /api/session confirms new cell', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	const apiSessionAuths: Array<string | null> = [];
	let apiSessionCalls = 0;
	let resolveSecondApiSession!: (response: Response) => void;
	let markSecondApiSessionRequested!: () => void;
	const secondApiSessionPromise = new Promise<Response>((r) => {
		resolveSecondApiSession = r;
	});
	const secondApiSessionRequested = new Promise<void>((r) => {
		markSecondApiSessionRequested = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			const authorization = new Headers(init?.headers).get('authorization');
			if (String(input).endsWith('/api/session')) {
				apiSessionCalls += 1;
				apiSessionAuths.push(authorization);
				if (apiSessionCalls === 1) return json(apiSessionBody('user-1'));
				markSecondApiSessionRequested();
				return secondApiSessionPromise;
			}
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			resourceAuths.push(authorization);
			if (resourceAuths.length === 2)
				return new Response(null, { status: 401 });
			return new Response(null, { status: 204 });
		},
	});

	await auth.fetch('http://localhost:8787/resource');
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	expect('email' in auth.state).toBe(false);

	const retryPromise = auth.fetch('http://localhost:8787/resource');
	await secondApiSessionRequested;
	expect(auth.state).toEqual({
		status: 'signed-in',
		principalId: asPrincipalId('user-1'),
	});
	expect('email' in auth.state).toBe(false);
	expect(resourceAuths).toEqual(['Bearer access-token', 'Bearer access-token']);
	expect(apiSessionAuths).toEqual(['Bearer access-token', 'Bearer new-access']);

	resolveSecondApiSession(json(apiSessionBody('user-1')));
	await retryPromise;
	expect(auth.state).toMatchObject({ status: 'signed-in' });
	expect('email' in auth.state).toBe(false);
	expect(resourceAuths).toEqual([
		'Bearer access-token',
		'Bearer access-token',
		'Bearer new-access',
	]);
	auth[Symbol.dispose]();
});

test('concurrent refresh shares one promise and signOut during refresh wins', async () => {
	const setup = createStorage(
		cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) }),
	);
	const resourceAuths: Array<string | null> = [];
	let refreshCalls = 0;
	let markRefreshStarted!: () => void;
	let resolveRefresh!: (response: Response) => void;
	const refreshStarted = new Promise<void>((r) => {
		markRefreshStarted = r;
	});
	const refreshPromise = new Promise<Response>((r) => {
		resolveRefresh = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/oauth2/token')) {
				refreshCalls += 1;
				markRefreshStarted();
				return refreshPromise;
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const firstFetch = auth.fetch('http://localhost:8787/first');
	const secondFetch = auth.fetch('http://localhost:8787/second');
	await refreshStarted;
	expect(refreshCalls).toBe(1);
	expect(resourceAuths).toEqual([]);

	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveRefresh(oauthTokenResponse());
	await Promise.all([firstFetch, secondFetch]);
	expect(setup.current).toBeNull();
	expect(resourceAuths).toEqual([null, null]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('signOut remains the final storage write when refresh persistence is in flight', async () => {
	const initial = cell({ grant: grant({ accessTokenExpiresAt: now + 1 }) });
	let current: PersistedAuth | null = initial;
	const saved: Array<PersistedAuth | null> = [];
	let markRefreshWriteStarted!: () => void;
	let resolveRefreshWrite!: () => void;
	const refreshWriteStarted = new Promise<void>((r) => {
		markRefreshWriteStarted = r;
	});
	const refreshWriteCanFinish = new Promise<void>((r) => {
		resolveRefreshWrite = r;
	});
	const storage: PersistedAuthStorage = {
		initial: current,
		set: async (next) => {
			if (next?.grant.accessToken === 'new-access') {
				markRefreshWriteStarted();
				await refreshWriteCanFinish;
			}
			current = next;
			saved.push(next);
		},
	};
	const resourceAuths: Array<string | null> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/oauth2/token')) {
				return oauthTokenResponse();
			}
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await refreshWriteStarted;
	const signOutPromise = auth.signOut();
	await Promise.resolve();

	resolveRefreshWrite();
	await Promise.all([fetchPromise, signOutPromise]);

	expect(current).toBeNull();
	expect(saved.at(-1)).toBeNull();
	expect(resourceAuths).toEqual([null]);
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

test('/api/session response after signOut is discarded without corrupting state', async () => {
	const setup = createStorage(cell());
	const resourceAuths: Array<string | null> = [];
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			resourceAuths.push(new Headers(init?.headers).get('authorization'));
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });

	resolveApiSession(json(apiSessionBody('user-1')));
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(auth.state).toEqual({ status: 'signed-out' });
	expect(resourceAuths).toEqual([null]);
	auth[Symbol.dispose]();
});

test('/api/session identity update after signOut is discarded without writing identity', async () => {
	const setup = createStorage(cell());
	let resolveApiSession!: (response: Response) => void;
	const apiSessionPromise = new Promise<Response>((r) => {
		resolveApiSession = r;
	});
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) return apiSessionPromise;
			if (String(input).endsWith('/auth/oauth2/revoke')) {
				const body = new URLSearchParams(String(init?.body ?? ''));
				expect(body.get('token')).toBe('refresh-token');
				return new Response(null, { status: 200 });
			}
			return new Response(null, { status: 204 });
		},
	});

	const fetchPromise = auth.fetch('http://localhost:8787/resource');
	await Promise.resolve();
	const signOutResult = await auth.signOut();
	expect(signOutResult).toEqual(Ok(undefined));

	resolveApiSession(
		json({
			principalId: 'user-2',
			email: 'user-2@example.com',
		}),
	);
	await fetchPromise;
	expect(setup.current).toBeNull();
	expect(setup.saved).not.toContainEqual({
		grant: grant(),
		principalId: asPrincipalId('user-2'),
	});
	expect(auth.state).toEqual({ status: 'signed-out' });
	auth[Symbol.dispose]();
});

// The load-bearing audience-scoping guard (ADR-0053): the Epicenter bearer is
// attached only to the origin this client signed into. Handing `auth.fetch` to a
// custom inference backend (a local Ollama, a third-party gateway) must never
// leak the token, and a bearer request must not follow a cross-origin redirect.
test('audience-scoped bearer: the Epicenter token never reaches a foreign origin', async () => {
	const setup = createStorage(cell());
	const seen: Array<{
		url: string;
		authorization: string | null;
		redirect: RequestRedirect | undefined;
	}> = [];
	const auth = createOAuthAppAuth({
		baseURL: 'http://localhost:8787',
		clientId: 'client-1',
		now: () => now,
		persistedAuthStorage: setup.storage,
		launcher: { startSignIn: async () => launched() },
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				return json(apiSessionBody('user-1'));
			}
			seen.push({
				url: String(input),
				authorization: new Headers(init?.headers).get('authorization'),
				redirect: init?.redirect,
			});
			return new Response(null, { status: 204 });
		},
	});

	// Same origin (the Epicenter gateway): bearer attached, redirect pinned manual.
	await auth.fetch('http://localhost:8787/v1/chat/completions', {
		method: 'POST',
	});
	// Foreign origin (a custom backend, e.g. a local Ollama): no bearer at all.
	await auth.fetch('http://localhost:11434/v1/chat/completions', {
		method: 'POST',
	});

	expect(seen).toEqual([
		{
			url: 'http://localhost:8787/v1/chat/completions',
			authorization: 'Bearer access-token',
			redirect: 'manual',
		},
		{
			url: 'http://localhost:11434/v1/chat/completions',
			authorization: null,
			redirect: undefined,
		},
	]);
	auth[Symbol.dispose]();
});
