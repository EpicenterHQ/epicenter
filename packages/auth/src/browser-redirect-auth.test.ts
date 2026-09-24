/**
 * Fixed browser deployments restore only their configured server's credentials.
 * Redirect cancellation preserves the existing Account, historical selection
 * cells cannot retarget auth, and generic issuers retain separate authorities.
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { selfHostedServer } from './auth-server.js';
import { createBrowserRedirectAuth } from './browser-redirect-auth.js';

function setup() {
	const cells = new Map<string, string>();
	const sessionCells = new Map<string, string>();
	const storage = (values: Map<string, string>) => ({
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	});
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const location = { origin: 'https://app.test', href: 'https://app.test/' };
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			location,
			localStorage: storage(cells),
			sessionStorage: storage(sessionCells),
		},
	});
	const requests: string[] = [];
	return {
		cells,
		location,
		requests,
		create(
			baseURL = 'https://first.test',
			features = { accountManagement: false },
		) {
			return createBrowserRedirectAuth({
				appId: 'test',
				server: selfHostedServer(baseURL),
				...features,
				fetch: async (input) => {
					requests.push(input instanceof Request ? input.url : String(input));
					return Response.json({ principalId: 'alice' });
				},
			});
		},
		[Symbol.dispose]() {
			if (previousWindow)
				Object.defineProperty(globalThis, 'window', previousWindow);
			else Reflect.deleteProperty(globalThis, 'window');
		},
	};
}

// ============================================================================
// Fixed server credentials and redirect lifetime
// ============================================================================

test('cancelling a launched sign-in retains the Account and persisted credential', async () => {
	using environment = setup();
	const key = 'test.auth.persisted:https://first.test';
	const credential = JSON.stringify({
		token: 'existing',
		principalId: 'alice',
	});
	environment.cells.set(key, credential);
	using auth = environment.create();
	const state = auth.getState();
	if (state.status === 'signed-out') throw new Error('Expected restored Alice');
	expectOk(await auth.startSignIn());
	expect(new URL(environment.location.href).origin).toBe('https://first.test');
	await auth.cancelSignIn();
	expect(auth.getState()).toEqual({
		status: 'signed-in',
		account: state.account,
	});
	expect(auth.getState().account).toBe(state.account);
	expect(environment.cells.get(key)).toBe(credential);
	expect(environment.requests).toEqual([]);
});

test('a deployment cannot restore credentials saved for another origin or an unscoped legacy cell', () => {
	using environment = setup();
	const credential = JSON.stringify({
		token: 'first-secret',
		principalId: 'alice',
	});
	environment.cells.set('test.auth.persisted:https://first.test', credential);
	environment.cells.set('test.auth.persisted', credential);
	using first = environment.create();
	using second = environment.create('https://second.test');
	expect(first.getState().status).toBe('signed-in');
	expect(second.getState()).toEqual({ status: 'signed-out' });
	expect(environment.requests).toEqual([]);
});

test('saved server selection and historical instance credentials cannot retarget the configured server', async () => {
	using environment = setup();
	environment.cells.set(
		'test.auth.server',
		JSON.stringify({ method: 'issuer', origin: 'https://old.test' }),
	);
	environment.cells.set(
		'test.auth.instance:https://first.test',
		JSON.stringify({ token: 'instance-secret', principalId: 'instance' }),
	);
	environment.cells.set(
		'test.auth.persisted:https://old.test',
		JSON.stringify({ token: 'old-secret', principalId: 'alice' }),
	);
	const saved = new Map(environment.cells);
	using auth = environment.create();
	expect(auth.getState()).toEqual({ status: 'signed-out' });
	expectOk(await auth.startSignIn());
	const target = new URL(environment.location.href);
	expect(target.origin).toBe('https://first.test');
	expect(target.searchParams.get('callback')).toBe(
		'https://app.test/auth/callback',
	);
	expect(target.searchParams.get('challenge')).toHaveLength(43);
	expect(target.searchParams.has('token')).toBe(false);
	expect(environment.cells).toEqual(saved);
	expect(environment.requests).toEqual([]);
});

test('generic issuers separate equal principals and expose no Cloud management links', async () => {
	using environment = setup();
	for (const origin of ['https://first.test', 'https://second.test']) {
		environment.cells.set(
			`test.auth.persisted:${origin}`,
			JSON.stringify({ token: 'session', principalId: 'alice' }),
		);
	}
	using first = environment.create();
	using second = environment.create('https://second.test');
	const a = first.getState();
	const b = second.getState();
	if (a.status === 'signed-out' || b.status === 'signed-out')
		throw new Error('Expected restored Accounts');
	expect(a.account.principalId).toBe(b.account.principalId);
	expect(a.account.authorityId).toBe(
		selfHostedServer('https://first.test').authorityId,
	);
	expect(b.account.authorityId).toBe(
		selfHostedServer('https://second.test').authorityId,
	);
	expect(a.account.authorityId).not.toBe(b.account.authorityId);
	expect(first.accountManagementUrl).toBeUndefined();
	expect(second.accountManagementUrl).toBeUndefined();
	await expect(
		a.account.fetch('https://second.test/api/resource'),
	).rejects.toThrow();
	expect(environment.requests).toEqual([]);
});

test('dashboard settings do not change browser identity', () => {
	using environment = setup();
	const baseURL = 'https://first.test';
	environment.cells.set(
		`test.auth.persisted:${baseURL}`,
		JSON.stringify({ token: 'saved', principalId: 'alice' }),
	);
	for (const accountManagement of [false, true]) {
		using auth = environment.create(baseURL, { accountManagement });
		const account = auth.getState().account;
		expect(account?.authorityId).toBe(selfHostedServer(baseURL).authorityId);
		expect(typeof auth.accountManagementUrl === 'function').toBe(
			accountManagement,
		);
		expect(environment.requests).toEqual([]);
	}
});
