/**
 * The browser OAuth client against a fake authorization server: PKCE sign-in,
 * the shared token cell, silent renewal by top-level navigation, the Account's
 * bearer, and sign-out.
 */
import { describe, expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { createLogger, memorySink } from 'wellcrafted/logger';
import { expectOk } from 'wellcrafted/testing';
import { type AuthState, isCallbackAuthClient } from './auth-contract.js';
import { epicenterCloud } from './auth-server.js';
import {
	type CreateBrowserOAuthOptions,
	createBrowserOAuth,
} from './browser-oauth.js';
import { fromAuth } from './svelte/auth.svelte.js';

const SERVER = 'https://api.test';
const APP = 'https://todos.test';
const CLIENT_ID = 'so.epicenter.todos';
// The hosted cloud serves Git from an origin of its own.
const RESOURCE = 'https://git.test';
const SCOPE = 'openid folders:read folders:write';
const REDIRECT_URI = `${APP}/auth/callback`;
const TOKEN_KEY = `${CLIENT_ID}.oauth:${SERVER}`;
const HOUR = 60 * 60_000;
const MINUTE = 60_000;

function createMemoryStorage() {
	const cells = new Map<string, string>();
	return {
		cells,
		getItem: (key: string) => cells.get(key) ?? null,
		setItem: (key: string, value: string) => void cells.set(key, value),
		removeItem: (key: string) => void cells.delete(key),
	};
}

async function sha256(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}

type Grant = { sub: string; resources: string[] };

/** One origin's shared storage, clock, and authorization server. */
function createWorld({
	principal = 'alice',
	revoke = async () => new Response(null, { status: 200 }),
	resources = [RESOURCE],
}: {
	principal?: string;
	revoke?: () => Promise<Response>;
	resources?: CreateBrowserOAuthOptions['resources'];
} = {}) {
	const storage = createMemoryStorage();
	let clock = 1_000_000;
	const codes = new Map<
		string,
		Grant & { challenge: string; offline: boolean }
	>();
	const refreshTokens = new Map<string, Grant>();
	const issued = new Map<string, string>();
	const requests: { url: string; init?: RequestInit }[] = [];
	const tokenForms: URLSearchParams[] = [];
	const revoked: URLSearchParams[] = [];
	let tokenCount = 0;
	let refreshCount = 0;
	const server = {
		principal,
		resourceStatus: 200,
		/** Access tokens a resource answers 401 for. */
		refusedTokens: new Set<string>(),
		/** Answer the token request with this number (from 1) with a 500. */
		failTokenRequest: 0,
		/** Answer the authorize URL the client navigated to, as a logged-in server would. */
		authorize(
			authorizeUrl: string,
			answer: 'code' | 'login_required' = 'code',
		) {
			const url = new URL(authorizeUrl);
			const params = url.searchParams;
			const callback = new URL(params.get('redirect_uri')!);
			callback.searchParams.set('state', params.get('state')!);
			if (answer === 'login_required') {
				callback.searchParams.set('error', 'login_required');
				return callback.href;
			}
			const code = `code-${codes.size + 1}`;
			codes.set(code, {
				challenge: params.get('code_challenge')!,
				sub: server.principal,
				resources: params.getAll('resource'),
				offline: params.get('scope')!.split(' ').includes('offline_access'),
			});
			callback.searchParams.set('code', code);
			return callback.href;
		},
	};
	/** Issue an access token, and a rotated refresh token for an offline grant. */
	function issue(grant: Grant, offline: boolean) {
		const token = `token-${++tokenCount}`;
		issued.set(token, grant.sub);
		const refresh = offline ? `ep_rt_${++refreshCount}` : undefined;
		if (refresh) refreshTokens.set(refresh, grant);
		return Response.json({
			access_token: token,
			token_type: 'Bearer',
			expires_in: 8 * 60 * 60,
			...(refresh && { refresh_token: refresh }),
		});
	}
	const fetch = async (input: Request | string | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		requests.push({ url: url.href, init });
		const bearer = new Headers(
			input instanceof Request ? input.headers : init?.headers,
		)
			.get('authorization')
			?.replace('Bearer ', '');
		if (bearer && server.refusedTokens.has(bearer))
			return new Response(null, { status: 401 });
		if (url.origin !== SERVER) return new Response('elsewhere');
		if (url.pathname === '/auth/oauth2/token') {
			const form = new URLSearchParams(String(init?.body));
			tokenForms.push(form);
			if (tokenForms.length === server.failTokenRequest)
				return Response.json({ error: 'server_error' }, { status: 500 });
			const invalid = () =>
				Response.json({ error: 'invalid_grant' }, { status: 400 });
			if (form.get('client_id') !== CLIENT_ID || form.has('scope'))
				return invalid();
			const resource = form.get('resource') ?? '';
			if (form.get('grant_type') === 'refresh_token') {
				const grant = refreshTokens.get(form.get('refresh_token') ?? '');
				refreshTokens.delete(form.get('refresh_token') ?? '');
				if (!grant?.resources.includes(resource)) return invalid();
				return issue(grant, true);
			}
			const grant = codes.get(form.get('code') ?? '');
			codes.delete(form.get('code') ?? '');
			if (
				!grant ||
				form.get('grant_type') !== 'authorization_code' ||
				form.get('redirect_uri') !== REDIRECT_URI ||
				!grant.resources.includes(resource) ||
				(await sha256(form.get('code_verifier') ?? '')) !== grant.challenge
			)
				return invalid();
			return issue(grant, grant.offline);
		}
		if (url.pathname === '/auth/oauth2/userinfo') {
			const token = new Headers(init?.headers)
				.get('authorization')
				?.replace('Bearer ', '');
			const sub = token && issued.get(token);
			if (!sub) return new Response(null, { status: 401 });
			return Response.json({ sub });
		}
		if (url.pathname === '/auth/oauth2/revoke') {
			revoked.push(new URLSearchParams(String(init?.body)));
			return revoke();
		}
		return new Response(null, { status: server.resourceStatus });
	};
	const logs = memorySink();
	const timers: { callback: () => void; at: number; cleared: boolean }[] = [];
	const watchers = new Set<() => void>();

	/** One tab: its own location, attempt storage, and timers. */
	function openTab(path = '/') {
		const assigned: string[] = [];
		const location = {
			href: `${APP}${path}`,
			origin: APP,
			assign: (url: string) => void assigned.push(url),
			replace(url: string) {
				location.href = url;
			},
		};
		const options: CreateBrowserOAuthOptions = {
			server: epicenterCloud(SERVER),
			clientId: CLIENT_ID,
			resources,
			scope: SCOPE,
			accountManagement: false,
			storage,
			attemptStorage: createMemoryStorage(),
			location,
			fetch,
			log: createLogger('auth/browser-oauth', logs.sink),
			now: () => clock,
			schedule(callback, ms) {
				const timer = { callback, at: clock + ms, cleared: false };
				timers.push(timer);
				return () => {
					timer.cleared = true;
				};
			},
			watchStorage(onChange) {
				watchers.add(onChange);
				return () => watchers.delete(onChange);
			},
		};
		return {
			location,
			assigned,
			options,
			create: () => createBrowserOAuth(options),
		};
	}

	return {
		storage,
		server,
		logs: logs.events,
		requests,
		tokenForms,
		revoked,
		fetch,
		openTab,
		advance(ms: number) {
			clock += ms;
			for (const timer of timers.filter((t) => !t.cleared && t.at <= clock)) {
				timer.cleared = true;
				timer.callback();
			}
		},
		/** Another tab wrote storage: deliver the `storage` event. */
		notify() {
			for (const watcher of watchers) watcher();
		},
		pendingTimers: () => timers.filter((t) => !t.cleared),
	};
}

/** Sign one tab in through the callback, then open its working page. */
async function signIn(world: ReturnType<typeof createWorld>, path = '/notes') {
	const tab = world.openTab(path);
	const auth = tab.create();
	expectOk(await auth.startSignIn());
	tab.location.href = world.server.authorize(tab.assigned.at(-1)!);
	const callbackAuth = tab.create();
	const result = await callbackAuth.completeSignIn();
	auth[Symbol.dispose]();
	callbackAuth[Symbol.dispose]();
	tab.location.href = `${APP}${expectOk(result).returnTo ?? '/'}`;
	return { tab, auth: tab.create(), result };
}

test('the Svelte facade retains the browser callback capability', () => {
	const world = createWorld();
	using client = world.openTab('/').create();
	const auth = fromAuth(client);
	expect('getState' in auth).toBe(false);
	expect(isCallbackAuthClient(auth)).toBe(true);
	expect(typeof auth.completeSignIn).toBe('function');
	expect(typeof auth.refresh).toBe('function');
});

test('sign-in navigates to the authorize endpoint with PKCE as the app client', async () => {
	const world = createWorld();
	const tab = world.openTab('/list?filter=open#top');
	using auth = tab.create();

	expectOk(await auth.startSignIn());

	expect(tab.assigned).toHaveLength(1);
	const url = new URL(tab.assigned[0]!);
	expect(url.origin + url.pathname).toBe(`${SERVER}/auth/oauth2/authorize`);
	const params = url.searchParams;
	expect(params.get('response_type')).toBe('code');
	expect(params.get('client_id')).toBe(CLIENT_ID);
	expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
	expect(params.get('scope')).toBe(SCOPE);
	expect(params.getAll('resource')).toEqual([RESOURCE]);
	expect(params.get('code_challenge_method')).toBe('S256');
	expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(params.has('prompt')).toBe(false);
	expect(params.get('scope')).not.toContain('offline_access');
	expect(auth.getState().status).toBe('signed-out');
});

test('a browser client refuses offline_access', () => {
	const world = createWorld();
	const tab = world.openTab();
	expect(() =>
		createBrowserOAuth({ ...tab.options, scope: 'openid offline_access' }),
	).toThrow(TypeError);
});

test('completing sign-in exchanges the code, stores the token, and returns where it started', async () => {
	const world = createWorld();
	const { auth, result } = await signIn(world, '/list?filter=open#top');

	expect(expectOk(result)).toEqual({ returnTo: '/list?filter=open#top' });
	const state = auth.getState();
	expect(state.status).toBe('signed-in');
	expect(state.account?.principalId).toBe(asPrincipalId('alice'));
	expect(state.account?.authorityId).toBe('epicenter-api');
	const stored = JSON.parse(world.storage.getItem(TOKEN_KEY)!);
	expect(stored).toEqual({
		tokens: {
			[RESOURCE]: { accessToken: 'token-1', expiresAt: 1_000_000 + 8 * HOUR },
		},
		principalId: 'alice',
		generation: expect.any(String),
	});
	// One resource: one code exchange, and no refresh token is asked for.
	expect(world.tokenForms.map((form) => [...form.keys()])).toEqual([
		[
			'grant_type',
			'client_id',
			'code',
			'code_verifier',
			'redirect_uri',
			'resource',
		],
	]);
	expect(world.tokenForms[0]!.get('resource')).toBe(RESOURCE);
	const tokenRequest = world.requests.find((r) =>
		r.url.endsWith('/auth/oauth2/token'),
	)!;
	expect(tokenRequest.init?.credentials).toBe('omit');
	auth[Symbol.dispose]();
});

test('a mismatched state is refused and spends the attempt', async () => {
	const world = createWorld();
	const tab = world.openTab();
	const auth = tab.create();
	expectOk(await auth.startSignIn());
	const answer = new URL(world.server.authorize(tab.assigned[0]!));
	answer.searchParams.set('state', 'forged');
	tab.location.href = answer.href;

	const { error } = await tab.create().completeSignIn();
	expect(error?.name).toBe('CompleteSignInFailed');

	// The real state no longer matches: the attempt was single use.
	answer.searchParams.set(
		'state',
		new URL(tab.assigned[0]!).searchParams.get('state')!,
	);
	tab.location.href = answer.href;
	const replay = await tab.create().completeSignIn();
	expect(replay.error?.name).toBe('CompleteSignInFailed');
	expect(world.storage.getItem(TOKEN_KEY)).toBeNull();
});

test('a replayed callback is refused, and duplicate completions in one page share one result', async () => {
	const world = createWorld();
	const tab = world.openTab();
	expectOk(await tab.create().startSignIn());
	tab.location.href = world.server.authorize(tab.assigned[0]!);

	using auth = tab.create();
	const [first, second] = await Promise.all([
		auth.completeSignIn(),
		auth.completeSignIn(),
	]);
	expectOk(first);
	expect(second).toBe(first);

	const replay = await tab.create().completeSignIn();
	expect(replay.error?.name).toBe('CompleteSignInFailed');
});

test('an expired attempt is refused', async () => {
	const world = createWorld();
	const tab = world.openTab();
	expectOk(await tab.create().startSignIn());
	tab.location.href = world.server.authorize(tab.assigned[0]!);
	world.advance(10 * MINUTE);
	const { error } = await tab.create().completeSignIn();
	expect(error?.name).toBe('CompleteSignInFailed');
});

test('a second tab shares the stored token and follows another tab through storage events', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	using second = world.openTab().create();
	expect(second.getState().account?.principalId).toBe(asPrincipalId('alice'));

	const seen: AuthState['status'][] = [];
	second.onStateChange((state) => seen.push(state.status));
	expectOk(await first.signOut());
	world.notify();
	expect(second.getState().status).toBe('signed-out');
	expect(seen).toEqual(['signed-out']);
	first[Symbol.dispose]();
});

