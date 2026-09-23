import { defineStore, defineTable, field, plainText } from '@epicenter/app';
/**
 * The browser's dial, handed to the server's gate, with no header a test author
 * typed.
 *
 * Both halves of the store handshake are exercised through the code that builds
 * the value: `STORE_SYNC_ROUTE.address` for the URL and the main subprotocol,
 * `AuthClient.openWebSocket` for the bearer entry, `formatSubprotocols` for the
 * header the browser's `WebSocket` constructor would have written, and
 * `mountStoreSyncApp` for the check that reads it back. A test that spells the
 * header itself passes while the client offers nothing, which is exactly what
 * shipped: the client dropped the subprotocol list and every upgrade came back
 * 400.
 *
 * The negative at the end is the regression: strip the main subprotocol out of
 * what the client offered and the gate must refuse it, so the positive above
 * cannot be passing for a reason other than the client offering it.
 */

import { expect, test } from 'bun:test';

import { openMemory } from '@epicenter/app/memory';
import { attachStoreSync } from '@epicenter/app/sync';
import { createSessionAuth, type PersistedAuthStorage } from '@epicenter/auth';
import { asPrincipalId } from '@epicenter/principal';
import {
	bearerSubprotocol,
	formatSubprotocols,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { OAuthError } from '../auth/oauth-errors.js';
import type { Env } from '../types.js';
import { mountStoreSyncApp, type StoreAuthorityStub } from './mount.js';

const BASE_URL = 'http://localhost:8787';
const PRINCIPAL_ID = 'user-1';
const ACCESS_TOKEN = 'access-token';

const definition = defineStore({
	id: 'so.epicenter.browserdial',
	kv: {},
	tables: {
		notes: defineTable({
			fields: { title: field.string() },
			body: plainText(),
		}),
	},
});

/** One recorded `new WebSocket(url, protocols)`, the dial as a browser makes it. */
type Opening = { url: string; protocols: string[] };

/**
 * The signed-in browser client Honeycrisp boots with: a persisted cell holding
 * a live session, `/api/session` confirming the same principal, and a `WebSocket`
 * that records instead of connecting.
 */
function createBrowserAuth(onOpening: (opening: Opening) => void) {
	const storage: PersistedAuthStorage = {
		initial: {
			token: ACCESS_TOKEN,
			principalId: asPrincipalId(PRINCIPAL_ID),
		},
		set: async () => {},
	};
	// Enough of a socket for the driver to attach its four listeners to; it
	// never opens, so nothing beyond the recorded dial happens.
	const WebSocketRecorder = class {
		binaryType = 'blob';
		constructor(url: string | URL, protocols: string[] = []) {
			onOpening({ url: String(url), protocols });
		}
		addEventListener() {}
		close() {}
	} as unknown as typeof WebSocket;
	return createSessionAuth({
		authorityId: 'epicenter-api',
		baseURL: BASE_URL,
		persistedAuthStorage: storage,
		launcher: { startSignIn: async () => ({ status: 'launched' }) },
		WebSocket: WebSocketRecorder,
		fetch: async (input) => {
			if (String(input).endsWith('/api/session')) {
				return new Response(
					JSON.stringify({
						principalId: PRINCIPAL_ID,
						email: `${PRINCIPAL_ID}@example.com`,
					}),
					{ headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(null, { status: 204 });
		},
	});
}

/** The real store; its transport address is supplied when sync attaches. */
function openStore() {
	return openMemory(definition);
}

/**
 * The real gate, over an authority that records what reached it and answers a
 * plain 200. `mountStoreSyncApp` passes any non-101 straight back, so a request
 * the authority saw is a request the subprotocol check admitted.
 */
function createServer(
	answer: () => Response = () =>
		new Response('reached the authority', { status: 200 }),
) {
	const seen: Request[] = [];
	const authority: StoreAuthorityStub = {
		fetch: async (request) => {
			seen.push(request);
			return answer();
		},
	};
	const app = new Hono<Env>();
	mountStoreSyncApp(app, {
		resolveBearerPrincipal: async (_c, bearer) =>
			bearer === ACCESS_TOKEN
				? Ok({ id: asPrincipalId(PRINCIPAL_ID) })
				: OAuthError.InvalidToken(),
		resolveStore: () => ({
			authority: () => authority,
			ledger: () => ({
				initial: () => 1,
				allocate: () => 1,
				admit() {},
				holds: () => true,
				list: () => [],
			}),
		}),
	});
	return { app, seen };
}

/** The upgrade a browser's `WebSocket` sends for one recorded opening. */
function upgradeRequest(opening: Opening, protocols = opening.protocols) {
	return new Request(opening.url.replace(/^ws/, 'http'), {
		headers: {
			Upgrade: 'websocket',
			'sec-websocket-protocol': formatSubprotocols(protocols),
		},
	});
}

async function dial(): Promise<Opening> {
	const { promise: opened, resolve } = Promise.withResolvers<Opening>();
	const auth = createBrowserAuth(resolve);
	const state = auth.getState();
	const store = await openStore();
	await using _store = store;
	const connection = attachStoreSync({
		onRetired() {
			throw new Error('Unexpected retirement in this transport test');
		},
		store,
		address: {
			baseURL: BASE_URL,
			appId: definition.id,
			scope: 'personal',
			dataId: definition.id,
			generation: 1,
		},
		transport:
			state.status === 'signed-out'
				? (() => {
						throw new Error('No test account');
					})()
				: state.account,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	// The dial waits on `/api/session` before the constructor is reached.
	const opening = await opened;
	connection[Symbol.dispose]();
	auth[Symbol.dispose]();
	return opening;
}

test('the browser offers the main subprotocol and the bearer, in that order', async () => {
	const opening = await dial();

	expect(opening.protocols).toEqual([
		MAIN_SUBPROTOCOL,
		bearerSubprotocol(ACCESS_TOKEN),
	]);
	const url = new URL(opening.url);
	expect(url.protocol).toBe('ws:');
	expect(url.pathname).toBe('/api/store/v1/sync');
	expect(url.searchParams.get('appId')).toBe(definition.id);
	expect(url.searchParams.get('scope')).toBe('personal');
	expect(url.searchParams.get('dataId')).toBe(definition.id);
	expect(url.searchParams.get('generation')).toBe('1');
	expect(url.searchParams.get('cursor')).toBe('0');
});

test('the server admits the upgrade the browser actually makes', async () => {
	const opening = await dial();
	const { app, seen } = createServer();

	const response = await app.request(upgradeRequest(opening));

	expect(response.status).toBe(200);
	expect(seen).toHaveLength(1);
});

test('the same upgrade without the main subprotocol is refused', async () => {
	const opening = await dial();
	const { app, seen } = createServer();

	const response = await app.request(
		upgradeRequest(
			opening,
			opening.protocols.filter((protocol) => protocol !== MAIN_SUBPROTOCOL),
		),
	);

	expect(response.status).toBe(400);
	expect(seen).toEqual([]);
});

test('the accepted upgrade echoes the main subprotocol and never the bearer', async () => {
	const opening = await dial();
	const { app } = createServer(() => new Response(null, { status: 101 }));

	const response = await app.request(upgradeRequest(opening));

	expect(response.status).toBe(101);
	expect(response.headers.get('sec-websocket-protocol')).toBe(MAIN_SUBPROTOCOL);
	expect(response.headers.get('sec-websocket-protocol')).not.toContain(
		ACCESS_TOKEN,
	);
});

test('Shared requests are refused before resolving an authority', async () => {
	const opening = await dial();
	const url = new URL(opening.url);
	url.searchParams.set('scope', 'shared');
	const { app, seen } = createServer();
	const response = await app.request(
		upgradeRequest({ ...opening, url: url.toString() }),
	);
	expect(response.status).toBe(403);
	expect(seen).toEqual([]);
});

test('a browser cannot select another Personal owner through its socket query', async () => {
	const opening = await dial();
	for (const key of ['owner', 'principalId']) {
		const url = new URL(opening.url);
		url.searchParams.set(key, 'another-user');
		const { app, seen } = createServer();
		const response = await app.request(
			upgradeRequest({ ...opening, url: url.toString() }),
		);
		expect(response.status).toBe(403);
		expect(seen).toEqual([]);
	}
});
