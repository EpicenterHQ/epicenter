/** Real loopback traffic through the window adapter, host guards and OAuth account. */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type Account,
	ApiSessionResponse,
	type AuthFetch,
	createOAuthAppAuth,
} from '@epicenter/auth';
import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { STORE_SYNC_ROUTE } from '@epicenter/sync';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createHomeHost } from './host.ts';
import { createHomeServer } from './server.ts';

async function setup() {
	const requests: {
		path: string;
		bearer: string | null;
		body: string;
		cookie: string | null;
		protocols: string | null;
	}[] = [];
	let refreshes = 0;
	let upstreamSockets = 0;
	let cancelStream: (() => void) | undefined;
	const streamCancelled = Promise.withResolvers<void>();
	const upstream = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname === '/api/session')
				return Response.json({
					principalId: 'alice',
					email: 'alice@example.test',
				});
			if (url.pathname === '/auth/oauth2/token') {
				refreshes++;
				return Response.json({
					access_token: 'refreshed',
					refresh_token: 'refresh-2',
					token_type: 'bearer',
					expires_in: 3600,
				});
			}
			if (url.pathname === '/auth/oauth2/revoke') return new Response(null);
			requests.push({
				path: url.pathname,
				bearer: request.headers.get('authorization'),
				body: request.method === 'POST' ? await request.text() : '',
				cookie: request.headers.get('cookie'),
				protocols: request.headers.get('sec-websocket-protocol'),
			});
			if (url.pathname === STORE_SYNC_ROUTE.pattern) {
				if (server.upgrade(request)) return undefined;
				return new Response(null, { status: 400 });
			}
			if (
				url.pathname === '/api/retry' &&
				request.headers.get('authorization') !== 'Bearer refreshed'
			)
				return new Response(null, { status: 401 });
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
	const auth = createOAuthAppAuth({
		baseURL,
		clientId: 'test',
		persistedAuthStorage: {
			initial: {
				principalId: ApiSessionResponse.assert({ principalId: 'alice' })
					.principalId,
				grant: {
					accessToken: 'initial',
					refreshToken: 'refresh',
					accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
				},
			},
			set() {},
		},
		launcher: { startSignIn: async () => Ok({ status: 'launched' }) },
	});
	if (auth.state.status === 'signed-out')
		throw new Error('Missing test account');
	const account = auth.state.account;
	const bootstrap = {
		state: { status: 'signed-in' as const, principalId: account.principalId },
		connection: { baseURL, status: 'connected' as const },
		networkEligible: false,
	};
	const directory = await mkdtemp(join(tmpdir(), 'account-relay-'));
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
		origin,
		launchToken: 'launch',
		host,
		staticAssets: { homePage: '<html><head></head></html>', applications: [] },
		blobs: createBunBlobStore({ directory }),
		blobRemote: null,
		desktopAuth: {
			baseURL,
			account,
			bootSnapshot: bootstrap,
			get state() {
				return auth.state.status === 'signed-out'
					? { status: 'signed-out' as const }
					: {
							status: auth.state.status,
							principalId: auth.state.account.principalId,
						};
			},
			startSignIn: auth.startSignIn,
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
	const windowAuth = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: origin,
		fetch: windowFetch,
		WebSocket: WindowSocket,
	});
	if (windowAuth.state.status === 'signed-out')
		throw new Error('Missing window account');
	return {
		origin,
		cookie,
		account: windowAuth.state.account,
		windowAuth,
		auth,
		requests,
		localCalls,
		streamCancelled,
		get refreshes() {
			return refreshes;
		},
		get upstreamSockets() {
			return upstreamSockets;
		},
		async [Symbol.asyncDispose]() {
			windowAuth[Symbol.dispose]();
			auth[Symbol.dispose]();
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

test('desktop HTTP preserves request bodies across refresh and decodes compressed responses once', async () => {
	await using context = await setup();
	const response = await context.account.fetch('/api/retry', {
		method: 'POST',
		body: 'same bytes',
		headers: { authorization: 'window-supplied' },
	});
	expect(response.status).toBe(201);
	expect(await response.text()).toBe('forwarded');
	expect(context.refreshes).toBe(1);
	expect(context.requests.map(({ body }) => body)).toEqual([
		'same bytes',
		'same bytes',
	]);
	expect(context.requests.map(({ bearer }) => bearer)).toEqual([
		'Bearer initial',
		'Bearer refreshed',
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
		'/auth/oauth2/token',
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
			.every(({ protocols }) => protocols === 'epicenter, bearer.initial'),
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

async function until(condition: () => boolean) {
	const end = Date.now() + 2000;
	while (!condition()) {
		if (Date.now() > end) throw new Error('Timed out waiting for transport');
		await Bun.sleep(5);
	}
}
