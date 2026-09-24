/**
 * Session issuer composition tests.
 * Equal principal IDs on different servers retain distinct authority identities.
 * Generic callback sessions expose no Cloud management capability; the hosted
 * browser composition preserves historical Cloud identity and dashboard links.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectOk } from 'wellcrafted/testing';
import { createSessionAuth } from './create-session-auth.js';
import { createHostedBrowserRedirectAuth } from './hosted-browser-redirect-auth.js';
import { normalizeInstanceServer } from './instance-server.js';

const principalId = asPrincipalId('alice');

function sessionAt(origin: string) {
	const server = normalizeInstanceServer(origin);
	const requests: string[] = [];
	const auth = createSessionAuth({
		...server,
		persistedAuthStorage: {
			initial: { token: 'restored', principalId },
			set() {},
		},
		fetch: async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			requests.push(url);
			return new URL(url).pathname === '/api/session'
				? Response.json({ principalId })
				: new Response('ok');
		},
		launcher: {
			async startSignIn() {
				return { status: 'completed', token: 'repaired' };
			},
			async completeSignIn() {
				return 'callback-token';
			},
		},
	});
	return { auth, server, requests };
}

test('offline restoration and same-person repair preserve the selected server authority', async () => {
	const a = sessionAt('https://a.example');
	const b = sessionAt('https://b.example');
	using aliceA = a.auth;
	using aliceB = b.auth;
	const stateA = aliceA.getState();
	const stateB = aliceB.getState();
	if (stateA.status === 'signed-out' || stateB.status === 'signed-out')
		throw new Error('Expected restored identities');
	const accountA = stateA.account;
	const accountB = stateB.account;
	expect(a.requests).toEqual([]);
	expect(b.requests).toEqual([]);
	expect(accountA.principalId).toBe(accountB.principalId);
	expect(accountA.authorityId).toBe(a.server.authorityId);
	expect(accountB.authorityId).toBe(b.server.authorityId);
	expect(accountA.authorityId).not.toBe(accountB.authorityId);
	expect(accountA.authorityId).not.toBe('epicenter-api');
	await accountA.fetch('/api/example');
	expectOk(await aliceA.startSignIn());
	expect(aliceA.getState().account).toBe(accountA);
	expect(accountA.authorityId).toBe(a.server.authorityId);
	expect(b.requests).toEqual([]);
	await expect(
		accountA.fetch('https://b.example/api/example'),
	).rejects.toThrow();
	expect(
		a.requests.every((url) => new URL(url).origin === 'https://a.example'),
	).toBe(true);
});

test('a non-Cloud callback repairs the same Account without acquiring dashboard links', async () => {
	const { auth } = sessionAt('https://a.example');
	using session = auth;
	const state = session.getState();
	if (state.status === 'signed-out')
		throw new Error('Expected restored identity');
	const account = state.account;
	expect(session.accountManagementUrl).toBeUndefined();
	expectOk(await session.completeSignIn());
	expect(session.getState().account).toBe(account);
	expect(session.accountManagementUrl).toBeUndefined();
});

test('hosted browser composition retains Cloud bytes, callback support, and management links', () => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const sessionCells = new Map<string, string>();
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			location: { origin: 'https://notes.example' },
			localStorage: {
				getItem: () => JSON.stringify({ token: 'restored', principalId }),
			},
			sessionStorage: {
				getItem: (key: string) => sessionCells.get(key) ?? null,
				setItem: (key: string, value: string) => {
					sessionCells.set(key, value);
				},
			},
		},
	});
	try {
		using auth = createHostedBrowserRedirectAuth({
			appId: 'so.epicenter.notes',
			baseURL: 'https://api.epicenter.so',
		});
		const state = auth.getState();
		if (state.status === 'signed-out')
			throw new Error('Expected restored identity');
		expect(state.account.authorityId).toBe('epicenter-api');
		expect(typeof auth.completeSignIn).toBe('function');
		expect(auth.accountManagementUrl(state.account, 'account').href).toBe(
			'https://api.epicenter.so/dashboard/account?expectedPrincipal=alice',
		);
	} finally {
		if (previousWindow)
			Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
	}
});
