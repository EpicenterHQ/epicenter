import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from './auth-contract.js';
import type { PersistedAuth } from './auth-types.js';
import { createOAuthAppAuth } from './create-oauth-app-auth.js';

function setup(options: { fetch?: AuthFetch; expired?: boolean } = {}) {
	let person = 'alice';
	let token = 'alice-1';
	const writes: (PersistedAuth | null)[] = [];
	const resources: string[] = [];
	const sockets: FakeSocket[] = [];
	let launches = 0;
	class FakeSocket extends EventTarget {
		closed = false;
		constructor() {
			super();
			sockets.push(this);
		}
		close() {
			this.closed = true;
			this.dispatchEvent(new Event('close'));
		}
	}
	const auth = createOAuthAppAuth({
		baseURL: 'https://account.test',
		clientId: 'test',
		persistedAuthStorage: {
			initial: {
				principalId: asPrincipalId(person),
				grant: {
					accessToken: token,
					refreshToken: 'refresh',
					accessTokenExpiresAt: options.expired ? 0 : Number.MAX_SAFE_INTEGER,
				},
			},
			set(value) {
				writes.push(value);
			},
		},
		launcher: {
			async startSignIn() {
				launches++;
				return Ok({
					status: 'completed',
					grant: {
						accessToken: token,
						refreshToken: 'refresh',
						accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
					},
				});
			},
		},
		WebSocket: FakeSocket as unknown as typeof WebSocket,
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/auth/oauth2/revoke') return new Response(null);
			if (options.fetch) return options.fetch(input, init);
			if (path === '/api/session')
				return Response.json({ principalId: person });
			if (path === '/auth/oauth2/token')
				return Response.json({
					access_token: token,
					refresh_token: 'new-refresh',
					expires_in: 3600,
					token_type: 'bearer',
				});
			resources.push(new Headers(init?.headers).get('authorization') ?? 'none');
			return new Response('ok');
		},
	});
	return {
		auth,
		writes,
		resources,
		sockets,
		get launches() {
			return launches;
		},
		get account() {
			const state = auth.state;
			if (state.status === 'signed-out') throw new Error('No test account');
			return state.account;
		},
		async signIn(nextPerson: string, nextToken: string) {
			person = nextPerson;
			token = nextToken;
			expectOk(await auth.startSignIn());
		},
		[Symbol.dispose]() {
			auth[Symbol.dispose]();
		},
	};
}

const address = STORE_SYNC_ROUTE.address('https://account.test', {
	dataId: 'so.test.notes',
	generation: 1,
	cursor: 0,
});

test('refresh and uninterrupted same-person sign-in preserve the Account object', async () => {
	using context = setup({ expired: true });
	const account = context.account;
	await account.fetch('/api/example');
	expect(context.account).toBe(account);
	await context.signIn('alice', 'alice-2');
	expect(context.account).toBe(account);
	await account.fetch('/api/example');
	expect(context.resources).toEqual(['Bearer alice-1', 'Bearer alice-2']);
});

test('replacement and same-person sign-in after sign-out never revive an earlier Account', async () => {
	using context = setup();
	const alice = context.account;
	await context.signIn('bob', 'bob-1');
	expect(context.account).not.toBe(alice);
	await expect(alice.fetch('/api/example')).rejects.toMatchObject({
		name: 'AbortError',
	});
	const bob = context.account;
	expectOk(await context.auth.signOut());
	await context.signIn('bob', 'bob-2');
	expect(context.account).not.toBe(bob);
	await expect(bob.fetch('/api/example')).rejects.toMatchObject({
		name: 'AbortError',
	});
	await context.account.fetch('/api/example');
	expect(context.resources).toEqual(['Bearer bob-2']);
});

