/**
 * Desktop Broker Auth Tests
 *
 * Verifies that the window-local client is a pure projection of the Bun
 * authority: identity comes from the boot snapshot, account commands are
 * same-origin broker calls, and no credential is attached to any window
 * transport.
 *
 * Key behaviors:
 * - Window fetch passes requests through without an Authorization header
 * - Account commands post to the same-origin broker routes with cookies
 * - The profile is read from the broker projection, never the server transport
 * - Retired Accounts refuse further HTTP and socket work
 * - It is not a callback client: no browser OAuth callback reaches a window
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { MAIN_SUBPROTOCOL } from '@epicenter/sync';
import { type AuthFetch, isCallbackAuthClient } from './auth-contract.ts';
import {
	createDesktopBrokerAuth,
	readDesktopAuthBootstrap,
} from './desktop-broker-auth.ts';

const bootstrap = {
	state: { status: 'signed-in', principalId: asPrincipalId('alice') },
	authorityId: 'test-server',
	baseURL: 'https://api.epicenter.so',
	startSignIn: true, accountManagement: true, recovery: false, selectedServer: null,
} as const;

function recordingFetch(
	respond: (url: string, init?: RequestInit) => Response,
) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetch: AuthFetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		calls.push({ url, init });
		return respond(url, init);
	};
	return { calls, fetch };
}

test('window fetch attaches no credential to any request', async () => {
	const { calls, fetch } = recordingFetch(() => new Response('ok'));
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});
	const auth = startup.auth!;

	await selectedAccount(auth).fetch('https://api.epicenter.so/api/session');
	await expect(
		selectedAccount(auth).fetch('https://example.com/resource'),
	).rejects.toThrow('own server');

	expect(calls).toHaveLength(1);
	for (const call of calls) {
		const headers = new Headers(call.init?.headers);
		expect(headers.get('authorization')).toBeNull();
	}
});

test('desktop account POST preserves binary and multipart bodies as replayable bytes', async () => {
	const binary = new Uint8Array([0, 255, 128, 42]);
	const requests: Request[] = [];
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async (input, init) => {
			// WKWebView rejects a Request reconstructed with another Request's
			// ReadableStream body. The bridge must supply a replayable body.
			expect(init?.body).toBeDefined();
			expect(init?.body).not.toBeInstanceOf(ReadableStream);
			requests.push(new Request(input, init));
			return new Response(null, { status: 204 });
		},
	});
	const account = selectedAccount(startup.auth!);
	try {
		await account.fetch('/api/current?generation=1', {
			method: 'POST',
			headers: {
				'content-type': 'application/octet-stream',
				authorization: 'Bearer forbidden',
				cookie: 'forbidden=1',
			},
			body: binary,
		});
		const form = new FormData();
		form.set('file', new File([binary], 'audio.wav', { type: 'audio/wav' }));
		form.set('model', 'selected-model');
		await account.fetch(
			new Request('https://api.epicenter.so/v1/audio/transcriptions', {
				method: 'POST',
				body: form,
			}),
		);
		const first = requests[0]!;
		expect(first.url).toBe(
			'http://127.0.0.1:39130/_epicenter/account/http?path=%2Fapi%2Fcurrent%3Fgeneration%3D1',
		);
		expect(first.method).toBe('POST');
		expect(first.headers.get('authorization')).toBeNull();
		expect(first.headers.get('cookie')).toBeNull();
		expect(first.headers.get('content-type')).toBe('application/octet-stream');
		expect(first.credentials).toBe('include');
		expect(first.redirect).toBe('manual');
		expect(new Uint8Array(await first.arrayBuffer())).toEqual(binary);
		const received = await requests[1]!.formData();
		expect(received.get('model')).toBe('selected-model');
		const file = received.get('file');
		expect(file).toBeInstanceOf(File);
		expect(new Uint8Array(await (file as File).arrayBuffer())).toEqual(binary);
	} finally {
		startup[Symbol.dispose]();
	}
});

for (const interruption of ['account retirement', 'request cancellation']) {
	test(`${interruption} cancels body preparation before broker dispatch`, async () => {
		let dispatched = false;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const startup = createDesktopBrokerAuth({
			bootstrap,
			brokerBaseURL: 'http://127.0.0.1:39130',
			fetch: async () => {
				dispatched = true;
				return new Response(null, { status: 204 });
			},
		});
		const controller = new AbortController();
		const pending = selectedAccount(startup.auth!).fetch('/api/current', {
			method: 'POST',
			body,
			signal: controller.signal,
		});
		if (interruption === 'account retirement') startup[Symbol.dispose]();
		else controller.abort();
		try {
			await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
			expect(dispatched).toBe(false);
			expect(cancelled).toBe(true);
		} finally {
			startup[Symbol.dispose]();
		}
	});
}

test('account commands post to the same-origin broker with cookies', async () => {
	const { calls, fetch } = recordingFetch(
		() => new Response(null, { status: 202 }),
	);
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});
	const auth = startup.auth!;

	expect((await auth.startSignIn!({ reauthenticate: true })).error).toBeNull();
	expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
		reauthenticate: true,
	});
	expect((await auth.signOut()).error).toBeNull();

	expect(calls.map((call) => call.url)).toEqual([
		'http://127.0.0.1:39130/_epicenter/account/sign-in',
		'http://127.0.0.1:39130/_epicenter/account/sign-out',
	]);
	for (const call of calls) {
		expect(call.init?.credentials).toBe('include');
		expect(call.init?.method).toBe('POST');
	}
});

test('a failed broker command returns a typed auth error', async () => {
	const { fetch } = recordingFetch(
		() => new Response('Unauthorized', { status: 401 }),
	);
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});
	const auth = startup.auth!;

	const { error } = await auth.startSignIn!();
	expect(error?.name).toBe('StartSignInFailed');
});

test('getProfile reads the broker projection, never the server transport', async () => {
	const { calls, fetch } = recordingFetch((url) =>
		url.includes('/_epicenter/account/http?')
			? Response.json({ principalId: 'alice', email: 'alice@example.com' })
			: new Response('unexpected', { status: 500 }),
	);
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch,
	});
	const auth = startup.auth!;

	const profile = await auth.getProfile();
	expect(profile.error).toBeNull();
	expect(profile.data).toEqual({
		id: asPrincipalId('alice'),
		email: 'alice@example.com',
	});
	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe(
		'http://127.0.0.1:39130/_epicenter/account/http?path=%2Fapi%2Fsession',
	);
});

test('a retired desktop account cannot open a socket', async () => {
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () => new Response(null, { status: 202 }),
	});
	const auth = startup.auth!;
	const account = selectedAccount(auth);
	await auth.signOut();
	await expect(
		account.openWebSocket({
			url: 'wss://api.epicenter.so/api/store/v1/sync',
			protocols: [MAIN_SUBPROTOCOL],
		}),
	).rejects.toMatchObject({ name: 'OpenWebSocketDenied', code: 'signed-out' });
});

test('a late HTTP completion cannot republish an account after sign-out', async () => {
	const response = Promise.withResolvers<Response>();
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async (input) =>
			String(input instanceof Request ? input.url : input).includes('/http?')
				? response.promise
				: new Response(null, { status: 202 }),
	});
	const auth = startup.auth!;
	const account = selectedAccount(auth);
	const pending = account
		.fetch('/api/example')
		.catch((error: unknown) => error);
	await auth.signOut();
	response.resolve(
		new Response('late', {
			headers: { 'x-epicenter-auth-state': 'signed-in' },
		}),
	);
	expect(await pending).toMatchObject({ name: 'AbortError' });
	expect(auth.state).toEqual({ status: 'signed-out' });
});

test('the instance broker exposes its destination and delegates token entry to Home', () => {
	const startup = createDesktopBrokerAuth({
		bootstrap: {
			state: { status: 'signed-in', principalId: asPrincipalId('instance') },
			authorityId: 'test-server',
			baseURL: 'https://epicenter.example.com',
			startSignIn: false, accountManagement: false, recovery: false, selectedServer: 'https://epicenter.example.com',
			signInLocation: 'host-settings',
		},
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () => new Response('ok'),
	});
	const auth = startup.auth!;

	expect(auth.baseURL).toBe('https://epicenter.example.com');
	expect(startup.selectedServer).toBe('https://epicenter.example.com');
	expect(startup.signInLocation).toBe('host-settings');
	expect(auth.startSignIn).toBeUndefined();
});

/**
 * The boot snapshot is read once and then gone.
 *
 * Every build the desktop host serves parses the same element, and the removal
 * is the load-bearing half: an identity snapshot has no business staying in the
 * DOM, and each app's bootstrap module depends on being the only reader.
 */
