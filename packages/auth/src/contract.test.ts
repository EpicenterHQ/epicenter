/**
 * Direct-session auth contract tests.
 * Verify identity before persistence, Account-bound traffic, cancellation,
 * ordered storage, credential revisions, and independent session revocation.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { createLogger } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from './auth-contract.js';
import { isCallbackAuthClient } from './auth-contract.js';
import type { PersistedAuth } from './auth-types.js';
import {
	createSessionAuth,
	type SessionLauncher,
} from './create-session-auth.js';

const baseURL = 'https://account.test';
const initial: PersistedAuth = {
	token: 'alice:1',
	principalId: asPrincipalId('alice'),
};

function setup(
	options: {
		initial?: PersistedAuth | null;
		launcher?: SessionLauncher;
		fetch?: AuthFetch;
		set?: (value: PersistedAuth | null) => Promise<void>;
	} = {},
) {
	let stored = options.initial ?? null;
	let selectedToken = 'alice:2';
	const writes: (PersistedAuth | null)[] = [];
	const requests: { url: string; init?: RequestInit }[] = [];
	const auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL,
		log: createLogger('test', () => undefined),
		persistedAuthStorage: {
			initial: stored,
			async set(value) {
				await options.set?.(value);
				writes.push(value);
				stored = value;
			},
		},
		launcher: options.launcher ?? {
			async startSignIn() {
				return { status: 'completed', token: selectedToken };
			},
		},
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({ url, init });
			if (options.fetch) return options.fetch(input, init);
			if (url.endsWith('/api/session')) {
				const token =
					new Headers(init?.headers).get('authorization')?.slice(7) ?? '';
				return Response.json({
					principalId: token.split(':')[0],
					email: 'alice@example.com',
				});
			}
			return new Response(null, { status: 204 });
		},
	});
	return {
		auth,
		writes,
		requests,
		get stored() {
			return stored;
		},
		get account() {
			if (auth.state.status === 'signed-out')
				throw new Error('Expected account');
			return auth.state.account;
		},
		select(token: string) {
			selectedToken = token;
		},
		[Symbol.dispose]() {
			auth[Symbol.dispose]();
		},
	};
}

test('signed-out client has no callback method unless the launcher provides one', () => {
	using context = setup();
	expect(context.auth.state).toEqual({ status: 'signed-out' });
	expect(isCallbackAuthClient(context.auth)).toBe(false);
	expect('completeSignIn' in context.auth).toBe(false);
});

test('cached principal boots offline without any network read or profile state', () => {
	using context = setup({ initial });
	expect(context.account.principalId).toBe(initial.principalId);
	expect(context.requests).toEqual([]);
	expect('email' in context.auth.state).toBe(false);
});

test('completed sign-in verifies, persists, and publishes before success', async () => {
	using context = setup();
	expectOk(await context.auth.startSignIn());
	expect(context.stored).toEqual({
		token: 'alice:2',
		principalId: asPrincipalId('alice'),
	});
	expect(context.account.principalId).toBe(asPrincipalId('alice'));
	expect(context.requests[0]?.url).toBe(baseURL + '/api/session');
	expect(context.requests[0]?.init?.credentials).toBe('omit');
	expect(context.requests[0]?.init?.redirect).toBe('error');
});

test('launched sign-in installs nothing and passes explicit reauthentication intent', async () => {
	let reauth = false;
	using context = setup({
		launcher: {
			async startSignIn({ reauthenticate, signal }) {
				reauth = reauthenticate;
				expect(signal.aborted).toBe(false);
				return { status: 'launched' };
			},
		},
	});
	expectOk(await context.auth.startSignIn({ reauthenticate: true }));
	expect(reauth).toBe(true);
	expect(context.auth.state).toEqual({ status: 'signed-out' });
	expect(context.writes).toEqual([]);
	expect(context.requests).toEqual([]);
});

test('duplicate starts join the same verification and installation', async () => {
	const launch = Promise.withResolvers<{
		status: 'completed';
		token: string;
	}>();
	let calls = 0;
	using context = setup({
		launcher: {
			async startSignIn() {
				calls++;
				return launch.promise;
			},
		},
	});
	const first = context.auth.startSignIn();
	const second = context.auth.startSignIn();
	launch.resolve({ status: 'completed', token: 'alice:2' });
	expectOk(await first);
	expectOk(await second);
	expect(calls).toBe(1);
	expect(context.writes).toHaveLength(1);
});

test('duplicate callback mounts spend one code and publish one verified session', async () => {
	let exchanges = 0;
	using context = setup({
		launcher: {
			async startSignIn() {
				return { status: 'launched' };
			},
			async completeSignIn() {
				exchanges++;
				return 'alice:2';
			},
		},
	});
	const auth = context.auth;
	if (!isCallbackAuthClient(auth)) throw new Error('Expected callback client');
	const results = await Promise.all([
		auth.completeSignIn(),
		auth.completeSignIn(),
	]);
	results.forEach(expectOk);
	expect(exchanges).toBe(1);
	expect(context.writes).toHaveLength(1);
});

test('launcher throws become operation-specific Result errors', async () => {
	using context = setup({
		launcher: {
			async startSignIn() {
				throw new Error('launch failed');
			},
			async completeSignIn() {
				throw new Error('callback failed');
			},
		},
	});
	expect(expectErr(await context.auth.startSignIn()).name).toBe(
		'StartSignInFailed',
	);
	if (!isCallbackAuthClient(context.auth))
		throw new Error('Expected callback client');
	expect(expectErr(await context.auth.completeSignIn()).name).toBe(
		'CompleteSignInFailed',
	);
	expect(context.writes).toEqual([]);
});

for (const status of [401, 403, 503]) {
	test(`sign-in verification ${status} never installs a credential`, async () => {
		using context = setup({
			fetch: async () => new Response(null, { status }),
		});
		expect(expectErr(await context.auth.startSignIn()).name).toBe(
			'StartSignInFailed',
		);
		expect(context.auth.state.status).toBe('signed-out');
		expect(context.writes).toEqual([]);
	});
}

for (const status of [401, 403, 503]) {
	test(`cached credential verification ${status} preserves local identity and gates resources`, async () => {
		using context = setup({
			initial,
			fetch: async () => new Response(null, { status }),
		});
		const captured = context.account;
		await expect(captured.fetch('/resource')).rejects.toMatchObject({
			code: status === 503 ? 'auth-unavailable' : 'reauth-required',
		});
		expect(context.account).toBe(captured);
		expect(context.auth.state.status).toBe(
			status === 503 ? 'signed-in' : 'reauth-required',
		);
		expect(context.requests.map((request) => request.url)).toEqual([
			baseURL + '/api/session',
		]);
		expect(context.writes).toEqual([]);
	});
}

test('an outage can recover through the next shared validation without reauthentication', async () => {
	let reads = 0;
	using context = setup({
		initial,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				if (++reads === 1) throw new Error('offline');
				return Response.json({ principalId: 'alice' });
			}
			return new Response('resource');
		},
	});
	const account = context.account;
	await expect(account.fetch('/resource')).rejects.toMatchObject({
		code: 'auth-unavailable',
	});
	expect(await (await account.fetch('/resource')).text()).toBe('resource');
	expect(context.account).toBe(account);
	expect(reads).toBe(2);
	expect(context.writes).toEqual([]);
});

test('a mismatched restored principal retires the Account and clears the cell', async () => {
	using context = setup({
		initial,
		fetch: async () => Response.json({ principalId: 'bob' }),
	});
	const old = context.account;
	await expect(old.fetch('/resource')).rejects.toMatchObject({
		name: 'AbortError',
	});
	await Bun.sleep(0);
	expect(context.auth.state.status).toBe('signed-out');
	expect(context.stored).toBeNull();
	expect(context.requests).toHaveLength(1);
});

test('restored verification mismatch cannot clear a newer pending installation', async () => {
	const verification = Promise.withResolvers<Response>();
	const verifying = Promise.withResolvers<void>();
	const writing = Promise.withResolvers<void>();
	const releaseWrite = Promise.withResolvers<void>();
	using context = setup({
		initial,
		set: async (value) => {
			if (value?.token === 'alice:2') {
				writing.resolve();
				await releaseWrite.promise;
			}
		},
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session')) {
				if (
					new Headers(init?.headers).get('authorization') === 'Bearer alice:1'
				) {
					verifying.resolve();
					return verification.promise;
				}
				return Response.json({ principalId: 'alice' });
			}
			return new Response(null, { status: 204 });
		},
	});
	const account = context.account;
	const resource = account.fetch('/resource').catch((error: unknown) => error);
	await verifying.promise;
	const signIn = context.auth.startSignIn();
	await writing.promise;
	verification.resolve(Response.json({ principalId: 'bob' }));
	await Bun.sleep(0);
	releaseWrite.resolve();
	expectOk(await signIn);
	expect(await resource).toBeInstanceOf(Response);
	expect(context.auth.state.status).toBe('signed-in');
	expect(context.account).toBe(account);
	expect(context.stored).toEqual({ ...initial, token: 'alice:2' });
	expect(context.writes).toEqual([{ ...initial, token: 'alice:2' }]);
});

test('replacement publishes retirement before the next Account', async () => {
	using context = setup({ initial });
	const old = context.account;
	const states: string[] = [];
	context.auth.onStateChange((state) => states.push(state.status));
	context.select('bob:1');
	expectOk(await context.auth.startSignIn());
	expect(states).toEqual(['signed-out', 'signed-in']);
	expect(context.writes[0]).toBeNull();
	expect(context.account.principalId).toBe(asPrincipalId('bob'));
	await expect(old.fetch('/resource')).rejects.toMatchObject({
		name: 'AbortError',
	});
});

test('old verification cannot clear or republish a replacement identity', async () => {
	const old = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		initial,
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/sign-out'))
				return new Response(null, { status: 204 });
			if (
				new Headers(init?.headers).get('authorization') === 'Bearer alice:1'
			) {
				entered.resolve();
				return old.promise;
			}
			return Response.json({ principalId: 'bob' });
		},
	});
	const pending = context.account
		.fetch('/resource')
		.catch((error: unknown) => error);
	await entered.promise;
	context.select('bob:1');
	expectOk(await context.auth.startSignIn());
	old.resolve(Response.json({ principalId: 'charlie' }));
	expect(await pending).toMatchObject({ name: 'AbortError' });
	expect(context.account.principalId).toBe(asPrincipalId('bob'));
	expect(context.stored?.token).toBe('bob:1');
});

test('401 with an unchanged credential returns once and requires reauthentication', async () => {
	using context = setup({
		initial,
		fetch: async (input) =>
			String(input).endsWith('/api/session')
				? Response.json({ principalId: 'alice' })
				: new Response('rejected', { status: 401 }),
	});
	const account = context.account;
	const response = await account.fetch('/resource');
	expect(response.status).toBe(401);
	expect(await response.text()).toBe('rejected');
	expect(context.requests).toHaveLength(2);
	expect(context.auth.state).toEqual({ status: 'reauth-required', account });
});

test('a delayed 401 retries with a new same-Account revision without pausing it', async () => {
	const old = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	const sent: string[] = [];
	using context = setup({
		initial,
		fetch: async (input, init) => {
			if (String(input).endsWith('/api/session'))
				return Response.json({ principalId: 'alice' });
			if (String(input).endsWith('/auth/sign-out'))
				return new Response(null, { status: 204 });
			const token = new Headers(init?.headers).get('authorization')!;
			sent.push(token);
			if (token === 'Bearer alice:1') {
				entered.resolve();
				return old.promise;
			}
			return new Response('new');
		},
	});
	const account = context.account;
	const pending = account.fetch('/resource');
	await entered.promise;
	expectOk(await context.auth.startSignIn({ reauthenticate: true }));
	old.resolve(new Response(null, { status: 401 }));
	expect(await (await pending).text()).toBe('new');
	expect(sent).toEqual(['Bearer alice:1', 'Bearer alice:2']);
	expect(context.auth.state).toEqual({ status: 'signed-in', account });
});

test('getProfile uses its captured Account and never follows replacement', async () => {
	using context = setup({ initial });
	const old = context.account;
	expect(expectOk(await old.getProfile())).toMatchObject({
		id: asPrincipalId('alice'),
		email: 'alice@example.com',
	});
	context.select('bob:1');
	expectOk(await context.auth.startSignIn());
	expect(expectErr(await old.getProfile()).name).toBe('ProfileUnavailable');
	expect(expectOk(await context.auth.getProfile()).id).toBe(
		asPrincipalId('bob'),
	);
});

test('resource request preserves Request headers and iterable overrides while removing caller credentials', async () => {
	using context = setup({ initial });
	const request = new Request(baseURL + '/resource', {
		method: 'POST',
		headers: { 'x-old': 'kept', cookie: 'ambient', authorization: 'wrong' },
		body: 'bytes',
	});
	await context.account.fetch(request, {
		headers: new Headers({ 'x-custom': 'set' }),
	});
	const resource = context.requests.at(-1)!;
	const headers = new Headers(resource.init?.headers);
	expect(headers.get('x-old')).toBe('kept');
	expect(headers.get('x-custom')).toBe('set');
	expect(headers.get('authorization')).toBe('Bearer alice:1');
	expect(headers.has('cookie')).toBe(false);
	expect(resource.init?.redirect).toBe('manual');
	expect(resource.init?.credentials).toBe('omit');
});

test('sign-out retires locally immediately but waits for the revocation deadline', async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const aborted = Promise.withResolvers<void>();
	using context = setup({
		initial,
		fetch: async (_input, init) => {
			const signal = init?.signal;
			if (!signal) throw new Error('Revocation must have a deadline');
			entered.resolve(signal);
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener(
					'abort',
					() => {
						aborted.resolve();
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		},
	});
	let completed = false;
	const signOut = context.auth.signOut().then((result) => {
		completed = true;
		return result;
	});
	expect(context.auth.state.status).toBe('signed-out');
	const signal = await entered.promise;
	await Bun.sleep(0);
	expect(context.stored).toBeNull();
	expect(completed).toBe(false);
	expect(signal.aborted).toBe(false);
	await aborted.promise;
	expectOk(await signOut);
	expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
}, 10_000);

test('sign-out waits for a delayed successful revocation after clearing storage', async () => {
	const entered = Promise.withResolvers<void>();
	const revoked = Promise.withResolvers<Response>();
	using context = setup({
		initial,
		fetch: async () => {
			entered.resolve();
			return revoked.promise;
		},
	});
	let completed = false;
	const signOut = context.auth.signOut().then((result) => {
		completed = true;
		return result;
	});
	expect(context.auth.state.status).toBe('signed-out');
	await entered.promise;
	await Bun.sleep(0);
	expect(context.stored).toBeNull();
	expect(completed).toBe(false);
	revoked.resolve(new Response(null, { status: 204 }));
	expectOk(await signOut);
});

for (const token of ['alice:2', 'bob:1']) {
	test(`installing ${token} persists before awaiting old revocation`, async () => {
		const entered = Promise.withResolvers<void>();
		const revoked = Promise.withResolvers<Response>();
		using context = setup({
			initial,
			fetch: async (input, init) => {
				if (String(input).endsWith('/auth/sign-out')) {
					if (
						new Headers(init?.headers).get('authorization') === 'Bearer alice:1'
					) {
						entered.resolve();
						return revoked.promise;
					}
					return new Response(null, { status: 204 });
				}
				return Response.json({ principalId: token.split(':')[0] });
			},
		});
		context.select(token);
		let completed = false;
		const signIn = context.auth.startSignIn().then((result) => {
			completed = true;
			return result;
		});
		await entered.promise;
		await Bun.sleep(0);
		expect(context.stored?.token).toBe(token);
		expect(completed).toBe(false);
		revoked.resolve(new Response(null, { status: 204 }));
		expectOk(await signIn);
		expectOk(await context.auth.signOut());
		expect(context.stored).toBeNull();
	});
}

test('sign-out can clear storage while replacement waits for old revocation', async () => {
	const entered = Promise.withResolvers<void>();
	const revoked = Promise.withResolvers<Response>();
	using context = setup({
		initial,
		fetch: async (input, init) => {
			if (String(input).endsWith('/auth/sign-out')) {
				if (
					new Headers(init?.headers).get('authorization') === 'Bearer alice:1'
				) {
					entered.resolve();
					return revoked.promise;
				}
				return new Response(null, { status: 204 });
			}
			return Response.json({ principalId: 'alice' });
		},
	});
	const signIn = context.auth.startSignIn();
	await entered.promise;
	await Bun.sleep(0);
	expect(context.stored?.token).toBe('alice:2');
	expectOk(await context.auth.signOut());
	expect(context.stored).toBeNull();
	expectErr(await signIn);
	revoked.resolve(new Response(null, { status: 204 }));
});

test('sign-out invalidates pending launch promptly and revokes its late token', async () => {
	const launch = Promise.withResolvers<{
		status: 'completed';
		token: string;
	}>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		launcher: {
			async startSignIn({ signal }) {
				signal.addEventListener('abort', () => {}, { once: true });
				entered.resolve();
				return launch.promise;
			},
		},
	});
	const pending = context.auth.startSignIn();
	await entered.promise;
	expectOk(await context.auth.signOut());
	expect(expectErr(await pending).name).toBe('StartSignInFailed');
	launch.resolve({ status: 'completed', token: 'alice:2' });
	await Bun.sleep(0);
	expect(context.writes).toEqual([null]);
	expect(
		context.requests.some((request) => request.url.endsWith('/auth/sign-out')),
	).toBe(true);
});

for (const action of ['signOut', 'dispose'] as const) {
	test(`${action} during installation restores the final persisted cell`, async () => {
		const writing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		using context = setup({
			initial,
			set: async (value) => {
				if (value?.token === 'alice:2') {
					writing.resolve();
					await release.promise;
				}
			},
		});
		const old = context.account;
		const pending = context.auth.startSignIn();
		await writing.promise;
		const stopped =
			action === 'signOut'
				? context.auth.signOut()
				: (context.auth[Symbol.dispose](), Promise.resolve());
		expect(expectErr(await pending).name).toBe('StartSignInFailed');
		await expect(old.fetch('/resource')).rejects.toMatchObject({
			name: 'AbortError',
		});
		release.resolve();
		await stopped;
		await Bun.sleep(0);
		expect(context.stored).toEqual(action === 'signOut' ? null : initial);
		expect(context.writes.at(-1)).toEqual(
			action === 'signOut' ? null : initial,
		);
		expect(context.auth.state.status).toBe('signed-out');
	});
}

test('storage failure rejects installation without publishing it', async () => {
	using context = setup({
		set: async () => {
			throw new Error('disk');
		},
	});
	expect(expectErr(await context.auth.startSignIn()).name).toBe(
		'StartSignInFailed',
	);
	expect(context.auth.state.status).toBe('signed-out');
	expect(context.stored).toBeNull();
});

test('sign-out clears identity even when launcher cancellation and revocation fail', async () => {
	using context = setup({
		initial,
		launcher: {
			async startSignIn() {
				return { status: 'launched' };
			},
			cancel() {
				throw new Error('cancel failed');
			},
		},
		fetch: async () => new Response(null, { status: 503 }),
	});
	expect(expectErr(await context.auth.signOut()).name).toBe('SignOutFailed');
	expect(context.auth.state.status).toBe('signed-out');
	expect(context.stored).toBeNull();
});

test('callback completion supersedes a pending start and rejects its eventual token', async () => {
	const launch = Promise.withResolvers<{
		status: 'completed';
		token: string;
	}>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		launcher: {
			async startSignIn() {
				entered.resolve();
				return launch.promise;
			},
			async completeSignIn() {
				return 'bob:1';
			},
		},
	});
	const pending = context.auth.startSignIn();
	await entered.promise;
	if (!isCallbackAuthClient(context.auth))
		throw new Error('Expected callback client');
	expectOk(await context.auth.completeSignIn());
	expect(expectErr(await pending).name).toBe('StartSignInFailed');
	launch.resolve({ status: 'completed', token: 'alice:2' });
	await Bun.sleep(0);
	expect(context.stored?.token).toBe('bob:1');
	expect(context.account.principalId).toBe(asPrincipalId('bob'));
});
