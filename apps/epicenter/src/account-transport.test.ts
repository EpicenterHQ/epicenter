/** Real loopback traffic through the window adapter, host guards and session Account. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Account,
	ApiSessionResponse,
	type AuthFetch,
	createSessionAuth,
} from '@epicenter/auth';
import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import {
	generateBlobId,
} from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createHomeHost } from './host.ts';
import { createHomeServer } from './server.ts';

async function setup({
	verification,
}: {
	verification?: Promise<void>;
} = {}) {
	const sessionRequests: Request[] = [];
	const requests: {
		path: string;
		scope: string | null;
		appId: string | null;
		bearer: string | null;
		body: string;
		cookie: string | null;
		protocols: string | null;
	}[] = [];
	const retryReceived = Promise.withResolvers<void>();
	const releaseRetry = Promise.withResolvers<void>();
	const revocations: Promise<Response>[] = [];
	const signInOptions: Array<{ reauthenticate?: boolean }> = [];
	let verifications = 0;
	let nextToken = 'revised';
	let upstreamSockets = 0;
	let cancelStream: (() => void) | undefined;
	const streamCancelled = Promise.withResolvers<void>();
	const upstream = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname === '/api/session') {
				sessionRequests.push(request.clone());
				verifications++;
				await verification;
				return Response.json({
					principalId:
						request.headers.get('authorization') === 'Bearer bob'
							? 'bob'
							: 'alice',
					email: 'alice@example.test',
				});
			}
			if (url.pathname === '/auth/sign-out') return new Response(null);
			requests.push({
				path: url.pathname,
				scope: url.searchParams.get('scope'),
				appId: url.searchParams.get('appId'),
				bearer: request.headers.get('authorization'),
				body: ['POST', 'PUT'].includes(request.method)
					? await request.text()
					: '',
				cookie: request.headers.get('cookie'),
				protocols: request.headers.get('sec-websocket-protocol'),
			});
			if (url.pathname === STORE_SYNC_ROUTE.pattern) {
				if (server.upgrade(request)) return undefined;
				return new Response(null, { status: 400 });
			}
			if (
				url.pathname === '/api/retry' &&
				request.headers.get('authorization') !== 'Bearer revised'
			) {
				retryReceived.resolve();
				await releaseRetry.promise;
				return new Response(null, { status: 401 });
			}
			if (url.pathname === '/api/gzip')
				return new Response(
					Bun.gzipSync(new TextEncoder().encode('{"ok":true}')),
					{
						headers: {
							'content-encoding': 'gzip',
							'content-type': 'application/json',
							'set-cookie': 'secret=server',
						},
					},
				);
			if (url.pathname === '/api/stream')
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('first'));
							const interval = setInterval(
								() => controller.enqueue(new TextEncoder().encode('next')),
								10,
							);
							cancelStream = () => clearInterval(interval);
						},
						cancel() {
							cancelStream?.();
							streamCancelled.resolve();
						},
					}),
				);
			return new Response('forwarded', {
				status: 201,
				headers: { 'x-server-answer': 'yes' },
			});
		},
		websocket: {
			open(ws) {
				upstreamSockets++;
				ws.send(new Uint8Array([1, 2, 3]));
			},
			message(ws, message) {
				ws.send(message);
			},
			close() {
				upstreamSockets--;
			},
		},
	});
	const baseURL = upstream.url.origin;
	const auth = createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL,
		fetch(input, init) {
			const response = fetch(input, init);
			if (String(input).endsWith('/auth/sign-out')) revocations.push(response);
			return response;
		},
		persistedAuthStorage: {
			initial: {
				principalId: ApiSessionResponse.assert({ principalId: 'alice' })
					.principalId,
				token: 'initial',
			},
			set() {},
		},
		launcher: {
			startSignIn: async ({ reauthenticate }) => {
				signInOptions.push({ reauthenticate });
				return { status: 'completed', token: nextToken };
			},
		},
	});
	const captured = auth.getState();
	if (captured.status === 'signed-out') throw new Error('Missing test account');
	const account = captured.account;
	const bootstrap = {
		state: { status: 'signed-in' as const, principalId: account.principalId },
		server: {
			baseURL,
			authorityId: 'epicenter-api',
		},
		accountManagement: true,
		credentialUnreadable: false,
	};
	const directory = await mkdtemp(join(tmpdir(), 'account-relay-'));
	const blobStores = new Map<string, ReturnType<typeof createBunBlobStore>>();
	function blobs(appId: string, owner = 'no-account') {
		const key = JSON.stringify([appId, owner]);
		let store = blobStores.get(key);
		if (!store) {
			store = createBunBlobStore({
				directory: join(directory, String(blobStores.size)),
			});
			blobStores.set(key, store);
		}
		return store;
	}
	const localBlobs = blobs('so.epicenter.notes');
	const host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	// Reserve a port before composing the exact Host guard.
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const { app, websocket } = createHomeServer({
		folderRoot: join(directory, 'checkout'),
		origin,
		launchToken: 'launch',
		host,
		staticAssets: { homePage: '<html><head></head></html>', applications: [] },
		blobs,
		desktopAuth: {
			restartRequired: false,
			baseURL,
			callbackUrl: 'epicenter://auth/callback',
			acceptSignInCallback: () => false,
			account,
			bootSnapshot: bootstrap,
			getState() {
				const state = auth.getState();
				return state.status === 'signed-out' || state.account !== account
					? { status: 'signed-out' as const }
					: {
							status: state.status,
							principalId: state.account.principalId,
						};
			},
			startSignIn: auth.startSignIn,
			cancelConnection: async () => Ok(undefined),
			async signOut() {
				expectOk(await auth.signOut());
				return Ok(undefined);
			},
			[Symbol.dispose]: auth[Symbol.dispose],
		},
	});
	let localOpened = 0;
	let localClosed = 0;
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket: {
			...websocket,
			open(ws) {
				localOpened++;
				websocket.open?.(ws);
			},
			close(ws, code, reason) {
				localClosed++;
				websocket.close?.(ws, code, reason);
			},
		},
	});
	const boot = await fetch(`${origin}/_epicenter/bootstrap`, {
		method: 'POST',
		headers: { authorization: 'Bearer launch', origin },
	});
	expect(boot.status).toBe(204);
	const cookie = boot.headers.get('set-cookie')?.split(';')[0];
	if (!cookie) throw new Error('Missing launch cookie');
	const localCalls: Request[] = [];
	const windowFetch: AuthFetch = async (input, init) => {
		const request = new Request(input, init);
		localCalls.push(request.clone());
		request.headers.set('cookie', cookie);
		request.headers.set('origin', origin);
		return fetch(request);
	};
	const SocketWithHeaders = WebSocket as unknown as {
		new (
			url: string | URL,
			options: { headers: Record<string, string> },
		): WebSocket;
	};
	const socketHeaders = { cookie, origin };
	const WindowSocket = class extends SocketWithHeaders {
		constructor(url: string | URL) {
			super(url, { headers: socketHeaders });
		}
	} as typeof WebSocket;
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: origin,
		fetch: windowFetch,
		WebSocket: WindowSocket,
	});
	const windowAuth = startup!;
	const windowState = windowAuth.getState();
	if (windowState.status === 'signed-out')
		throw new Error('Missing window account');
	return {
		origin,
		cookie,
		localBlobs,
		blobs,
		account: windowState.account,
		windowAuth,
		auth,
		requests,
		sessionRequests,
		localCalls,
		signInOptions,
		streamCancelled,
		retryReceived,
		releaseRetry,
		get verifications() {
			return verifications;
		},
		async signIn(token: string) {
			nextToken = token;
			expectOk(await auth.startSignIn());
		},
		get upstreamSockets() {
			return upstreamSockets;
		},
		async [Symbol.asyncDispose]() {
			windowAuth[Symbol.dispose]();
			auth[Symbol.dispose]();
			await Promise.resolve();
			await Promise.allSettled(revocations);
			cancelStream?.();
			await until(() => localOpened === localClosed);
			// Bun 1.3.1 through 1.3.14 count server-closed sockets after both close events.
			// stop(true) releases the port, but its promise waits on that stale count.
			void server.stop(true);
			await upstream.stop(true);
			await host[Symbol.asyncDispose]();
			await rm(directory, { recursive: true, force: true });
		},
	};
}

test('desktop profile uses the HTTP relay with credentials only on upstream requests', async () => {
	await using context = await setup();
	const { account, localCalls, sessionRequests, origin } = context;
	expect(expectOk(await account.getProfile())).toEqual({
		id: account.principalId,
		email: 'alice@example.test',
	});
	expect(localCalls).toHaveLength(1);
	const request = localCalls[0]!;
	expect(request.url).toBe(
		`${origin}/_epicenter/account/http?path=%2Fapi%2Fsession`,
	);
	expect(request.method).toBe('GET');
	expect(request.headers.get('authorization')).toBeNull();
	expect(request.headers.get('cookie')).toBeNull();
	expect(await request.text()).toBe('');
	expect(sessionRequests.length).toBeGreaterThan(0);
	for (const upstream of sessionRequests) {
		expect(upstream.headers.get('authorization')).toBe('Bearer initial');
		expect(upstream.headers.get('cookie')).toBeNull();
	}
});

test('desktop HTTP replays the body after a credential revision and decodes compressed responses once', async () => {
	await using context = await setup();
	const pending = context.account.fetch('/api/retry', {
		method: 'POST',
		body: 'same bytes',
		headers: { authorization: 'window-supplied' },
	});
	await context.retryReceived.promise;
	await context.signIn('revised');
	context.releaseRetry.resolve();
	const response = await pending;
	expect(response.status).toBe(201);
	expect(await response.text()).toBe('forwarded');
	expect(context.verifications).toBe(2);
	expect(context.requests.map(({ body }) => body)).toEqual([
		'same bytes',
		'same bytes',
	]);
	expect(context.requests.map(({ bearer }) => bearer)).toEqual([
		'Bearer initial',
		'Bearer revised',
	]);
	expect(context.requests.every(({ cookie }) => cookie === null)).toBe(true);
	expect(
		context.localCalls.every(
			(request) => request.headers.get('authorization') === null,
		),
	).toBe(true);
	const compressed = await context.account.fetch('/api/gzip');
	expect(compressed.headers.get('set-cookie')).toBeNull();
	expect(compressed.headers.get('content-encoding')).toBeNull();
	expect(await compressed.json()).toEqual({ ok: true });
});

test('host refuses missing sessions, foreign origins and escaped destinations before upstream dispatch', async () => {
	await using context = await setup();
	const url = `${context.origin}/_epicenter/account/http?path=${encodeURIComponent('/api/example')}`;
	expect((await fetch(url)).status).toBe(401);
	expect(
		(
			await fetch(url, {
				method: 'POST',
				headers: { cookie: context.cookie, origin: 'https://foreign.test' },
			})
		).status,
	).toBe(403);
	expect(
		(await fetch(url, { method: 'POST', headers: { cookie: context.cookie } }))
			.status,
	).toBe(403);
	for (const path of [
		'//foreign.test/api/example',
		'/\\foreign.test/api/example',
		'https://foreign.test/api/example',
		'/auth/session/redeem',
	]) {
		expect(
			(
				await fetch(
					`${context.origin}/_epicenter/account/http?path=${encodeURIComponent(path)}`,
					{ headers: { cookie: context.cookie } },
				)
			).status,
		).toBe(400);
	}
	expect(context.requests).toEqual([]);
});

test('desktop sync relays exact bytes, closes with its session, and closes again on account retirement', async () => {
	await using context = await setup();
	const address = STORE_SYNC_ROUTE.address(context.account.baseURL, {
		appId: 'so.test.notes',
		scope: 'personal',
		dataId: 'so.test.notes',
		generation: 1,
		cursor: 0,
	});
	async function connect(account: Account) {
		const socket = await account.openWebSocket(address);
		const received: Uint8Array[] = [];
		socket.addEventListener('message', (event) =>
			received.push(new Uint8Array(event.data)),
		);
		await until(() => received.length === 1);
		expect(received[0]).toEqual(new Uint8Array([1, 2, 3]));
		const backing = new Uint8Array([99, 4, 5, 98]);
		socket.send(backing.subarray(1, 3));
		await until(() => received.length === 2);
		expect(received[1]).toEqual(new Uint8Array([4, 5]));
		return socket;
	}
	const first = await connect(context.account);
	first.close();
	await until(() => context.upstreamSockets === 0);
	const second = await connect(context.account);
	await context.auth.signOut();
	await until(
		() =>
			second.readyState === WebSocket.CLOSED && context.upstreamSockets === 0,
	);
	const refusal = await context.account
		.openWebSocket(address)
		.catch((error: unknown) => error);
	expect(refusal).toMatchObject({ code: 'signed-out' });
	expect(
		context.requests
			.filter(({ path }) => path === STORE_SYNC_ROUTE.pattern)
			.every(
				(request) =>
					request.protocols === 'epicenter, bearer.initial' &&
					request.appId === 'so.test.notes' &&
					request.scope === 'personal',
			),
	).toBe(true);
});

test('retirement aborts an HTTP response after its headers and first body chunk', async () => {
	await using context = await setup();
	const response = await context.account.fetch('/api/stream');
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Missing response body');
	expect((await reader.read()).value?.length).toBeGreaterThan(0);
	await context.auth.signOut();
	// Host closes its upstream body; the downstream response terminates too.
	await context.streamCancelled.promise;
	await reader.cancel();
});

test('cancelling one caller during shared verification leaves the other request active', async () => {
	const verification = Promise.withResolvers<void>();
	await using context = await setup({ verification: verification.promise });
	const caller = new AbortController();
	const first = context.account
		.fetch('/api/cancelled', { signal: caller.signal })
		.catch((error: unknown) => error);
	const second = context.account.fetch('/api/survives');
	await until(
		() => context.verifications === 1 && context.localCalls.length === 2,
	);
	caller.abort();
	expect(await first).toBeInstanceOf(Error);
	verification.resolve();
	expect((await second).status).toBe(201);
	expect(context.verifications).toBe(1);
	expect(context.requests.map(({ path }) => path)).toEqual(['/api/survives']);
});

test('caller cancellation terminates its relayed stream without retiring the account', async () => {
	await using context = await setup();
	const caller = new AbortController();
	const response = await context.account.fetch('/api/stream', {
		signal: caller.signal,
	});
	const reader = response.body!.getReader();
	expect((await reader.read()).value?.length).toBeGreaterThan(0);
	caller.abort();
	await context.streamCancelled.promise;
	await reader.cancel().catch(() => undefined);
	expect((await context.account.fetch('/api/still-active')).status).toBe(201);
	expect(context.windowAuth.getState().status).toBe('signed-in');
});

test('an old window cannot relay through the successor credential after account replacement', async () => {
	await using context = await setup();
	const address = STORE_SYNC_ROUTE.address(context.account.baseURL, {
		dataId: 'so.test.notes',
		generation: 1,
		cursor: 0,
	});
	const socket = await context.account.openWebSocket(address);
	await until(() => context.upstreamSockets === 1);
	await context.signIn('bob');
	await until(
		() =>
			socket.readyState === WebSocket.CLOSED && context.upstreamSockets === 0,
	);
	const response = await context.account.fetch('/api/old-window');
	expect(response.status).toBe(401);
	expect(context.windowAuth.getState().status).toBe('signed-out');
	expect(context.requests.some(({ bearer }) => bearer === 'Bearer bob')).toBe(
		false,
	);
	expect(context.requests.some(({ path }) => path === '/api/old-window')).toBe(
		false,
	);
});

test('the broker route validates and forwards forced reauthentication to the session launcher', async () => {
	await using context = await setup();
	for (const body of [null, [], { reauthenticate: 'true' }]) {
		const response = await fetch(
			`${context.origin}/_epicenter/account/sign-in`,
			{
				method: 'POST',
				headers: {
					cookie: context.cookie,
					origin: context.origin,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			},
		);
		expect(response.status).toBe(400);
	}
	expect(context.signInOptions).toEqual([]);
	expectOk(await context.windowAuth.startSignIn({ reauthenticate: true }));
	expect(context.signInOptions).toEqual([{ reauthenticate: true }]);
});

async function until(condition: () => boolean) {
	const end = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() > end) throw new Error('Timed out waiting for transport');
		await Bun.sleep(5);
	}
}

test('unsaved endpoint broker preserves explicit authentication and multipart transcription beyond discovery', async () => {
	await using context = await setup();
	let observed: Headers | undefined;
	let received: FormData | undefined;
	const upstream = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			observed = request.headers;
			received = await request.formData();
			return Response.json({ text: 'transcribed' });
		},
	});
	try {
		const form = new FormData();
		form.set('model', 'selected');
		form.set('file', new File(['exact audio'], 'audio.wav'));
		const response = await fetch(context.origin + '/_epicenter/inference', {
			method: 'POST',
			headers: {
				cookie: context.cookie,
				origin: context.origin,
				authorization: 'Bearer explicit',
				'cf-aig-authorization': 'Bearer gateway',
				'x-epicenter-inference-url':
					upstream.url.origin + '/v1/audio/transcriptions',
			},
			body: form,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: 'transcribed' });
		expect(observed!.get('authorization')).toBe('Bearer explicit');
		expect(observed!.get('cf-aig-authorization')).toBe('Bearer gateway');
		expect(observed!.get('cookie')).toBeNull();
		expect(observed!.get('x-epicenter-inference-url')).toBeNull();
		expect(await (received!.get('file') as File).text()).toBe('exact audio');
	} finally {
		await upstream.stop(true);
	}
});

test('native Local copies stream snapshots across namespaces, survive source deletion and refuse occupied destinations', async () => {
	await using context = await setup();
	const id = generateBlobId('bin');
	const destinationId = generateBlobId('bin');
	const source = context.blobs('so.epicenter.source');
	expectOk(await source.put(id, new Blob(['snapshot bytes'])));
	const original = source.openFile;
	const spy = spyOn(source, 'openFile').mockImplementation(async (key) => {
		const opened = await original(key);
		expectOk(await source.delete(key));
		return opened;
	});
	const copy = () =>
		fetch(
			`${context.origin}/api/apps/so.epicenter.notes/blobs/${destinationId}?owner=no-account`,
			{
				method: 'PUT',
				headers: {
					cookie: context.cookie,
					origin: context.origin,
					'x-epicenter-copy-source-app': 'so.epicenter.source',
					'x-epicenter-copy-source-id': id,
				},
			},
		);
	expect((await copy()).status).toBe(204);
	spy.mockRestore();
	expect(
		await expectOk(await context.localBlobs.get(destinationId)).text(),
	).toBe('snapshot bytes');
	expectOk(await source.put(id, new Blob(['snapshot bytes'])));
	expect((await copy()).status).toBe(409);
	expectOk(await source.delete(id));
	expectOk(await source.put(id, new Blob(['conflicting bytes'])));
	expect((await copy()).status).toBe(409);
	expect(
		await expectOk(await context.localBlobs.get(destinationId)).text(),
	).toBe('snapshot bytes');
});

test('lost native copy acknowledgment retains both store claims while host cleanup is blocked', async () => {
	const { defineStore } = await import('../../../packages/app/src/index.ts');
	const { openLocal } = await import('../../../packages/app/src/open-store.ts');
	const { acquireLocalBlobs } = await import(
		'../../../packages/app/src/blob-owner.ts'
	);
	const { createMemoryStoreRuntime } = await import(
		'../../../packages/app/src/testing.ts'
	);
	await using context = await setup();
	const memory = createMemoryStoreRuntime();
	const originalFetch = globalThis.fetch;
	const tauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
	Object.defineProperty(globalThis, 'isTauri', {
		configurable: true,
		value: true,
	});
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set('cookie', context.cookie);
		headers.set('origin', context.origin);
		return originalFetch(new URL(String(input), context.origin), {
			...init,
			headers,
		});
	}) as typeof fetch;
	const cleanupEntered = Promise.withResolvers<void>();
	const cleanupReleased = Promise.withResolvers<void>();
	const cleanupFinished = Promise.withResolvers<void>();
	const source = context.blobs('so.epicenter.source');
	const originalOpen = source.openFile;
	const spy = spyOn(source, 'openFile').mockImplementation(async (id) => {
		const result = await originalOpen(id);
		if (result.error) return result;
		return Ok({
			...result.data,
			async close() {
				cleanupEntered.resolve();
				await cleanupReleased.promise;
				await result.data.close();
				cleanupFinished.resolve();
			},
		});
	});
	try {
		const runtime = {
			...memory,
			localBlobs: (id: string, assertUsable: () => void) =>
				acquireLocalBlobs({ id, assertUsable }),
		};
		const aDef = defineStore({ id: 'so.epicenter.source', tables: {}, kv: {} });
		const bDef = defineStore({ id: 'so.epicenter.notes', tables: {}, kv: {} });
		const a = await openLocal(aDef, { runtime });
		const b = await openLocal(bDef, { runtime });
		const id = expectOk(await a.blobs.add(new Blob(['snapshot'])));
		const transfer = b.blobs.copyFrom(a.blobs, id);
		await cleanupEntered.promise;
		await expect(a.close()).rejects.toThrow();
		expectErr(await transfer);
		// The settled transfer has already left its pending sets.
		await expect(b.close()).rejects.toThrow();
		await expect(openLocal(aDef, { runtime })).rejects.toThrow();
		await expect(openLocal(bDef, { runtime })).rejects.toThrow();
	} finally {
		cleanupReleased.resolve();
		await cleanupFinished.promise;
		spy.mockRestore();
		globalThis.fetch = originalFetch;
		if (tauri) Object.defineProperty(globalThis, 'isTauri', tauri);
		else Reflect.deleteProperty(globalThis, 'isTauri');
	}
});

test('custom source provenance still retains claims after an uncertain native destination write', async () => {
	const { defineStore } = await import('../../../packages/app/src/index.ts');
	const { openLocal } = await import('../../../packages/app/src/open-store.ts');
	const { acquireLocalBlobs } = await import(
		'../../../packages/app/src/blob-owner.ts'
	);
	const { createMemoryStoreRuntime } = await import(
		'../../../packages/app/src/testing.ts'
	);
	await using context = await setup();
	const memory = createMemoryStoreRuntime();
	const originalFetch = globalThis.fetch;
	const tauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');
	Object.defineProperty(globalThis, 'isTauri', {
		configurable: true,
		value: true,
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		headers.set('cookie', context.cookie);
		headers.set('origin', context.origin);
		const response = await originalFetch(
			new URL(String(input), context.origin),
			{ ...init, headers },
		);
		if (init?.method === 'PUT') {
			await response.body?.cancel();
			throw new Error('Native acknowledgment lost');
		}
		return response;
	}) as typeof fetch;
	try {
		const runtime = {
			...memory,
			localBlobs: (id: string, assertUsable: () => void) =>
				acquireLocalBlobs({ id, assertUsable }),
		};
		const aDef = defineStore({ id: 'test.custom-source', tables: {}, kv: {} });
		const bDef = defineStore({ id: 'so.epicenter.notes', tables: {}, kv: {} });
		const a = await openLocal(aDef, { runtime: memory });
		const b = await openLocal(bDef, { runtime });
		const id = expectOk(await a.blobs.add(new Blob(['custom snapshot'])));
		const failure = expectErr(await b.blobs.copyFrom(a.blobs, id));
		if (!('id' in failure) || !failure.id)
			throw new Error('Missing destination ID');
		expect(
			await expectOk(await context.localBlobs.get(failure.id)).text(),
		).toBe('custom snapshot');
		await expect(a.close()).rejects.toThrow();
		await expect(b.close()).rejects.toThrow();
		await expect(openLocal(aDef, { runtime: memory })).rejects.toThrow();
		await expect(openLocal(bDef, { runtime })).rejects.toThrow();
	} finally {
		globalThis.fetch = originalFetch;
		if (tauri) Object.defineProperty(globalThis, 'isTauri', tauri);
		else Reflect.deleteProperty(globalThis, 'isTauri');
	}
});