function withBootstrapElement(textContent: string | null) {
	let removed = false;
	const element = {
		textContent,
		remove() {
			removed = true;
		},
	};
	const original = (globalThis as { document?: unknown }).document;
	(globalThis as { document?: unknown }).document = {
		querySelector: (selector: string) =>
			selector === '#epicenter-auth-bootstrap' && !removed ? element : null,
	};
	return {
		wasRemoved: () => removed,
		[Symbol.dispose]() {
			(globalThis as { document?: unknown }).document = original;
		},
	};
}

test('reading the boot snapshot parses it and takes it out of the document', () => {
	using served = withBootstrapElement(JSON.stringify(bootstrap));

	expect(readDesktopAuthBootstrap()).toEqual(bootstrap);
	expect(served.wasRemoved()).toBe(true);
	// The element is gone, so a second reader gets the honest failure rather
	// than a stale snapshot.
	expect(() => readDesktopAuthBootstrap()).toThrow(
		'Epicenter did not provide the desktop auth bootstrap.',
	);
});

test('an unparseable boot snapshot fails instead of degrading', () => {
	using served = withBootstrapElement('{not json');

	expect(() => readDesktopAuthBootstrap()).toThrow(
		'Epicenter provided an invalid desktop auth bootstrap.',
	);
	// Still removed: a snapshot nobody could read is not one to leave lying around.
	expect(served.wasRemoved()).toBe(true);
});