test('refresh catches a missed storage event before a new request', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	using second = world.openTab().create();
	const oldAccount = second.getState().account!;

	expectOk(await first.signOut());
	expect(second.getState().account).toBe(oldAccount);
	await second.refresh();
	expect(second.getState().status).toBe('signed-out');
	await expect(oldAccount.fetch('/api/thing')).rejects.toBeDefined();
	first[Symbol.dispose]();
});

test('an Account sends the token another tab renewed and survives the renewal', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	using second = world.openTab().create();
	const account = second.getState().account!;

	// The first tab renews (same person, new token) without the second tab's
	// storage event having arrived yet.
	await signIn(world);
	await account.fetch('/api/thing');
	const sent = world.requests.at(-1)!;
	expect(new Headers(sent.init?.headers).get('authorization')).toBe(
		'Bearer token-2',
	);
	expect(second.getState().account).toBe(account);
	expect(account.signal.aborted).toBe(false);
	first[Symbol.dispose]();
});

test('a missed sign-out followed by the same person signing in retires the old Account', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	using second = world.openTab().create();
	const oldAccount = second.getState().account!;

	// The second tab has not processed a storage event when Alice signs out
	// and signs back in. Its next request must not borrow the new attachment.
	expectOk(await first.signOut());
	await signIn(world);
	await expect(oldAccount.fetch('/api/thing')).rejects.toBeDefined();
	expect(second.getState().account).not.toBe(oldAccount);
});

