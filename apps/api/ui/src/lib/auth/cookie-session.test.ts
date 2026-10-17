/**
 * The cookie session client gives each signed-in person one Account and
 * retires it when the cookie names someone else or no one. The Account sends
 * only this origin's cookie and only to this origin.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { createCookieSessionAuth } from './cookie-session.js';

const origin = 'https://api.example.test';

function setup() {
	const server = { cookie: 'alice' as string | null, signOutStatus: 200 };
	const navigations: string[] = [];
	const sent: { url: string; headers: Headers; init?: RequestInit }[] = [];
	const auth = createCookieSessionAuth({
		origin,
		navigate: (url) => navigations.push(url),
		returnPath: () => '/dashboard/usage?expectedPrincipal=alice',
		async fetch(input, init) {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			sent.push({ url, headers, init });
			const path = new URL(url).pathname;
			if (path === '/auth/get-session')
				return Response.json(
					server.cookie
						? { session: {}, user: { id: server.cookie, email: 'a@x.test' } }
						: null,
				);
			if (path === '/auth/sign-out') {
				if (server.signOutStatus === 200) server.cookie = null;
				return new Response(null, { status: server.signOutStatus });
			}
			// The server refuses a request that names a principal the cookie is not.
			if (headers.get('x-epicenter-principal') !== server.cookie)
				return new Response(null, { status: 401 });
			return Response.json({ ok: true });
		},
	});
	return { auth, server, navigations, sent };
}

test('state reads the cookie session; no session is signed out', async () => {
	const { auth, server } = setup();
	expect(auth.getState().status).toBe('signed-out');
	await auth.refresh();
	expect<string | undefined>(auth.getState().account?.principalId).toBe(
		'alice',
	);
	const before = auth.getState().account;
	await auth.refresh();
	expect(auth.getState().account).toBe(before);
	server.cookie = null;
	await auth.refresh();
	expect(auth.getState()).toEqual({ status: 'signed-out' });
});

test('sign-in leaves for the sign-in page with the return path', async () => {
	const { auth, navigations } = setup();
	expectOk(await auth.startSignIn());
	expectOk(await auth.startSignIn({ reauthenticate: true }));
	const [plain, reauth] = navigations.map(
		(url) => new URL(url, origin).searchParams,
	);
	expect(navigations.every((url) => url.startsWith('/sign-in?'))).toBe(true);
	expect(plain?.get('return')).toBe('/dashboard/usage?expectedPrincipal=alice');
	expect(plain?.has('reauth')).toBe(false);
	expect(reauth?.get('reauth')).toBe('1');
});

test('the Account sends the cookie, never a bearer, and only to this origin', async () => {
	const { auth, sent } = setup();
	await auth.refresh();
	const account = auth.getState().account;
	if (!account) throw new Error('Expected Alice');
	await account.fetch('/api/billing/overview', {
		credentials: 'omit',
		headers: {
			authorization: 'Bearer other',
			'x-epicenter-principal': 'alice',
		},
	});
	const request = sent.at(-1);
	expect(request?.url).toBe(`${origin}/api/billing/overview`);
	expect(request?.init?.credentials).toBe('include');
	expect(request?.headers.get('authorization')).toBeNull();
	for (const target of ['https://evil.test/api', '//evil.test/api'])
		await expect(account.fetch(target)).rejects.toThrow(TypeError);
});

test('a cookie that changes hands retires the Account it was captured for', async () => {
	const { auth, server } = setup();
	await auth.refresh();
	const alice = auth.getState().account;
	if (!alice) throw new Error('Expected Alice');
	const states: (string | undefined)[] = [];
	auth.onStateChange((state) => states.push(state.account?.principalId));
	server.cookie = 'bob';
	const refused = await alice.fetch('/api/billing/overview', {
		headers: { 'x-epicenter-principal': 'alice' },
	});
	expect(refused.status).toBe(401);
	await auth.refresh();
	expect<string | undefined>(auth.getState().account?.principalId).toBe('bob');
	// Bob replaces Alice directly; the dashboard never flashes signed out.
	expect(states).toEqual(['bob']);
	await expect(alice.fetch('/api/billing/overview')).rejects.toThrow();
});

test('a failed sign-out keeps the Account the cookie still holds', async () => {
	const { auth, server } = setup();
	await auth.refresh();
	server.signOutStatus = 500;
	expect((await auth.signOut()).error?.name).toBe('SignOutFailed');
	expect<string | undefined>(auth.getState().account?.principalId).toBe(
		'alice',
	);
	server.signOutStatus = 200;
	expectOk(await auth.signOut());
	expect(auth.getState()).toEqual({ status: 'signed-out' });
});
