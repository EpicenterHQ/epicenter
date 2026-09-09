/** Captured Accounts survive reauthentication and permanently retire on sign-out, replacement, and disposal. */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from './auth-contract.js';
import type { PersistedAuth } from './auth-types.js';
import { createSessionAuth } from './create-session-auth.js';

function setup(options: { fetch?: AuthFetch } = {}) {
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
	const auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: 'https://account.test',
		persistedAuthStorage: {
			initial: {
				principalId: asPrincipalId(person),
				token,
			},
			set(value) {
				writes.push(value);
			},
		},
		launcher: {
			async startSignIn() {
				launches++;
				return { status: 'completed', token };
			},
		},
		WebSocket: FakeSocket as unknown as typeof WebSocket,
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/auth/sign-out') return new Response(null);
			if (options.fetch) return options.fetch(input, init);
			if (path === '/api/session')
				return Response.json({ principalId: person });
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

test('verification and uninterrupted same-person sign-in preserve the Account object', async () => {
	using context = setup();
	const account = context.account;
	expect(account.authorityId).toBe('epicenter-api');
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

test('canceling one HTTP caller leaves another caller sharing verification active', async () => {
	const verification = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	let verifications = 0;
	using context = setup({
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				verifications++;
				entered.resolve();
				return verification.promise;
			}
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
	verification.resolve(Response.json({ principalId: 'alice' }));
	expect(await (await second).text()).toBe('ok');
	expect(verifications).toBe(1);
});

test('disposal during verification prevents later persistence and a subsequent sign-in launch', async () => {
	const verification = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		fetch: async () => {
			entered.resolve();
			return verification.promise;
		},
	});
	const pending = context.account
		.fetch('/api/example')
		.catch((error: unknown) => error);
	await entered.promise;
	context.auth[Symbol.dispose]();
	expect(await pending).toMatchObject({ name: 'AbortError' });
	verification.resolve(Response.json({ principalId: 'alice' }));
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

test('a browser Account replays a RequestInit stream only after in-flight credential replacement', async () => {
	const bodies: string[] = [];
	using context = setup({
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/api/session')
				return Response.json({ principalId: 'alice' });
			bodies.push(
				await new Response(
					input instanceof Request ? input.body : init?.body,
				).text(),
			);
			if (bodies.length === 1) await context.signIn('alice', 'alice-2');
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

test('retirement aborts a real HTTP response stream after headers have returned', async () => {
	const revoked = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === '/api/session')
				return Response.json({ principalId: 'alice' });
			if (new URL(request.url).pathname === '/auth/sign-out')
				return new Response(null, { status: 204 });
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'));
					},
				}),
			);
		},
	});
	try {
		using auth = createSessionAuth({
			authorityId: 'epicenter-api',
			baseURL: server.url.origin,
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				if (String(input).endsWith('/auth/sign-out')) revoked.resolve();
				return response;
			},
			persistedAuthStorage: {
				initial: {
					token: 'alice-session',
					principalId: asPrincipalId('alice'),
				},
				set() {},
			},
			launcher: {
				async startSignIn() {
					return { status: 'launched' };
				},
			},
		});
		if (auth.state.status === 'signed-out')
			throw new Error('Expected cached identity');
		const response = await auth.state.account.fetch('/stream');
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
		expectOk(await auth.signOut());
		await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
		await revoked.promise;
	} finally {
		await server.stop(true);
	}
});

test('socket verification gates bearer emission and shares the result with HTTP', async () => {
	const verification = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	const openings: string[][] = [];
	class Socket extends EventTarget {
		constructor(_url: string, protocols: string[]) {
			super();
			openings.push(protocols);
		}
		close() {
			this.dispatchEvent(new Event('close'));
		}
	}
	let reads = 0;
	using auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: 'https://account.test',
		persistedAuthStorage: {
			initial: { token: 'session', principalId: asPrincipalId('alice') },
			set() {},
		},
		launcher: {
			async startSignIn() {
				return { status: 'launched' };
			},
		},
		WebSocket: Socket as unknown as typeof WebSocket,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				reads++;
				entered.resolve();
				return verification.promise;
			}
			return new Response(null, { status: 204 });
		},
	});
	if (auth.state.status === 'signed-out')
		throw new Error('Expected cached identity');
	const socket = auth.state.account.openWebSocket(address);
	const http = auth.state.account.fetch('/resource');
	await entered.promise;
	expect(openings).toEqual([]);
	verification.resolve(Response.json({ principalId: 'alice' }));
	await Promise.all([socket, http]);
	expect(reads).toBe(1);
	expect(openings).toEqual([[...address.protocols, 'bearer.session']]);
});

for (const status of [401, 503]) {
	test(`socket verification ${status} emits no bearer and preserves the Account`, async () => {
		using context = setup({
			fetch: async () => new Response(null, { status }),
		});
		const account = context.account;
		await expect(account.openWebSocket(address)).rejects.toMatchObject({
			name: 'OpenWebSocketDenied',
			code: status === 401 ? 'reauth-required' : 'auth-unavailable',
		});
		expect(context.account).toBe(account);
		expect(context.sockets).toEqual([]);
	});
}