test('another person signing in from another tab retires the earlier Account', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	using second = world.openTab().create();
	const alice = second.getState().account!;

	world.server.principal = 'bob';
	await signIn(world);
	world.notify();

	expect(second.getState().account?.principalId).toBe(asPrincipalId('bob'));
	await expect(alice.fetch('/api/thing')).rejects.toBeDefined();
	expect(alice.signal.aborted).toBe(true);
	first[Symbol.dispose]();
});

test('a missing or corrupt cell is signed out and never redirects', () => {
	const world = createWorld();
	world.storage.setItem(TOKEN_KEY, '{not json');
	const tab = world.openTab();
	using auth = tab.create();
	expect(auth.getState().status).toBe('signed-out');
	expect(tab.assigned).toEqual([]);
	expect(world.pendingTimers()).toEqual([]);
});

test('a token within ten minutes of expiry renews at construction with prompt=none', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	world.advance(8 * HOUR - 9 * MINUTE);

	const tab = world.openTab('/notes');
	using auth = tab.create();
	await Bun.sleep(0);

	expect(tab.assigned).toHaveLength(1);
	const url = new URL(tab.assigned[0]!);
	expect(url.pathname).toBe('/auth/oauth2/authorize');
	expect(url.searchParams.get('prompt')).toBe('none');
	expect(url.searchParams.get('code_challenge_method')).toBe('S256');
	// Still signed in while it leaves: the token has not expired.
	expect(auth.getState().status).toBe('signed-in');

	tab.location.href = world.server.authorize(tab.assigned[0]!);
	const callback = tab.create();
	expect(expectOk(await callback.completeSignIn())).toEqual({
		returnTo: '/notes',
	});
	expect(
		JSON.parse(world.storage.getItem(TOKEN_KEY)!).tokens[RESOURCE].accessToken,
	).toBe('token-2');
	callback[Symbol.dispose]();
});