test('a desktop window is not a callback client', () => {
	// Sign-in goes to the host over the broker and the host relaunches the
	// process; no browser OAuth callback ever lands in this window, so there is
	// no `completeSignIn` to offer and none is offered.
	const startup = createDesktopBrokerAuth({
		bootstrap: {
			state: { status: 'signed-out' },
			authorityId: 'test-server',
			baseURL: 'https://api.epicenter.test',
			startSignIn: true, accountManagement: true, recovery: false, selectedServer: null,
		},
		brokerBaseURL: 'http://127.0.0.1:4242',
		fetch: async () => new Response(null, { status: 204 }),
	});
	const auth = startup.auth!;

	expect(isCallbackAuthClient(auth)).toBe(false);
	auth[Symbol.dispose]();
});

function selectedAccount(auth: import('./auth-contract.js').AuthClient) {
	const state = auth.state;
	if (state.status === 'signed-out')
		throw new Error('Expected a selected account');
	return state.account;
}

test('an older success response cannot erase a newer desktop credential refusal', async () => {
	const old = Promise.withResolvers<Response>();
	let calls = 0;
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () =>
			++calls === 1
				? old.promise
				: new Response(null, {
						status: 401,
						headers: { 'x-epicenter-auth-state': 'reauth-required' },
					}),
	});
	const auth = startup.auth!;
	const account = selectedAccount(auth);
	const first = account.fetch('/api/old');
	await account.fetch('/api/new');
	expect(auth.state.status).toBe('reauth-required');
	old.resolve(
		new Response(null, { headers: { 'x-epicenter-auth-state': 'signed-in' } }),
	);
	await first;
	expect(auth.state.status).toBe('reauth-required');
	expect(selectedAccount(auth)).toBe(account);
	auth[Symbol.dispose]();
});

test('voluntary sign-out preserves the child Account until the host close barrier answers', async () => {
	const barrier = Promise.withResolvers<Response>();
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () => barrier.promise,
	});
	const auth = startup.auth!;
	const account = selectedAccount(auth);
	const signingOut = auth.signOut();
	expect(selectedAccount(auth)).toBe(account);
	barrier.resolve(new Response(null, { status: 202 }));
	await signingOut;
	expect(auth.state.status).toBe('signed-out');
});

test('a refused host close barrier leaves the child Account usable', async () => {
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: 'http://127.0.0.1:39130',
		fetch: async () =>
			new Response('Recording in another window', { status: 409 }),
	});
	const auth = startup.auth!;
	const account = selectedAccount(auth);
	const result = await auth.signOut();
	expect(result.error?.name).toBe('SignOutFailed');
	expect(selectedAccount(auth)).toBe(account);
});
