/** Browser server selection is a startup value. Failed/cancelled candidates
 * cannot change it or leave new credentials, and live Accounts never retarget.
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createBrowserAuth } from './browser-auth.js';

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
			prompt: () => 'replacement',
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
			authorityId: 'epicenter-api',
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

test('verified selection applies only to the next document and separates equal instance principals', async () => {
	using environment = setup();
	using hosted = environment.create();
	expectOk(
		await hosted.connectInstance({ url: 'https://first.test', token: 'first' }),
	);
	expect(hosted.connection.baseURL).toBe('https://hosted.test');
	using first = environment.create();
	expect(first.connection.baseURL).toBe('https://first.test');
	if (first.state.status === 'signed-out')
		throw new Error('Expected persisted Account');
	const account = first.state.account;
	expectOk(
		await first.connectInstance({
			url: 'https://second.test',
			token: 'second',
		}),
	);
	expect(account.baseURL).toBe('https://first.test');
	await expect(account.fetch('/resource')).rejects.toBeDefined();
	using second = environment.create();
	expect(second.connection.baseURL).toBe('https://second.test');
	if (second.state.status === 'signed-out')
		throw new Error('Expected persisted Account');
	expect(second.state.account.authorityId).not.toBe(account.authorityId);
	expect(environment.navigations).toEqual(['/', '/']);
	expect(environment.requests.every((url) => !url.includes('token='))).toBe(
		true,
	);
});

test('selection write failure restores the previous credential cell', async () => {
	using environment = setup();
	const key = 'test.auth.instance:https://next.test';
	environment.cells.set(key, 'previous-value');
	using auth = environment.create();
	environment.failSelection();
	expectErr(
		await auth.connectInstance({ url: 'https://next.test', token: 'secret' }),
	);
	expect(environment.cells.get(key)).toBe('previous-value');
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.navigations).toHaveLength(0);
});

test('disconnect during verification cannot save a new server or token', async () => {
	using environment = setup();
	const entered = Promise.withResolvers<void>();
	const verification = Promise.withResolvers<Response>();
	environment.respond(async () => {
		entered.resolve();
		return verification.promise;
	});
	using auth = environment.create();
	const connecting = auth.connectInstance({
		url: 'https://next.test',
		token: 'secret',
	});
	await entered.promise;
	expectOk(await auth.signOut());
	verification.resolve(Response.json({ principalId: 'instance' }));
	expectErr(await connecting);
	expect(environment.cells.has('test.auth.instance:https://next.test')).toBe(
		false,
	);
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.navigations).toHaveLength(0);
});

test('invalid saved server selection still allows recovery', () => {
	using environment = setup();
	environment.cells.set('test.auth.server', 'broken');
	using auth = environment.create();
	expect(auth.selectedServer).toBeNull();
	expect(auth.state.status).toBe('signed-out');
});

test('hosted sign-in cancels an outstanding instance choice', async () => {
	using environment = setup();
	const entered = Promise.withResolvers<void>();
	const verification = Promise.withResolvers<Response>();
	environment.respond(async () => {
		entered.resolve();
		return verification.promise;
	});
	using auth = environment.create();
	const connecting = auth.connectInstance({
		url: 'https://next.test',
		token: 'secret',
	});
	await entered.promise;
	expectOk(await auth.startSignIn());
	verification.resolve(Response.json({ principalId: 'instance' }));
	expectErr(await connecting);
	expect(environment.cells.has('test.auth.server')).toBe(false);
	expect(environment.cells.has('test.auth.instance:https://next.test')).toBe(
		false,
	);
	expect(environment.navigations).toHaveLength(0);
	expect(window.location.href).toStartWith('https://hosted.test/');
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
	expect(first.state.status).toBe('signed-in');
	expect(second.state.status).toBe('signed-out');
});