test('the renewal timer navigates with prompt=none ten minutes before expiry', async () => {
	const world = createWorld();
	const { tab, auth } = await signIn(world);
	tab.location.href = `${APP}/notes`;
	const before = tab.assigned.length;

	world.advance(8 * HOUR - 11 * MINUTE);
	expect(tab.assigned).toHaveLength(before);
	world.advance(1 * MINUTE);
	world.notify();
	const account = auth.getState().account;
	if (!account) throw new Error('Expected a signed-in account');
	await account.fetch('/api/repos');
	await Bun.sleep(0);

	expect(tab.assigned).toHaveLength(before + 1);
	expect(new URL(tab.assigned.at(-1)!).searchParams.get('prompt')).toBe('none');
	world.advance(0);
	await Bun.sleep(0);
	expect(tab.assigned).toHaveLength(before + 1);
	expect(world.pendingTimers()).toEqual([]);
	auth[Symbol.dispose]();
});

test('an app can keep a working page open until the person explicitly renews', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	world.advance(8 * HOUR - 9 * MINUTE);
	const tab = world.openTab('/recordings');
	using auth = createBrowserOAuth({ ...tab.options, automaticRenewal: false });
	expect(auth.getState().status).toBe('signed-in');
	expect(world.pendingTimers()).toEqual([]);
	await auth.getState().account!.fetch('/api/thing');
	await Bun.sleep(0);
	expect(tab.assigned).toEqual([]);
	expectOk(await auth.startSignIn());
	expect(tab.assigned).toHaveLength(1);
});

