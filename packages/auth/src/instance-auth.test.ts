/** Instance credentials use the same verified Account lifetime as hosted sessions,
 * without remote revocation. First enrollment, cancellation, offline restoration,
 * token replacement, and server isolation retain their security boundaries.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { AuthFetch } from './auth-contract.js';
import type { PersistedAuth } from './auth-types.js';
import { createInstanceAuth } from './create-session-auth.js';

function setup(
	options: {
		initial?: PersistedAuth;
		requestToken?: (options: { signal: AbortSignal }) => Promise<string>;
		fetch?: AuthFetch;
		baseURL?: string;
	} = {},
) {
	const requests: { url: string; bearer: string | null }[] = [];
	let saved: PersistedAuth | null = options.initial ?? null;
	const auth = createInstanceAuth({
		baseURL: options.baseURL ?? 'https://instance.test',
		persistedAuthStorage: {
			initial: saved,
			set(value) {
				saved = value;
			},
		},
		requestToken: options.requestToken ?? (async () => 'operator-token'),
		fetch: async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push({
				url,
				bearer: new Headers(init?.headers).get('authorization'),
			});
			if (options.fetch) return options.fetch(input, init);
			return new URL(url).pathname === '/api/session'
				? Response.json({ principalId: 'instance' })
				: new Response('resource');
		},
	});
	return {
		auth,
		requests,
		get saved() {
			return saved;
		},
		get account() {
			if (auth.state.status === 'signed-out')
				throw new Error('Expected account');
			return auth.state.account;
		},
		[Symbol.dispose]() {
			auth[Symbol.dispose]();
		},
	};
}

test('first enrollment waits for verification and disconnect never revokes the shared token', async () => {
	const verified = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		fetch: () => {
			entered.resolve();
			return verified.promise;
		},
	});
	const signingIn = context.auth.startSignIn();
	await entered.promise;
	expect(context.auth.state.status).toBe('signed-out');
	expect(context.saved).toBeNull();
	verified.resolve(Response.json({ principalId: 'instance' }));
	expectOk(await signingIn);
	const account = context.account;
	expect(account.principalId).toBe(asPrincipalId('instance'));
	expect(context.saved?.token).toBe('operator-token');
	expectOk(await context.auth.signOut());
	expect(context.saved).toBeNull();
	expect(
		context.requests.map((request) => new URL(request.url).pathname),
	).toEqual(['/api/session']);
	await expect(account.fetch('/resource')).rejects.toBeDefined();
});

for (const status of [401, 503]) {
	test(`first enrollment refuses ${status} without publishing or persisting identity`, async () => {
		using context = setup({
			fetch: async () => new Response(null, { status }),
		});
		expectErr(await context.auth.startSignIn());
		expect(context.auth.state.status).toBe('signed-out');
		expect(context.saved).toBeNull();
		expect(context.requests).toHaveLength(1);
	});
}

test('cancelled token entry cannot reconnect after disconnect even when it ignores cancellation', async () => {
	const token = Promise.withResolvers<string>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		requestToken: async () => {
			entered.resolve();
			return token.promise;
		},
	});
	const signingIn = context.auth.startSignIn();
	await entered.promise;
	expectOk(await context.auth.signOut());
	token.resolve('late-token');
	expectErr(await signingIn);
	await Promise.resolve();
	expect(context.auth.state.status).toBe('signed-out');
	expect(context.saved).toBeNull();
	expect(context.requests).toHaveLength(0);
});

test('same-instance token replacement preserves Account and sends only the replacement token', async () => {
	let token = 'first';
	using context = setup({ requestToken: async () => token });
	expectOk(await context.auth.startSignIn());
	const account = context.account;
	token = 'second';
	expectOk(await context.auth.startSignIn());
	expect(context.account).toBe(account);
	await account.fetch('/resource');
	expect(context.requests.at(-1)?.bearer).toBe('Bearer second');
	expect(
		context.requests.some((request) => request.url.includes('/auth/')),
	).toBe(false);
});

test('cached identity survives an outage but cannot authorize resource traffic', async () => {
	using context = setup({
		initial: { token: 'saved', principalId: asPrincipalId('instance') },
		fetch: async () => {
			throw new Error('Offline');
		},
	});
	const account = context.account;
	await expect(account.fetch('/resource')).rejects.toBeDefined();
	expect(context.account).toBe(account);
	expect(context.saved?.token).toBe('saved');
	expect(
		context.requests.map((request) => new URL(request.url).pathname),
	).toEqual(['/api/session']);
});

test('two servers returning instance remain separate Accounts and reject foreign destinations', async () => {
	using first = setup();
	using second = setup({ baseURL: 'https://other-instance.test' });
	expectOk(await first.auth.startSignIn());
	expectOk(await second.auth.startSignIn());
	expect(first.account.principalId).toBe(second.account.principalId);
	expect(first.account).not.toBe(second.account);
	await expect(
		first.account.fetch('https://other-instance.test/resource'),
	).rejects.toBeDefined();
	expect(first.requests).toHaveLength(1);
});