test('retirement settles pending fetch and socket authorization before verification finishes', async () => {
	const verification = Promise.withResolvers<Response>();
	using context = setup({ fetch: async () => verification.promise });
	const fetch = context.account
		.fetch('/api/example')
		.catch((error: unknown) => error);
	const socket = context.account
		.openWebSocket(address)
		.catch((error: unknown) => error);
	await Promise.resolve();
	expectOk(await context.auth.signOut());
	expect(await fetch).toMatchObject({ name: 'AbortError' });
	expect(await socket).toMatchObject({
		name: 'OpenWebSocketDenied',
		code: 'signed-out',
	});
	expect(context.sockets).toEqual([]);
	verification.resolve(Response.json({ principalId: 'alice' }));
});

test('retirement closes every socket belonging to that account', async () => {
	using context = setup();
	await context.account.openWebSocket(address);
	await context.account.openWebSocket(address);
	expect(context.sockets.every((socket) => !socket.closed)).toBe(true);
	expectOk(await context.auth.signOut());
	expect(context.sockets.every((socket) => socket.closed)).toBe(true);
});

test('canceling one HTTP caller leaves another caller sharing refresh active', async () => {
	const refresh = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	let refreshes = 0;
	using context = setup({
		expired: true,
		fetch: async (input) => {
			if (String(input).endsWith('/auth/oauth2/token')) {
				refreshes++;
				entered.resolve();
				return refresh.promise;
			}
			if (String(input).endsWith('/api/session'))
				return Response.json({ principalId: 'alice' });
			return new Response('ok');
		},
	});
	const cancel = new AbortController();
	const first = context.account
		.fetch('/api/one', { signal: cancel.signal })
		.catch((error: unknown) => error);
	const second = context.account.fetch('/api/two');
	await entered.promise;
	cancel.abort();
	expect(await first).toMatchObject({ name: 'AbortError' });
	refresh.resolve(
		Response.json({
			access_token: 'refreshed',
			token_type: 'bearer',
			expires_in: 3600,
		}),
	);
	expect(await (await second).text()).toBe('ok');
	expect(refreshes).toBe(1);
});

test('disposal during refresh prevents later persistence and a subsequent sign-in launch', async () => {
	const refresh = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		expired: true,
		fetch: async () => {
			entered.resolve();
			return refresh.promise;
		},
	});
	const pending = context.account
		.fetch('/api/example')
		.catch((error: unknown) => error);
	await entered.promise;
	context.auth[Symbol.dispose]();
	expect(await pending).toMatchObject({ name: 'AbortError' });
	refresh.resolve(
		Response.json({
			access_token: 'late',
			token_type: 'bearer',
			expires_in: 3600,
		}),
	);
	await Bun.sleep(0);
	expect(context.writes).toEqual([]);
	expect((await context.auth.startSignIn()).error?.name).toBe(
		'StartSignInFailed',
	);
	expect(context.launches).toBe(0);
});

test('an account rejects foreign HTTP and socket destinations before requesting credentials', async () => {
	using context = setup({
		fetch: async () => {
			throw new Error('Must not authorize');
		},
	});
	await expect(
		context.account.fetch('https://other.test/api/example'),
	).rejects.toThrow('own server');
	await expect(
		context.account.openWebSocket({
			...address,
			url: address.url.replace('account.test', 'other.test'),
		}),
	).rejects.toThrow('own server');
});

test('a browser Account replays a RequestInit stream after a 401 refresh', async () => {
	const bodies: string[] = [];
	using context = setup({
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/api/session')
				return Response.json({ principalId: 'alice' });
			if (path === '/auth/oauth2/token')
				return Response.json({
					access_token: 'refreshed',
					token_type: 'bearer',
					expires_in: 3600,
				});
			bodies.push(
				await new Response(
					input instanceof Request ? input.body : init?.body,
				).text(),
			);
			return new Response('ok', { status: bodies.length === 1 ? 401 : 200 });
		},
	});
	const body = new Blob(['same streamed bytes']).stream();
	expect(
		(await context.account.fetch('/api/upload', { method: 'POST', body }))
			.status,
	).toBe(200);
	expect(bodies).toEqual(['same streamed bytes', 'same streamed bytes']);
});