test('a callback with the previous token near expiry never starts another renewal', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	world.advance(8 * HOUR - 9 * MINUTE);
	const tab = world.openTab('/notes');
	const leaving = tab.create();
	await Bun.sleep(0);
	expect(tab.assigned).toHaveLength(1);
	tab.location.href = world.server.authorize(tab.assigned[0]!);
	leaving[Symbol.dispose]();
	using callback = tab.create();
	world.advance(0);
	await Bun.sleep(0);
	expect(tab.assigned).toHaveLength(1);
	expectOk(await callback.completeSignIn());
});

test('a failed automatic renewal is logged and an explicit sign-in can retry', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	world.advance(8 * HOUR - 9 * MINUTE);
	const tab = world.openTab('/notes');
	const storage = tab.options.attemptStorage;
	if (!storage) throw new Error('Expected attempt storage');
	const save = storage.setItem;
	let refuse = true;
	storage.setItem = (key, value) => {
		if (refuse) {
			refuse = false;
			throw new Error('Storage unavailable');
		}
		save(key, value);
	};
	using auth = tab.create();
	await Bun.sleep(0);
	expect(tab.assigned).toEqual([]);
	expect(world.logs.map((event) => event.message)).toEqual([
		'Silent access-token renewal failed.',
	]);
	expectOk(await auth.startSignIn());
	expect(tab.assigned).toHaveLength(1);
});

test('the renewal timer reschedules instead of navigating when another tab already renewed', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	const waiting = world.openTab('/notes');
	using auth = waiting.create();

	world.advance(8 * HOUR - 15 * MINUTE);
	// Another tab renews; this tab's storage event is lost.
	await signIn(world);
	world.advance(5 * MINUTE);
	await Bun.sleep(0);

	expect(waiting.assigned).toEqual([]);
	expect(auth.getState().status).toBe('signed-in');
	expect(world.pendingTimers().length).toBeGreaterThan(0);
	first[Symbol.dispose]();
});

test('login_required from the silent renewal clears to signed-out and goes back', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	world.advance(8 * HOUR - 5 * MINUTE);

	const tab = world.openTab('/notes');
	using auth = tab.create();
	await Bun.sleep(0);
	tab.location.href = world.server.authorize(
		tab.assigned[0]!,
		'login_required',
	);

	using callback = tab.create();
	expect(expectOk(await callback.completeSignIn())).toEqual({
		returnTo: '/notes',
	});
	expect(callback.getState().status).toBe('signed-out');
	expect(world.storage.getItem(TOKEN_KEY)).toBeNull();
	world.notify();
	expect(auth.getState().status).toBe('signed-out');
});

