/** Captured Accounts survive reauthentication and permanently retire on sign-out, replacement, and disposal. */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from './auth-contract.js';
import type { PersistedAuth } from './auth-types.js';
import { createSessionAuth } from './create-session-auth.js';

function setup(options: { fetch?: AuthFetch } = {}) {
	let person = 'alice';
	let token = 'alice-1';
	const writes: (PersistedAuth | null)[] = [];
	const resources: string[] = [];
	const revoked: string[] = [];
	let launches = 0;
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
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/auth/sign-out') {
				revoked.push(new Headers(init?.headers).get('authorization') ?? 'none');
				return new Response(null);
			}
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
		revoked,
		get launches() {
			return launches;
		},
		get account() {
			const state = auth.getState();
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

test('retirement settles a pending fetch authorization before verification finishes', async () => {
	const verification = Promise.withResolvers<Response>();
	using context = setup({ fetch: async () => verification.promise });
	const fetch = context.account
		.fetch('/api/example')
		.catch((error: unknown) => error);
	await Promise.resolve();
	expectOk(await context.auth.signOut());
	expect(await fetch).toMatchObject({ name: 'AbortError' });
	verification.resolve(Response.json({ principalId: 'alice' }));
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

test('verification of a different principal clears persistence and retires the live Account', async () => {
	using context = setup({
		fetch: async () => Response.json({ principalId: 'bob' }),
	});
	const account = context.account;
	await expect(account.fetch('/api/example')).rejects.toMatchObject({
		name: 'AbortError',
	});
	expect(context.auth.getState()).toEqual({ status: 'signed-out' });
	expect(context.writes).toEqual([null]);
});

test('disposal fences a restored Account without storage writes or token revocation', async () => {
	using context = setup();
	const account = context.account;
	context.auth[Symbol.dispose]();
	await expect(account.fetch('/api/example')).rejects.toMatchObject({
		name: 'AbortError',
	});
	expect(context.writes).toEqual([]);
	expect(context.revoked).toEqual([]);
});

test.each([
	'alice',
	'bob',
])('disposal during verification of %s prevents later persistence and a subsequent sign-in launch', async (principalId) => {
	const verification = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	const bodyRead = Promise.withResolvers<void>();
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
	const response = Response.json({ principalId });
	response.json = async () => {
		bodyRead.resolve();
		return { principalId };
	};
	verification.resolve(response);
	await bodyRead.promise;
	// The body is a resolved value now; drain its queued continuations.
	await Bun.sleep(0);
	expect(context.writes).toEqual([]);
	expect(context.revoked).toEqual([]);
	expect((await context.auth.startSignIn()).error?.name).toBe(
		'StartSignInFailed',
	);
	expect(context.launches).toBe(0);
});

test('an account rejects a foreign HTTP destination before requesting credentials', async () => {
	using context = setup({
		fetch: async () => {
			throw new Error('Must not authorize');
		},
	});
	await expect(
		context.account.fetch('https://other.test/api/example'),
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

test('a streamed body keeps keepalive: false on every send, including the replay', async () => {
	// Bun's Request has no `keepalive`, so wrapping the stream in a Request
	// alone would drop the caller's choice before the underlying fetch.
	expect(
		'keepalive' in new Request('https://account.test/', { keepalive: false }),
	).toBe(typeof Bun === 'undefined');
	const sends: { keepalive: unknown; body: string }[] = [];
	let replaced = false;
	using context = setup({
		fetch: async (input, init) => {
			const path = new URL(input instanceof Request ? input.url : String(input))
				.pathname;
			if (path === '/api/session')
				return Response.json({ principalId: 'alice' });
			sends.push({
				keepalive: init?.keepalive,
				body: await new Response(
					input instanceof Request ? input.body : init?.body,
				).text(),
			});
			if (replaced) return new Response('ok');
			replaced = true;
			await context.signIn('alice', 'alice-2');
			return new Response('stale', { status: 401 });
		},
	});
	const body = new Blob(['pack bytes']).stream();
	const response = await context.account.fetch('/api/git/upload', {
		method: 'POST',
		body,
		duplex: 'half',
		keepalive: false,
	} as RequestInit);
	expect(response.status).toBe(200);
	expect(sends).toEqual([
		{ keepalive: false, body: 'pack bytes' },
		{ keepalive: false, body: 'pack bytes' },
	]);

	// A caller that says nothing still sends nothing extra.
	sends.length = 0;
	await context.account.fetch('/api/plain', {
		method: 'POST',
		body: new Blob(['x']).stream(),
		duplex: 'half',
	} as RequestInit);
	expect(sends).toEqual([{ keepalive: undefined, body: 'x' }]);
	// A non-stream body was already passed through as given.
	await context.account.fetch('/api/plain', { keepalive: false });
	expect(sends.at(-1)?.keepalive).toBe(false);
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
		const captured = auth.getState();
		if (captured.status === 'signed-out')
			throw new Error('Expected cached identity');
		const response = await captured.account.fetch('/stream');
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
		expectOk(await auth.signOut());
		await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' });
		await revoked.promise;
	} finally {
		await server.stop(true);
	}
});

for (const cancellation of ['retirement', 'client abort'] as const) {
	test(`${cancellation} aborts a real streamed POST before its response arrives`, async () => {
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const cancel = new AbortController();
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(request) {
				const path = new URL(request.url).pathname;
				if (path === '/api/session')
					return Response.json({ principalId: 'alice' });
				if (path === '/auth/sign-out')
					return new Response(null, { status: 204 });
				expect(request.method).toBe('POST');
				expect(await request.text()).toBe('first pack bytes');
				received.resolve();
				await release.promise;
				return new Response('finished');
			},
		});
		try {
			using auth = createSessionAuth({
				authorityId: 'epicenter-api',
				baseURL: server.url.origin,
				fetch,
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
			const captured = auth.getState();
			if (captured.status === 'signed-out')
				throw new Error('Expected cached identity');
			const sending = captured.account.fetch('/git-receive-pack', {
				method: 'POST',
				body: new Blob(['first pack bytes']).stream(),
				keepalive: false,
				duplex: 'half',
				signal: cancel.signal,
			} as RequestInit);
			// Observe rejection before cancellation; Bun's async matcher waits eagerly.
			const aborted = sending.then(
				() => ({ name: 'UnexpectedSuccess' }),
				(error: unknown) => error,
			);
			await received.promise;
			if (cancellation === 'retirement') expectOk(await auth.signOut());
			else cancel.abort();
			expect(await aborted).toMatchObject({ name: 'AbortError' });
		} finally {
			release.resolve();
			await server.stop(true);
		}
	});
}

for (const status of [401, 503]) {
	test(`verification ${status} refuses the request and preserves the Account`, async () => {
		using context = setup({
			fetch: async () => new Response(null, { status }),
		});
		const account = context.account;
		await expect(account.fetch('/api/example')).rejects.toMatchObject({
			name: 'AccountUnavailable',
			code: status === 401 ? 'reauth-required' : 'auth-unavailable',
		});
		expect(context.account).toBe(account);
	});
}
