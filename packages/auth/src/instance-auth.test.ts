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
import { normalizeInstanceServer } from './instance-server.js';

function setup(
	options: {
		initial?: PersistedAuth;
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
			const state = auth.getState();
			if (state.status === 'signed-out') throw new Error('Expected account');
			return state.account;
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
	const signingIn = context.auth.signIn('operator-token');
	await entered.promise;
	expect(context.auth.getState().status).toBe('signed-out');
	expect(context.saved).toBeNull();
	verified.resolve(Response.json({ principalId: 'instance' }));
	expectOk(await signingIn);
	const account = context.account;
	expect(account.principalId).toBe(asPrincipalId('instance'));
	expect(account.authorityId).toBe(
		normalizeInstanceServer('https://instance.test').authorityId,
	);
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
		expectErr(await context.auth.signIn('operator-token'));
		expect(context.auth.getState().status).toBe('signed-out');
		expect(context.saved).toBeNull();
		expect(context.requests).toHaveLength(1);
	});
}

test('cancelled token verification cannot reconnect after disconnect even when transport ignores cancellation', async () => {
	const verified = Promise.withResolvers<Response>();
	const entered = Promise.withResolvers<void>();
	using context = setup({
		fetch: async () => {
			entered.resolve();
			return verified.promise;
		},
	});
	const signingIn = context.auth.signIn('late-token');
	await entered.promise;
	expectOk(await context.auth.signOut());
	verified.resolve(Response.json({ principalId: 'instance' }));
	expectErr(await signingIn);
	await Promise.resolve();
	expect(context.auth.getState().status).toBe('signed-out');
	expect(context.saved).toBeNull();
	expect(context.requests).toHaveLength(1);
});

test('same-instance token replacement preserves Account and sends only the replacement token', async () => {
	using context = setup();
	expectOk(await context.auth.signIn('first'));
	const account = context.account;
	expectOk(await context.auth.signIn('second'));
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

test('a refused instance credential reauthenticates the same Account with the entered replacement', async () => {
	using context = setup({
		initial: { token: 'expired', principalId: asPrincipalId('instance') },
		fetch: async (_input, init) =>
			new Headers(init?.headers).get('authorization') === 'Bearer expired'
				? new Response(null, { status: 401 })
				: Response.json({ principalId: 'instance' }),
	});
	const account = context.account;
	await expect(account.fetch('/resource')).rejects.toBeDefined();
	expect(context.auth.getState().status).toBe('reauth-required');
	expectOk(await context.auth.signIn('replacement'));
	expect(context.auth.getState().status).toBe('signed-in');
	expect(context.account).toBe(account);
	expect(context.saved?.token).toBe('replacement');
	await account.fetch('/resource');
	expect(context.requests.at(-1)?.bearer).toBe('Bearer replacement');
});

test('an unexpected principal cannot enroll or replace an instance Account', async () => {
	using enrollment = setup({
		fetch: async () => Response.json({ principalId: 'cloud-person' }),
	});
	expectErr(await enrollment.auth.signIn('wrong-server-token'));
	expect(enrollment.auth.getState().status).toBe('signed-out');
	expect(enrollment.saved).toBeNull();

	using reentry = setup({
		initial: { token: 'saved', principalId: asPrincipalId('instance') },
		fetch: async () => Response.json({ principalId: 'cloud-person' }),
	});
	const account = reentry.account;
	expectErr(await reentry.auth.signIn('wrong-server-token'));
	expect(reentry.account).toBe(account);
	expect(reentry.saved?.token).toBe('saved');
});

test('a cached non-instance principal remains stored without publishing an Account or making requests', () => {
	const initial = {
		token: 'saved',
		principalId: asPrincipalId('cloud-person'),
	};
	using context = setup({ initial });
	expect(context.auth.getState().status).toBe('signed-out');
	expect(context.saved).toBe(initial);
	expect(context.requests).toHaveLength(0);
});

test('two servers returning instance remain separate Accounts and reject foreign destinations', async () => {
	using first = setup();
	using second = setup({ baseURL: 'https://other-instance.test' });
	expectOk(await first.auth.signIn('operator-token'));
	expectOk(await second.auth.signIn('operator-token'));
	expect(first.account.principalId).toBe(second.account.principalId);
	expect(first.account).not.toBe(second.account);
	expect(first.account.authorityId).not.toBe(second.account.authorityId);
	await expect(
		first.account.fetch('https://other-instance.test/resource'),
	).rejects.toBeDefined();
	expect(first.requests).toHaveLength(1);
});