test('a late login_required cannot clear a newer sign-in from another tab', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	world.advance(8 * HOUR - 5 * MINUTE);
	const tab = world.openTab('/notes');
	const leaving = tab.create();
	await Bun.sleep(0);
	tab.location.href = world.server.authorize(
		tab.assigned[0]!,
		'login_required',
	);
	leaving[Symbol.dispose]();

	expectOk(await first.signOut());
	await signIn(world);
	const newer = world.storage.getItem(TOKEN_KEY);
	using callback = tab.create();
	expectOk(await callback.completeSignIn());
	expect(world.storage.getItem(TOKEN_KEY)).toBe(newer);
	expect(callback.getState().status).toBe('signed-in');
});

test('an unsolicited login_required callback cannot sign the person out', async () => {
	const world = createWorld();
	const { auth: first } = await signIn(world);
	first[Symbol.dispose]();
	const tab = world.openTab('/auth/callback?error=login_required&state=forged');
	using auth = tab.create();
	expect((await auth.completeSignIn()).error?.name).toBe(
		'CompleteSignInFailed',
	);
	expect(world.storage.getItem(TOKEN_KEY)).not.toBeNull();
});

test('getProfile reads userinfo with the account token', async () => {
	const world = createWorld();
	const { auth } = await signIn(world);
	const { data: profile, error } = await auth.getProfile();
	expect(error).toBeNull();
	expect(profile?.id).toBe(auth.getState().account!.principalId);
	const sent = world.requests.at(-1)!;
	expect(sent.url).toBe(`${SERVER}/auth/oauth2/userinfo`);
	expect(new Headers(sent.init?.headers).get('authorization')).toBe(
		'Bearer token-1',
	);
});

test("Account.fetch attaches the bearer only for its own server and its token's resource", async () => {
	const world = createWorld();
	const { auth } = await signIn(world);
	const account = auth.getState().account!;

	await account.fetch('/api/repos', {
		headers: { cookie: 'session=ambient', authorization: 'Bearer caller' },
	});
	const sent = world.requests.at(-1)!;
	expect(sent.url).toBe(`${SERVER}/api/repos`);
	const headers = new Headers(sent.init?.headers);
	expect(headers.get('authorization')).toBe('Bearer token-1');
	expect(headers.has('cookie')).toBe(false);
	expect(sent.init?.credentials).toBe('omit');
	expect(sent.init?.redirect).toBe('manual');

	await account.fetch(`${RESOURCE}/abcdefghij12/notes.git/info/refs`);
	const toResource = world.requests.at(-1)!;
	expect(toResource.url).toBe(`${RESOURCE}/abcdefghij12/notes.git/info/refs`);
	expect(new Headers(toResource.init?.headers).get('authorization')).toBe(
		'Bearer token-1',
	);

	const count = world.requests.length;
	await expect(account.fetch('https://elsewhere.test/steal')).rejects.toThrow(
		TypeError,
	);
	// A look-alike host is another origin.
	await expect(account.fetch('https://git.test.evil/x')).rejects.toThrow(
		TypeError,
	);
	await expect(account.fetch('http://git.test/x')).rejects.toThrow(TypeError);
	await expect(account.fetch('https://user:pass@api.test/x')).rejects.toThrow(
		TypeError,
	);
	expect(world.requests).toHaveLength(count);
	auth[Symbol.dispose]();
});

test('a 401 publishes reauth-required and keeps the Account until a new token arrives', async () => {
	const world = createWorld();
	const { auth } = await signIn(world);
	const account = auth.getState().account!;

	world.server.resourceStatus = 401;
	const response = await account.fetch('/api/thing');
	expect(response.status).toBe(401);
	expect(auth.getState()).toEqual({ status: 'reauth-required', account });
	await expect(account.fetch('/api/thing')).rejects.toMatchObject({
		code: 'reauth-required',
	});

	// Another tab signs the same person in again.
	world.server.resourceStatus = 200;
	await signIn(world);
	world.notify();
	expect(auth.getState()).toEqual({ status: 'signed-in', account });
	expect((await account.fetch('/api/thing')).status).toBe(200);
	auth[Symbol.dispose]();
});

