/** Real loopback traffic through the window adapter, host guards and session Account. */
import { expect, test } from 'bun:test';
import {
	ApiSessionResponse,
	type AuthFetch,
	createSessionAuth,
} from '@epicenter/auth';
import { createDesktopBrokerAuth } from '@epicenter/auth/desktop';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import { createHomeServer } from './server.ts';

async function setup({ verification }: { verification?: Promise<void> } = {}) {
	const sessionRequests: Request[] = [];
	const requests: {
		path: string;
		scope: string | null;
		appId: string | null;
		bearer: string | null;
		body: string;
		cookie: string | null;
	}[] = [];
	const retryReceived = Promise.withResolvers<void>();
	const releaseRetry = Promise.withResolvers<void>();
	const revocations: Promise<Response>[] = [];
	const signInOptions: Array<{ reauthenticate?: boolean }> = [];
	let verifications = 0;
	let nextToken = 'revised';
	let cancelStream: (() => void) | undefined;
	const streamCancelled = Promise.withResolvers<void>();
	const upstream = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
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
			});
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
	// Reserve a port before composing the exact Host guard.
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const { app } = createHomeServer({
		origin,
		launchToken: 'launch',
		staticAssets: { homePage: '<html><head></head></html>', applications: [] },
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
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
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
	const startup = createDesktopBrokerAuth({
		bootstrap,
		brokerBaseURL: origin,
		fetch: windowFetch,
	});
	const windowAuth = startup!;
	const windowState = windowAuth.getState();
	if (windowState.status === 'signed-out')
		throw new Error('Missing window account');
	return {
		origin,
		cookie,
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
		async [Symbol.asyncDispose]() {
			windowAuth[Symbol.dispose]();
			auth[Symbol.dispose]();
			await Promise.resolve();
			await Promise.allSettled(revocations);
			cancelStream?.();
			// stop(true) releases the port at once, but after a cancelled relayed
			// stream its promise does not settle under Bun 1.3.14, so it is not awaited.
			void server.stop(true);
			await upstream.stop(true);
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

test('retirement aborts an HTTP response after its headers and first body chunk', async () => {
	await using context = await setup();
	const response = await context.account.fetch('/api/stream');
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Missing response body');
	expect((await reader.read()).value?.length).toBeGreaterThan(0);
	await context.auth.signOut();
	// Host closes its upstream body; the downstream response terminates too.
	await context.streamCancelled.promise;
	// Read to its end. Linux reports the closed connection to this reader as a
	// reset, so a read may reject; a response that kept streaming times out.
	try {
		while (!(await reader.read()).done);
	} catch {}
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
	await context.signIn('bob');
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
