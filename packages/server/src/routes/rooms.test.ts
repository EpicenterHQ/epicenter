/**
 * Rooms route tests: WebSocket credential extraction, upgrade dispatch, and
 * the two rejection shapes (socket close vs plain HTTP).
 *
 * The rooms surface owns its credential extraction (an `Authorization` header
 * first, else a single `bearer.<token>` subprotocol entry) and hands the bare
 * token to the deployment's `ResolveBearerPrincipal`. Nothing rewrites
 * `c.req.raw`, so the backend receives the request with its identity intact;
 * these tests assert object identity, not just header equality.
 */

import { expect, test } from 'bun:test';
import { Principal } from '@epicenter/auth';
import { ROOM_ROUTE } from '@epicenter/sync';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import type {
	Rooms,
	RoomUpgrade,
	RoomUpgradeRejection,
} from '../room/contracts.js';
import type { Env } from '../types.js';
import { mountRoomsApp } from './rooms.js';

const PRINCIPAL = Principal.assert({ id: 'p1' });

/**
 * Build a rooms app around a recording registry and a resolver that accepts
 * exactly `goodToken`, capturing what each seam receives.
 */
function setup({ goodToken = 'good-token' } = {}) {
	const observed: {
		resolvedBearers: string[];
		upgrade?: RoomUpgrade & { roomName: string };
		rejection?: RoomUpgradeRejection;
	} = { resolvedBearers: [] };

	const rooms = {
		get(roomName) {
			return {
				handleUpgrade(upgrade) {
					observed.upgrade = { ...upgrade, roomName };
					return Promise.resolve(new Response('upgraded'));
				},
			};
		},
		rejectUpgrade(rejection) {
			observed.rejection = rejection;
			return Promise.resolve(new Response('rejected'));
		},
	} satisfies Rooms;

	const app = new Hono<Env>();
	app.use('*', async (c, next) => {
		c.set('rooms', rooms);
		await next();
	});
	mountRoomsApp(app, {
		resolveBearerPrincipal: async (_c, bearer) => {
			observed.resolvedBearers.push(bearer);
			return bearer === goodToken ? Ok(PRINCIPAL) : OAuthError.InvalidToken();
		},
	});

	return { app, observed };
}

const ROOM_URL = ROOM_ROUTE.url('https://x', 'r1');

test('a subprotocol bearer upgrade resolves the bare token and upgrades the original request', async () => {
	const { app, observed } = setup();
	const request = new Request(ROOM_URL, {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.good-token',
			upgrade: 'websocket',
		},
	});

	const res = await app.request(request);

	expect(await res.text()).toBe('upgraded');
	// The resolver sees the extracted token, never a faked Authorization header.
	expect(observed.resolvedBearers).toEqual(['good-token']);
	// The backend receives the exact request object (Bun's server.upgrade
	// requires runtime identity), with the server-resolved principal as data.
	expect(observed.upgrade?.request).toBe(request);
	expect(observed.upgrade?.roomName).toBe('principals/p1/rooms/r1');
});

test('an explicit Authorization header wins over the subprotocol bearer', async () => {
	const { app, observed } = setup({ goodToken: 'header-token' });
	const res = await app.request(ROOM_URL, {
		headers: {
			authorization: 'Bearer header-token',
			'sec-websocket-protocol': 'epicenter, bearer.subproto-token',
			upgrade: 'websocket',
		},
	});

	expect(await res.text()).toBe('upgraded');
	expect(observed.resolvedBearers).toEqual(['header-token']);
});

test('failed auth on an upgrade offering the main subprotocol rejects via socket close', async () => {
	const { app, observed } = setup();
	const request = new Request(ROOM_URL, {
		headers: {
			cookie: 'better-auth.session_token=session-1',
			'sec-websocket-protocol': 'epicenter, bearer.bad-token',
			upgrade: 'websocket',
		},
	});

	const res = await app.request(request);

	expect(await res.text()).toBe('rejected');
	expect(observed.resolvedBearers).toEqual(['bad-token']);
	// The reject path gets the same untouched request object.
	expect(observed.rejection?.request).toBe(request);
	expect(observed.rejection?.code).toBe(4401);
	expect(JSON.parse(observed.rejection?.reason ?? '')).toMatchObject({
		name: 'InvalidToken',
	});
});

test('failed auth without the main subprotocol answers plain HTTP, not a socket close', async () => {
	const { app, observed } = setup();
	const res = await app.request(ROOM_URL, {
		headers: {
			'sec-websocket-protocol': 'bearer.bad-token',
			upgrade: 'websocket',
		},
	});

	// A 101 selecting `epicenter` would fail this client's handshake before it
	// could read a close code, so the reject stays a readable HTTP 401 (and the
	// token is never echoed as a negotiated subprotocol).
	expect(res.status).toBe(401);
	expect(observed.rejection).toBeUndefined();
});

test('two bearer subprotocol entries are no credential: rejected without resolving', async () => {
	const { app, observed } = setup();
	const res = await app.request(ROOM_URL, {
		headers: {
			'sec-websocket-protocol': 'epicenter, bearer.token-1, bearer.token-2',
			upgrade: 'websocket',
		},
	});

	expect(await res.text()).toBe('rejected');
	expect(observed.resolvedBearers).toEqual([]);
	expect(observed.rejection?.code).toBe(4401);
});

test('an empty bearer. entry is no credential', async () => {
	const { app, observed } = setup();
	const res = await app.request(ROOM_URL, {
		headers: {
			'sec-websocket-protocol': 'epicenter, bearer.',
			upgrade: 'websocket',
		},
	});

	expect(await res.text()).toBe('rejected');
	expect(observed.resolvedBearers).toEqual([]);
});

test('an authenticated upgrade offering subprotocols without the main one is refused 400', async () => {
	const { app, observed } = setup();
	const res = await app.request(ROOM_URL, {
		headers: {
			'sec-websocket-protocol': 'bearer.good-token',
			upgrade: 'websocket',
		},
	});

	// Auth succeeded (single bearer extracted), but upgrading would force the
	// backend to negotiate against a bearer entry; refuse at the boundary.
	expect(res.status).toBe(400);
	expect(observed.upgrade).toBeUndefined();
});

test('an upgrade offering no subprotocols authenticates via Authorization alone', async () => {
	const { app, observed } = setup();
	const request = new Request(ROOM_URL, {
		headers: {
			authorization: 'Bearer good-token',
			upgrade: 'websocket',
		},
	});

	const res = await app.request(request);

	expect(await res.text()).toBe('upgraded');
	expect(observed.upgrade?.request).toBe(request);
});

test('a non-upgrade request answers 426, never doc bytes', async () => {
	const { app } = setup();
	const res = await app.request(ROOM_URL, {
		headers: { authorization: 'Bearer good-token' },
	});

	expect(res.status).toBe(426);
});