test('sign-out revokes the access token and clears storage', async () => {
	const world = createWorld();
	const { auth } = await signIn(world);
	const account = auth.getState().account!;

	expectOk(await auth.signOut());

	expect(world.revoked.map((form) => Object.fromEntries(form))).toEqual([
		{
			token: 'token-1',
			client_id: CLIENT_ID,
			token_type_hint: 'access_token',
		},
	]);
	const revocation = world.requests.find((r) =>
		r.url.endsWith('/auth/oauth2/revoke'),
	)!;
	expect(revocation.init?.credentials).toBe('omit');
	expect(auth.getState().status).toBe('signed-out');
	expect(world.storage.getItem(TOKEN_KEY)).toBeNull();
	await expect(account.fetch('/api/thing')).rejects.toBeDefined();
	auth[Symbol.dispose]();
});

test('sign-out clears locally even when revocation fails', async () => {
	const world = createWorld({
		revoke: () => Promise.reject(new TypeError('offline')),
	});
	const { auth } = await signIn(world);
	expectOk(await auth.signOut());
	expect(auth.getState().status).toBe('signed-out');
	expect(world.storage.getItem(TOKEN_KEY)).toBeNull();
	expect(world.logs.map((event) => event.message)).toEqual([
		'Token revocation failed.',
	]);
	auth[Symbol.dispose]();
});

test('dispose clears the renewal timer and the storage listener', async () => {
	const world = createWorld();
	const { auth } = await signIn(world);
	expect(world.pendingTimers().length).toBeGreaterThan(0);
	auth[Symbol.dispose]();
	expect(world.pendingTimers()).toEqual([]);
});

