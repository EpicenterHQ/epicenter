import { defineTable, field, plainText } from '@epicenter/data/definition';
/**
 * What the shared dial has to get right: the address it asks for, including
 * the subprotocol the server requires, and how it classifies a rejection.
 *
 * The driver underneath is already covered by `connection.test.ts` against a
 * real hub and authority. What is only here is the translation layer, and it is
 * exactly where being wrong is expensive: calling a network blip permanent
 * gives up on a replica that would have recovered, and calling a refusal
 * transient spins the backoff against it forever.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { defineData } from '@epicenter/data/definition';
import { asPrincipalId } from '@epicenter/principal';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { MAIN_SUBPROTOCOL } from '@epicenter/sync';
import type {
	SocketTransport,
	WebSocketAddress,
} from '@epicenter/sync/transport';
import { openAccountStore, type ReplicaDocument } from '../store/store.js';
import { attachStoreSync } from './attach.js';

const database = defineData({
	id: 'so.epicenter.attach-test',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

type AddressedTestStore = ReplicaDocument &
	AsyncDisposable & {
		baseURL: string;
		principalId: ReturnType<typeof asPrincipalId>;
	};

async function openStore(): Promise<AddressedTestStore> {
	const live = new Database(':memory:');
	const db = await openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(live),
		dispose: () => live.close(),
	});
	const addressed = Object.create(db) as AddressedTestStore;
	// The whole address, the way an opener stamps it (ADR-0340). The dial reads
	// the data id and the generation off the store rather than beside it.
	Object.defineProperties(addressed, {
		appId: { value: database.id },
		dataId: { value: database.id },
		generation: { value: 1 },
		baseURL: { value: 'https://api.epicenter.test' },
		principalId: { value: asPrincipalId('alice') },
	});
	return addressed;
}

/** Record every dial and settle it however the test says. */
function createTransport(
	open: (address: WebSocketAddress) => Promise<WebSocket>,
) {
	const dials: WebSocketAddress[] = [];
	const transport: SocketTransport = {
		openWebSocket(address) {
			dials.push(address);
			return open(address);
		},
	};
	return { transport, dials };
}

test('the first dial names the dataId, a cursor of zero, and the main subprotocol', async () => {
	const store = await openStore();
	await using _store = store;
	const { transport, dials } = createTransport(
		() => new Promise<WebSocket>(() => {}),
	);
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	expect(dials).toHaveLength(1);
	const dial = dials[0] as WebSocketAddress;
	// The subprotocol travels with the URL: the server refuses a non-empty
	// offer without it (ADR-0346).
	expect(dial.protocols).toEqual([MAIN_SUBPROTOCOL]);
	const url = new URL(dial.url);
	expect(url.protocol).toBe('wss:');
	expect(url.pathname).toBe('/api/store/v1/sync');
	expect(url.searchParams.get('dataId')).toBe(database.id);
	expect(url.searchParams.get('cursor')).toBe('0');
	// A replica that has never synced belongs to no document yet, so it must
	// not claim one (ADR-0231).
	expect(url.searchParams.has('document')).toBe(false);
});

test('the store answers for the connection driving it, and stops when it goes', async () => {
	const store = await openStore();
	await using _store = store;
	// Nothing attached, so there is nothing to report. A surface renders that
	// the same way it renders a refusal it cannot act on: no status line
	// (ADR-0340).
	expect(store.sync.status()).toBeUndefined();

	const { transport } = createTransport(() => new Promise<WebSocket>(() => {}));
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});

	expect(store.sync.status()).toEqual(connection.status());
	connection[Symbol.dispose]();
	expect(store.sync.status()).toBeUndefined();
});

test('a denial is reported as a refusal code and is not a transport error', async () => {
	const store = await openStore();
	await using _store = store;
	const denial = {
		name: 'OpenWebSocketDenied',
		message: 'signed out',
		code: 'signed-out',
	};
	const { transport } = createTransport(() => Promise.reject(denial));
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => transportErrors.push(cause),
	});
	using _ = connection;

	await Bun.sleep(1);
	// Not a transport error, and readable off the store: a refusal is what a
	// status line renders, and there is no second channel for it.
	expect(transportErrors).toEqual([]);
	expect(store.sync.status()?.refusal).toBe('signed-out');
	expect(store.sync.status()?.lastReconnect).toBe('refused');
});

test('an unrecognised rejection is a transport error and a close', async () => {
	const store = await openStore();
	await using _store = store;
	const cause = new TypeError('Failed to fetch');
	const { transport } = createTransport(() => Promise.reject(cause));
	const transportErrors: unknown[] = [];
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (error) => transportErrors.push(error),
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(transportErrors).toEqual([cause]);
	expect(connection.status().refusal).toBeUndefined();
	expect(connection.status().lastReconnect).toBe('closed');
});

test('abandoning an attempt closes a socket that arrives late', async () => {
	const store = await openStore();
	await using _store = store;
	let closes = 0;
	const socket = {
		binaryType: '',
		addEventListener: () => {},
		close: () => closes++,
	} as unknown as WebSocket;
	const arrival = Promise.withResolvers<WebSocket>();
	const { transport } = createTransport(() => arrival.promise);
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});

	connection[Symbol.dispose]();
	arrival.resolve(socket);
	await Bun.sleep(1);
	expect(closes).toBe(1);
});

/**
 * A socket recorder that starts in whatever state a transport hands back, and
 * keeps the listeners so a test can fire the events itself.
 */
function createSocket(readyState: number) {
	const listeners = new Map<string, () => void>();
	const socket = {
		binaryType: '',
		readyState,
		addEventListener: (event: string, listen: () => void) =>
			listeners.set(event, listen),
		send: () => {},
		close: () => {},
	} as unknown as WebSocket;
	return { socket, fire: (event: string) => listeners.get(event)?.() };
}

test('a socket handed back already open is attached without an open event', async () => {
	const store = await openStore();
	await using _store = store;
	// What a Worker's upgrade produces: `fetch` answers with an accepted
	// socket, which is live and will never fire `open`. Waiting for one leaves
	// the driver holding a healthy socket it never sends on, and nothing times
	// out.
	const { socket } = createSocket(1);
	const { transport } = createTransport(() => Promise.resolve(socket));
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(connection.status().connected).toBe(true);
});

test('a connecting socket is attached only once it opens', async () => {
	const store = await openStore();
	await using _store = store;
	const { socket, fire } = createSocket(0);
	const { transport } = createTransport(() => Promise.resolve(socket));
	const connection = attachStoreSync({
		store,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(connection.status().connected).toBe(false);
	fire('open');
	expect(connection.status().connected).toBe(true);
});
