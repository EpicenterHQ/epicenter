/** Browser server selection is a startup value. Failed/cancelled candidates
 * cannot change it or leave new credentials, and live Accounts never retarget.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { isCallbackAuthClient } from './auth-contract.js';
import { createBrowserAuth } from './browser-auth.js';

test('the composed browser callback client exposes non-destructive sign-in cancellation', async () => {
	using environment = setup();
	const key = 'test.auth.persisted:https://hosted.test';
	const credential = JSON.stringify({ token: 'old', principalId: 'alice' });
	environment.cells.set(key, credential);
	using startup = environment.create();
	const client = startup.auth;
	if (!client || !isCallbackAuthClient(client))
		throw new Error('Expected a callback client');
	if (client.state.status === 'signed-out')
		throw new Error('Expected a stored Account');
	const account = client.state.account;
	await client.cancelSignIn();
	expect(client.state.status).toBe('signed-in');
	expect(client.state.account).toBe(account);
	expect(environment.cells.get(key)).toBe(credential);
	expect(environment.navigations).toEqual([]);
});

function setup() {
	const cells = new Map<string, string>();
	let failSelection = false;
	const storage = {
		getItem(key: string) {
			return cells.get(key) ?? null;
		},
		setItem(key: string, value: string) {
			if (failSelection && key.endsWith('.auth.server'))
				throw new Error('Storage full');
			cells.set(key, value);
		},
		removeItem(key: string) {
			cells.delete(key);
		},
	};
	const requests: string[] = [];
	const navigations: string[] = [];
	let response: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response> = async () =>
		Response.json({ principalId: 'instance' });
	const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const oldFetch = globalThis.fetch;
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			localStorage: storage,
			sessionStorage: storage,
			location: {
				origin: 'https://app.test',
				replace: (url: string) => navigations.push(url),
			},
		},
	});
	globalThis.fetch = (async (input, init) => {
		requests.push(String(input));
		return response(input, init);
	}) as typeof fetch;
	const create = (baseURL = 'https://hosted.test') =>
		createBrowserAuth({
			appId: 'test',
			baseURL,
		});
	return {
		cells,
		requests,
		navigations,
		create,
		failSelection() {
			failSelection = true;
		},
		respond(fn: typeof response) {
			response = fn;
		},
		[Symbol.dispose]() {
			globalThis.fetch = oldFetch;
			if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
			else Reflect.deleteProperty(globalThis, 'window');
		},
	};
}

test('server replacement retires the captured Account and separates Alice on two origins', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.server',
		JSON.stringify({ method: 'issuer', origin: 'https://first.test' }),
	);
	for (const origin of ['https://first.test', 'https://second.test'])
		environment.cells.set(
			`test.auth.persisted:${origin}`,
			JSON.stringify({ token: 'alice-session', principalId: 'alice' }),
		);
	using first = environment.create();
	const state = first.auth!.state;
	if (state.status === 'signed-out') throw new Error('Expected Alice');
	expectOk(await first.connectInstance({ url: 'https://second.test' }));
	expect(state.account.baseURL).toBe('https://first.test');
	await expect(state.account.fetch('/resource')).rejects.toBeDefined();
	using second = environment.create();
	const next = second.auth!.state;
	if (next.status === 'signed-out') throw new Error('Expected Alice');
	expect(next.account.authorityId).not.toBe(state.account.authorityId);
	expect(next.account.principalId).toBe(state.account.principalId);
	expect(environment.navigations).toEqual(['/?connect']);
});

test('selection write failure preserves the target credential and does not navigate', async () => {
	using environment = setup();
	const key = 'test.auth.persisted:https://next.test';
	environment.cells.set(
		key,
		JSON.stringify({ token: 'saved', principalId: 'alice' }),
	);
	using startup = environment.create();
	environment.failSelection();
	expectErr(await startup.connectInstance({ url: 'https://next.test' }));
	expect(environment.cells.get(key)).toContain('saved');
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.navigations).toHaveLength(0);
});

test.each([
	'sign-out',
	'dispose',
	'sign-in',
] as const)('%s during predecessor revocation prevents a late server selection', async (action) => {
	using environment = setup();
	environment.cells.set(
		'test.auth.persisted:https://hosted.test',
		JSON.stringify({ token: 'old', principalId: 'alice' }),
	);
	const entered = Promise.withResolvers<void>();
	const revoked = Promise.withResolvers<Response>();
	environment.respond(async () => {
		entered.resolve();
		return revoked.promise;
	});
	using startup = environment.create();
	const connecting = startup.connectInstance({ url: 'https://next.test' });
	await entered.promise;
	if (action === 'sign-out') expectOk(await startup.auth!.signOut());
	if (action === 'dispose') startup[Symbol.dispose]();
	if (action === 'sign-in') expectOk(await startup.auth!.startSignIn!());
	revoked.resolve(Response.json({ success: true }));
	expectErr(await connecting);
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.navigations).toHaveLength(0);
	if (action === 'sign-in')
		expect(window.location.href).toStartWith('https://hosted.test/');
});

test.each([
	'broken',
	'',
	JSON.stringify({ method: 'issuer', origin: 'https://hosted.test' }),
])('invalid saved selection %j never restores or revokes cached Cloud credentials', async (selection) => {
	using environment = setup();
	environment.cells.set('test.auth.server', selection);
	const key = 'test.auth.persisted:https://hosted.test';
	const credential = JSON.stringify({
		token: 'cloud-secret',
		principalId: 'alice',
	});
	environment.cells.set(key, credential);
	using auth = environment.create();
	expect(auth.selectedServer).toBeNull();
	expect(auth.auth).toBeNull();
	expect(auth.auth?.startSignIn).toBeUndefined();
	expect(environment.cells.get(key)).toBe(credential);
	expect(environment.cells.get('test.auth.server')).toBe(selection);
	expect(environment.requests).toHaveLength(0);
	expectOk(await auth.useCloud());
	expect(environment.navigations).toEqual(['/?connect']);
	expect(environment.cells.get(key)).toBe(credential);
	using recovered = environment.create();
	expect(recovered.selectedServer).toBeNull();
	expect(recovered.auth!.state.status).toBe('signed-in');
});

test('historical instance restoration keeps its identity until explicit issuer selection', async () => {
	using environment = setup();
	environment.cells.set('test.auth.server', 'https://instance.test');
	const key = 'test.auth.instance:https://instance.test';
	environment.cells.set(
		key,
		JSON.stringify({ token: 'legacy', principalId: 'instance' }),
	);
	using old = environment.create();
	expect(old.auth!.startSignIn).toBeUndefined();
	const state = old.auth!.state;
	if (state.status === 'signed-out')
		throw new Error('Expected historical identity');
	expect(state.account.principalId).toBe(asPrincipalId('instance'));
	expect(state.account.supportsShared).toBe(true);
	expect(environment.requests).toHaveLength(0);
	expectOk(await old.connectInstance({}));
	using next = environment.create();
	expect(next.auth!.state.status).toBe('signed-out');
	expect(next.auth!.startSignIn).toBeFunction();
	await expect(state.account.fetch('/resource')).rejects.toBeDefined();
});

test('a superseded selection cannot overwrite the next choice after delayed revocation', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.persisted:https://hosted.test',
		JSON.stringify({ token: 'old', principalId: 'alice' }),
	);
	const entered = Promise.withResolvers<void>();
	const revoked = Promise.withResolvers<Response>();
	environment.respond(async () => {
		entered.resolve();
		return revoked.promise;
	});
	using startup = environment.create();
	const old = startup.connectInstance({ url: 'https://old.test' });
	await entered.promise;
	expectOk(await startup.connectInstance({ url: 'https://next.test' }));
	revoked.resolve(Response.json({ success: true }));
	expectErr(await old);
	expect(JSON.parse(environment.cells.get('test.auth.server')!).origin).toBe(
		'https://next.test',
	);
	expect(environment.navigations).toEqual(['/?connect']);
});

test('hosted credentials are restored only at their saved server origin', () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.persisted:https://first.test',
		JSON.stringify({ token: 'first-secret', principalId: 'alice' }),
	);
	environment.cells.set(
		'test.auth.persisted',
		JSON.stringify({ token: 'legacy-secret', principalId: 'alice' }),
	);
	using first = environment.create('https://first.test');
	using second = environment.create('https://second.test');
	expect(first.auth!.state.status).toBe('signed-in');
	expect(second.auth!.state.status).toBe('signed-out');
});

test('URL-only selection opens the named issuer with callback support and no Cloud management', async () => {
	using environment = setup();
	using cloud = environment.create();
	expectOk(await cloud.connectInstance({ url: 'https://personal.test' }));
	expect(environment.requests).toHaveLength(0);
	expect(environment.navigations).toEqual(['/?connect']);
	using selected = environment.create();
	expect(selected.auth?.baseURL).toBe('https://personal.test');
	expect(selected.auth?.accountManagementUrl).toBeUndefined();
	expect(selected.auth?.completeSignIn).toBeFunction();
	expectOk(await selected.auth!.startSignIn!());
	const target = new URL(window.location.href);
	expect(target.origin).toBe('https://personal.test');
	expect(target.searchParams.get('callback')).toBe(
		'https://app.test/auth/callback',
	);
	expect(target.searchParams.get('challenge')).toHaveLength(43);
	expect(target.searchParams.has('token')).toBe(false);
});

test('named issuer restores Alice offline without adopting the historical instance credential', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.server',
		JSON.stringify({ method: 'issuer', origin: 'https://personal.test' }),
	);
	environment.cells.set(
		'test.auth.instance:https://personal.test',
		JSON.stringify({ token: 'legacy', principalId: 'instance' }),
	);
	environment.cells.set(
		'test.auth.persisted:https://personal.test',
		JSON.stringify({ token: 'alice-session', principalId: 'alice' }),
	);
	environment.respond(async () => {
		throw new TypeError('Offline');
	});
	using startup = environment.create();
	const state = startup.auth!.state;
	if (state.status === 'signed-out') throw new Error('Expected cached Alice');
	expect(state.account.principalId).toBe(asPrincipalId('alice'));
	expect(state.account.supportsShared).toBe(true);
	expect(state.account.authorityId).not.toBe('epicenter-api');
	expect(environment.requests).toHaveLength(0);
	await expect(state.account.fetch('/resource')).rejects.toBeDefined();
	expect(startup.auth!.state).toEqual({
		status: 'signed-in',
		account: state.account,
	});
	expect(
		environment.cells.get('test.auth.instance:https://personal.test'),
	).toContain('legacy');
});

test('returning from a named issuer to Cloud changes the next document selection', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.server',
		JSON.stringify({ method: 'issuer', origin: 'https://personal.test' }),
	);
	using startup = environment.create();
	expectOk(await startup.useCloud());
	expect(environment.navigations).toEqual(['/?connect']);
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(window.location.href).toBeUndefined();
});

test('the configured Cloud origin cannot become a second authority through custom selection', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.persisted:https://hosted.test',
		JSON.stringify({ token: 'cloud', principalId: 'alice' }),
	);
	using startup = environment.create();
	const account = startup.auth!.state;
	expectErr(await startup.connectInstance({ url: 'https://hosted.test/' }));
	expect(startup.auth!.state).toEqual(account);
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.requests).toHaveLength(0);
	expect(environment.navigations).toHaveLength(0);
});
