/**
 * Signed sessions survive a real WebSocket constructor and the hosted store gate.
 * The credential comes from the handoff endpoint, is encoded on the wire, and
 * resolves through Better Auth. Revocation refuses the next admission.
 */
import { expect, test } from 'bun:test';
import { bearerSubprotocol, MAIN_SUBPROTOCOL } from '@epicenter/sync';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { makeSignature } from 'better-auth/crypto';
import { Hono } from 'hono';
import { resolveRequestSessionPrincipal } from '../middleware/require-auth.js';
import { mountStoreSyncApp } from '../store-sync/mount.js';
import type { CloudEnv } from '../types.js';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { extractUpgradeBearer } from './extract-upgrade-bearer.js';
import { authPlugins } from './plugins.js';

test('an issued session opens the hosted socket and revocation refuses its next admission', async () => {
	const upgraded = new WeakSet<Request>();
	let handler: (request: Request) => Promise<Response> = async () =>
		new Response(null, { status: 503 });
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const response = await handler(request);
			return upgraded.has(request) ? undefined : response;
		},
		websocket: { message() {} },
	});
	let socket: WebSocket | undefined;
	try {
		const baseURL = server.url.origin;
		const callback = 'https://app.example.test/auth/callback';
		const secret = 'signed-socket-fixture-secret-1234567890';
		const db: MemoryDB = {
			user: [],
			account: [],
			session: [],
			verification: [],
			passkey: [],
		};
		const auth = betterAuth({
			...BASE_AUTH_CONFIG,
			baseURL,
			secret,
			database: memoryAdapter(db),
			trustedOrigins: [baseURL, 'https://app.example.test'],
			plugins: authPlugins(baseURL, [callback]),
		});
		const ctx = await auth.$context;
		const user = await ctx.internalAdapter.createUser({
			name: 'Alice',
			email: 'alice@example.test',
			emailVerified: true,
		});
		const source = await ctx.internalAdapter.createSession(user.id);
		const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${source.token}.${await makeSignature(source.token, secret)}`)}`;
		const verifier = 'v'.repeat(43);
		const challenge = Buffer.from(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
		).toString('base64url');
		const state = 's'.repeat(43);
		const issued = await auth.handler(
			new Request(`${baseURL}/auth/session/authorize`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: baseURL,
					cookie,
				},
				body: JSON.stringify({ callback, challenge, state }),
			}),
		);
		expect(issued.status).toBe(200);
		const destination = new URL(((await issued.json()) as { url: string }).url);
		const redeemed = await auth.handler(
			new Request(`${baseURL}/auth/session/redeem`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					callback,
					state,
					verifier,
					code: destination.searchParams.get('code'),
				}),
			}),
		);
		expect(redeemed.status).toBe(200);
		const { token } = (await redeemed.json()) as { token: string };
		expect(token).toContain('=');
		expect(
			() =>
				new WebSocket(baseURL.replace('http:', 'ws:'), [
					MAIN_SUBPROTOCOL,
					`bearer.${token}`,
				]),
		).toThrow();

		const app = new Hono<CloudEnv>();
		let admittedPrincipal: string | undefined;
		app.use('*', async (c, next) => {
			c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
			await next();
			admittedPrincipal = c.var.principal?.id;
		});
		mountStoreSyncApp(app, {
			resolveBearerPrincipal: resolveRequestSessionPrincipal,
			resolveStore: () => ({
				authority: () => ({
					async fetch(request) {
						expect(extractUpgradeBearer(request.headers)).toBe(token);
						expect(request.headers.get('sec-websocket-protocol')).toContain(
							'%3D',
						);
						expect(request.url).not.toContain(token);
						// Bun selects from the request header; response overrides append a second
						// protocol header in 1.3.1. Consume the credential before its native upgrade.
						request.headers.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
						if (!server.upgrade(request))
							return new Response(null, { status: 400 });
						upgraded.add(request);
						return new Response(null, { status: 204 });
					},
				}),
				ledger: () => {
					throw new Error('socket admission does not use ledger');
				},
			}),
		});
		handler = async (request) => app.fetch(request);
		const url = `${baseURL.replace('http:', 'ws:')}/api/store/v1/sync?dataId=so.epicenter.socketproof&generation=1`;
		socket = new WebSocket(url, [MAIN_SUBPROTOCOL, bearerSubprotocol(token)]);
		await new Promise<void>((resolve, reject) => {
			socket!.addEventListener('open', () => resolve(), { once: true });
			socket!.addEventListener(
				'close',
				() => reject(new Error('socket closed before opening')),
				{ once: true },
			);
			socket!.addEventListener(
				'error',
				() => reject(new Error('socket refused')),
				{ once: true },
			);
		});
		expect(socket.protocol).toBe(MAIN_SUBPROTOCOL);
		expect(admittedPrincipal).toBe(user.id);
		const closed = new Promise<void>((resolve) =>
			socket!.addEventListener('close', () => resolve(), { once: true }),
		);
		socket.close();
		await closed;
		await ctx.internalAdapter.deleteSession(
			token.slice(0, token.lastIndexOf('.')),
		);
		const refused = await app.request(url.replace('ws:', 'http:'), {
			headers: {
				upgrade: 'websocket',
				'sec-websocket-protocol': `${MAIN_SUBPROTOCOL}, ${bearerSubprotocol(token)}`,
			},
		});
		expect(refused.status).toBe(401);
	} finally {
		socket?.close();
		void server.stop(true);
	}
});

test('malformed encoded credentials and duplicate bearer protocols cannot authenticate', () => {
	for (const protocols of [
		'epicenter, bearer.%ZZ',
		'epicenter, bearer.a, bearer.b',
		'epicenter, bearer.',
	]) {
		expect(
			extractUpgradeBearer(
				new Headers({ 'sec-websocket-protocol': protocols }),
			),
		).toBeNull();
	}
});
