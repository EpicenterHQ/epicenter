import { defineApp, defineTable, field, plainText } from '@epicenter/app';

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

import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { MAIN_SUBPROTOCOL } from '@epicenter/sync';
import type {
	SocketTransport,
	WebSocketAddress,
} from '@epicenter/sync/transport';
import { openAccountStore } from '../store/store.js';
import { attachStoreSync } from './attach.js';
import { encodeFrame } from './frames.js';

const database = defineApp({
	id: 'so.epicenter.attach-test',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

const address = {
	baseURL: 'https://api.epicenter.test',
	dataId: database.id,
	generation: 1,
};

function openStore() {
	const live = new Database(':memory:');
	return openAccountStore({
		definition: database,
		sqlite: createBunSqliteAdapter(live),
		dispose: () => live.close(),
	});
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
		onRetired: () => undefined,
		store,
		address,
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
		onRetired: () => undefined,
		store,
		address,
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
		onRetired: () => undefined,
		store,
		address,
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
		onRetired: () => undefined,
		store,
		address,
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
		onRetired: () => undefined,
		store,
		address,
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
	const listeners = new Map<string, (event: Event) => void>();
	const socket = {
		binaryType: '',
		readyState,
		addEventListener: (event: string, listen: (event: Event) => void) =>
			listeners.set(event, listen),
		send: () => {},
		close: () => {},
	} as unknown as WebSocket;
	return {
		socket,
		fire: (event: string) => listeners.get(event)?.(new Event(event)),
		receive(kind: 'admitted' | 'retired') {
			listeners.get('message')?.(
				new MessageEvent('message', { data: encodeFrame({ kind }).buffer }),
			);
		},
	};
}

test('an already open socket waits for admission without needing an open event', async () => {
	const store = await openStore();
	await using _store = store;
	// What a Worker's upgrade produces: `fetch` answers with an accepted
	// socket, which is live and will never fire `open`. Waiting for one leaves
	// the driver holding a healthy socket it never sends on, and nothing times
	// out.
	const { socket, receive } = createSocket(1);
	const { transport } = createTransport(() => Promise.resolve(socket));
	const connection = attachStoreSync({
		onRetired: () => undefined,
		store,
		address,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(connection.status().connected).toBe(false);
	receive('admitted');
	expect(connection.status().connected).toBe(true);
});

test('a connecting socket attaches only after opening and admission', async () => {
	const store = await openStore();
	await using _store = store;
	const { socket, fire, receive } = createSocket(0);
	const { transport } = createTransport(() => Promise.resolve(socket));
	const connection = attachStoreSync({
		onRetired: () => undefined,
		store,
		address,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
	});
	using _ = connection;

	await Bun.sleep(1);
	expect(connection.status().connected).toBe(false);
	fire('open');
	expect(connection.status().connected).toBe(false);
	receive('admitted');
	expect(connection.status().connected).toBe(true);
});

test('authenticated retirement reaches the App owner once through the socket adapter', async () => {
	await using store = await openStore();
	const { socket, receive } = createSocket(1);
	const { transport } = createTransport(() => Promise.resolve(socket));
	let retired = 0;
	using connection = attachStoreSync({
		store,
		address,
		transport,
		onTransportError: (cause) => {
			throw cause;
		},
		onRetired() {
			retired += 1;
			expect(store.sync.status()?.retired).toBe(true);
		},
	});
	await Bun.sleep(1);
	receive('retired');
	receive('retired');
	receive('admitted');
	expect(retired).toBe(1);
	expect(connection.status().connected).toBe(false);
});
