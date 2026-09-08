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

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createSessionAuth, type PersistedAuthStorage } from '@epicenter/auth';
import type { ReplicaDocument } from '@epicenter/data';
import { defineData, defineTable, field, plainText } from '@epicenter/data';
import { createAccountStore } from '@epicenter/data/direct';
import { attachStoreSync } from '@epicenter/data/sync';
import { asPrincipalId } from '@epicenter/principal';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
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

const definition = defineData({
	id: 'so.epicenter.browserdial',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
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

type AddressedStore = ReplicaDocument & AsyncDisposable & { baseURL: string };

/** An account replica addressed the way an opener stamps one (ADR-0340). */
function openStore(): AddressedStore {
	const live = new Database(':memory:');
	const store = createAccountStore({
		definition,
		sqlite: createBunSqliteAdapter(live),
		dispose: () => live.close(),
	});
	const addressed = Object.create(store) as AddressedStore;
	Object.defineProperties(addressed, {
		appId: { value: definition.id },
		dataId: { value: definition.id },
		generation: { value: 1 },
		baseURL: { value: BASE_URL },
		principalId: { value: asPrincipalId(PRINCIPAL_ID) },
	});
	return addressed;
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
			ledger: () => {
				throw new Error('the sync upgrade reads no ledger');
			},
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
	const store = openStore();
	await using _store = store;
	const connection = attachStoreSync({
		store,
		transport:
			auth.state.status === 'signed-out'
				? (() => {
						throw new Error('No test account');
					})()
				: auth.state.account,
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
