/**
 * The desktop account client over injected shell commands: identity comes
 * from the desktop grant's status, every account request goes through
 * `send` with the resource it names, and no token ever reaches the page.
 */

import { expect, test } from 'bun:test';
import { PRODUCTION_API_URL } from '@epicenter/constants/apps';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr } from 'wellcrafted/testing';
import { createAccountManagementUrl } from './account-management.js';
import type { AuthState } from './auth-contract.ts';
import { selfHostedServer } from './auth-server.ts';
import {
	createDesktopAccountAuth,
	type DesktopAccountAudience,
	type DesktopAccountStatus,
} from './desktop-account-auth.ts';

const origin = 'https://api.example.test';
const signedIn = (
	accountId = 'alice',
	signedInAt = '2026-10-16T00:00:00.000Z',
): DesktopAccountStatus => ({ origin, grant: { accountId, signedInAt } });

function harness(
	initial: DesktopAccountStatus,
	respond: (
		audience: DesktopAccountAudience,
		request: Request,
	) => Response = () => Response.json({}),
) {
	let current = initial;
	const sent: { audience: DesktopAccountAudience; request: Request }[] = [];
	let opened = 0;
	let refreshFromWatch: (() => void) | undefined;
	const auth = createDesktopAccountAuth({
		audience: 'git',
		status: async () => current,
		send: async (audience, request) => {
			sent.push({ audience, request });
			return respond(audience, request);
		},
		openSignIn: async () => {
			opened++;
		},
		watch: (refresh) => {
			refreshFromWatch = refresh;
			return () => {
				refreshFromWatch = undefined;
			};
		},
	});
	const states: AuthState['status'][] = [];
	auth.onStateChange((state) => states.push(state.status));
	return {
		auth,
		sent,
		states,
		opened: () => opened,
		set(next: DesktopAccountStatus) {
			current = next;
		},
		focus: () => refreshFromWatch?.(),
	};
}

test('the desktop grant is the account, and its id is the principal', async () => {
	const { auth } = harness(signedIn());
	await auth.refresh();
	const state = auth.getState();
	expect(state.status).toBe('signed-in');
	expect(state.account?.principalId).toBe(asPrincipalId('alice'));
	expect(state.account?.authorityId).toBe(selfHostedServer(origin).authorityId);
	expect(state.account?.baseURL).toBe(origin);
	expect(auth.baseURL).toBe(origin);
	expect(auth.accountManagementUrl).toBeUndefined();
});

test('the deployment is the one the status names: the hosted one has the account website', async () => {
	const { auth, set } = harness(signedIn());
	expect(auth.baseURL).toBe('');
	set({ origin: PRODUCTION_API_URL, grant: signedIn().grant });
	await auth.refresh();
	expect(auth.baseURL).toBe(PRODUCTION_API_URL);
	expect(auth.getState().account?.authorityId).toBe('epicenter-api');
	expect(auth.accountManagementUrl).toBe(createAccountManagementUrl);
});

test('Account.fetch sends through the app audience and getProfile through api, with no token in the page', async () => {
	const { auth, sent } = harness(signedIn(), (audience) =>
		audience === 'api'
			? Response.json({ sub: 'alice', email: 'alice@example.test' })
			: Response.json({ namespaces: [] }),
	);
	await auth.refresh();
	const account = auth.getState().account!;
	await account.fetch(new URL('/api/repos', account.baseURL), {
		method: 'GET',
		headers: { authorization: 'Bearer page' },
	});
	expect(sent[0]?.audience).toBe('git');
	expect(sent[0]?.request.url).toBe(`${origin}/api/repos`);
	expect(sent[0]?.request.method).toBe('GET');
	expect(sent[0]?.request.headers.get('authorization')).toBeNull();
	expect(await account.getProfile()).toEqual({
		data: { id: asPrincipalId('alice'), email: 'alice@example.test' },
		error: null,
	});
	expect(sent[1]?.audience).toBe('api');
	expect(sent[1]?.request.url).toBe(`${origin}/auth/oauth2/userinfo`);
	expect(sent[1]?.request.headers.get('authorization')).toBeNull();
	expect(account.fetch('https://elsewhere.example/api/repos')).rejects.toThrow(
		'their own server',
	);
	expect(sent.length).toBe(2);
});

test('a 401 asks for sign-in again on the same account', async () => {
	const { auth, states } = harness(
		signedIn(),
		() => new Response(null, { status: 401 }),
	);
	await auth.refresh();
	const account = auth.getState().account;
	await account?.fetch('/api/repos');
	expect(auth.getState().status).toBe('reauth-required');
	expect(auth.getState().account).toBe(account);
	expect(states).toEqual(['signed-in', 'reauth-required']);
});

test('signing in again from Settings opens a new account; signing out retires the old one', async () => {
	const h = harness({ origin, grant: null });
	await h.auth.refresh();
	expect(h.auth.getState().status).toBe('signed-out');

	h.set(signedIn());
	h.focus();
	await h.auth.refresh();
	const first = h.auth.getState().account!;
	await h.auth.refresh();
	expect(h.auth.getState().account).toBe(first);

	h.set(signedIn('alice', '2026-10-17T00:00:00.000Z'));
	await h.auth.refresh();
	const second = h.auth.getState().account!;
	expect(second).not.toBe(first);
	expect(first.fetch('/api/repos')).rejects.toThrow();

	h.set({ origin, grant: null });
	await h.auth.refresh();
	expect(h.auth.getState().status).toBe('signed-out');
	expect(second.fetch('/api/repos')).rejects.toThrow();
	expect(h.states).toEqual(['signed-in', 'signed-in', 'signed-out']);
});

test('sign-in opens Settings, and sign-out is refused with where to do it', async () => {
	const h = harness({ origin, grant: null });
	expect((await h.auth.startSignIn()).error).toBeNull();
	expect(h.opened()).toBe(1);
	const refused = expectErr(await h.auth.signOut());
	expect(refused.name).toBe('SignOutFailed');
	expect(refused.message).toContain('Settings');
	expect(h.auth.getState().status).toBe('signed-out');
});

test('a grant that ended reads the status again', async () => {
	let ended = false;
	const h = harness(signedIn(), () => {
		throw Object.assign(new Error('sign in again'), { name: 'NoAccountToken' });
	});
	await h.auth.refresh();
	h.set({ origin, grant: null });
	h.auth.onStateChange((state) => {
		if (state.status === 'signed-out') ended = true;
	});
	expect(h.auth.getState().account!.fetch('/api/repos')).rejects.toThrow(
		'sign in again',
	);
	await Bun.sleep(0);
	await Bun.sleep(0);
	expect(ended).toBe(true);
});