describe('one sign-in for several resources', () => {
	// Local and self-hosted deployments serve Git under the API's origin.
	const API = SERVER;
	const LOCAL_GIT = `${SERVER}/git`;
	const BOTH = [API, LOCAL_GIT] as const;

	test('one navigation names every resource and asks for offline_access', async () => {
		const world = createWorld({ resources: BOTH });
		const tab = world.openTab();
		using auth = tab.create();
		expectOk(await auth.startSignIn());
		expect(tab.assigned).toHaveLength(1);
		const params = new URL(tab.assigned[0]!).searchParams;
		expect(params.getAll('resource')).toEqual([API, LOCAL_GIT]);
		expect(params.get('scope')).toBe(`${SCOPE} offline_access`);
	});

	test('the callback exchanges the code for the first resource and refreshes once for each other, keeping no refresh token', async () => {
		const world = createWorld({ resources: BOTH });
		const { tab, auth } = await signIn(world);

		expect(
			world.tokenForms.map((form) => ({
				grant: form.get('grant_type'),
				resource: form.get('resource'),
				refreshToken: form.get('refresh_token'),
			})),
		).toEqual([
			{ grant: 'authorization_code', resource: API, refreshToken: null },
			{ grant: 'refresh_token', resource: LOCAL_GIT, refreshToken: 'ep_rt_1' },
		]);
		expect(JSON.parse(world.storage.getItem(TOKEN_KEY)!)).toEqual({
			tokens: {
				[API]: { accessToken: 'token-1', expiresAt: expect.any(Number) },
				[LOCAL_GIT]: { accessToken: 'token-2', expiresAt: expect.any(Number) },
			},
			principalId: 'alice',
			generation: expect.any(String),
		});
		const attempts = tab.options.attemptStorage as ReturnType<
			typeof createMemoryStorage
		>;
		for (const value of [
			...world.storage.cells.values(),
			...attempts.cells.values(),
		])
			expect(value).not.toContain('ep_rt_');
		expect(auth.getState().status).toBe('signed-in');
		auth[Symbol.dispose]();
	});

	test.each([
		['under the API origin', LOCAL_GIT],
		['on an origin of its own', RESOURCE],
	])(
		'Account.fetch sends each resource its own token, with Git %s',
		async (_, git) => {
			const world = createWorld({ resources: [API, git] });
			const { auth } = await signIn(world);
			const account = auth.getState().account!;
			const sentWith = async (url: string) => {
				await account.fetch(url);
				return new Headers(world.requests.at(-1)!.init?.headers).get(
					'authorization',
				);
			};
			expect(await sentWith(`${git}/alice/notes.git/info/refs`)).toBe(
				'Bearer token-2',
			);
			expect(await sentWith(git)).toBe('Bearer token-2');
			expect(await sentWith(`${API}/ai/chat`)).toBe('Bearer token-1');
			// A path that only starts with the Git path is the API's.
			expect(await sentWith(`${API}/github`)).toBe('Bearer token-1');
			expect(await sentWith('/auth/oauth2/userinfo')).toBe('Bearer token-1');
			await expect(account.fetch('https://elsewhere.test/x')).rejects.toThrow(
				TypeError,
			);
			auth[Symbol.dispose]();
		},
	);

	test('a failed refresh fails the sign-in, stores nothing, and revokes what was issued', async () => {
		const world = createWorld({ resources: BOTH });
		world.server.failTokenRequest = 2;
		const tab = world.openTab();
		expectOk(await tab.create().startSignIn());
		tab.location.href = world.server.authorize(tab.assigned[0]!);
		using auth = tab.create();

		const { error } = await auth.completeSignIn();
		expect(error?.name).toBe('CompleteSignInFailed');
		expect(world.storage.getItem(TOKEN_KEY)).toBeNull();
		expect(auth.getState().status).toBe('signed-out');
		await Bun.sleep(0);
		expect(
			world.revoked.map((form) => [
				form.get('token'),
				form.get('token_type_hint'),
			]),
		).toEqual([
			['token-1', 'access_token'],
			['ep_rt_1', 'refresh_token'],
		]);
	});

	test('a 401 on either token asks for reauthentication; sign-out retires and revokes both', async () => {
		const world = createWorld({ resources: BOTH });
		const { auth } = await signIn(world);
		const account = auth.getState().account!;

		world.server.refusedTokens.add('token-2');
		expect((await account.fetch(`${LOCAL_GIT}/x`)).status).toBe(401);
		expect(auth.getState()).toEqual({ status: 'reauth-required', account });
		await expect(account.fetch(`${LOCAL_GIT}/x`)).rejects.toMatchObject({
			code: 'reauth-required',
		});
		// The API token was not refused, so its requests still go out.
		expect((await account.fetch(`${API}/ai`)).status).toBe(200);

		expectOk(await auth.signOut());
		expect(account.signal.aborted).toBe(true);
		await expect(account.fetch(`${API}/ai`)).rejects.toBeDefined();
		await expect(account.fetch(`${LOCAL_GIT}/x`)).rejects.toBeDefined();
		expect(world.revoked.map((form) => form.get('token')).sort()).toEqual([
			'token-1',
			'token-2',
		]);
		auth[Symbol.dispose]();
	});

	test('silent renewal is due at the earliest expiry and repeats the exchange and refresh', async () => {
		const world = createWorld({ resources: BOTH });
		const { auth: first } = await signIn(world);
		first[Symbol.dispose]();
		const cell = JSON.parse(world.storage.getItem(TOKEN_KEY)!);
		cell.tokens[LOCAL_GIT].expiresAt -= HOUR;
		world.storage.setItem(TOKEN_KEY, JSON.stringify(cell));
		world.advance(7 * HOUR - 9 * MINUTE);

		const tab = world.openTab('/notes');
		using leaving = tab.create();
		await Bun.sleep(0);
		expect(tab.assigned).toHaveLength(1);
		expect(leaving.getState().status).toBe('signed-in');
		const params = new URL(tab.assigned[0]!).searchParams;
		expect(params.get('prompt')).toBe('none');
		expect(params.getAll('resource')).toEqual([API, LOCAL_GIT]);

		tab.location.href = world.server.authorize(tab.assigned[0]!);
		using callback = tab.create();
		expectOk(await callback.completeSignIn());
		const renewed = JSON.parse(world.storage.getItem(TOKEN_KEY)!);
		expect(renewed.tokens[API].accessToken).toBe('token-3');
		expect(renewed.tokens[LOCAL_GIT].accessToken).toBe('token-4');
		expect(renewed.generation).toBe(cell.generation);
	});

	test('a resource named twice is refused', () => {
		const tab = createWorld().openTab();
		expect(() =>
			createBrowserOAuth({ ...tab.options, resources: [API, API] }),
		).toThrow(TypeError);
	});
});
