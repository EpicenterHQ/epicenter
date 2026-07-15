/**
 * `Room` Durable Object tests.
 *
 * Exercises the relay WebSocket through the live `Room`. A y-protocols update
 * from one socket fans out to peer
 * sockets but not its origin, and a malformed binary frame is logged
 * rather than thrown out of the message handler.
 *
 * Bun's test runtime does not provide Cloudflare Workers globals, so we
 * mock `cloudflare:workers` (DurableObject base class), shim
 * `WebSocketPair` / `WebSocket`, and drive the Room via its public
 * `fetch()` and `webSocketClose()` overrides directly.
 */

import { describe, expect, mock, test } from 'bun:test';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

// ────────────────────────────────────────────────────────────────────────────
// CLOUDFLARE WORKERS SHIMS
// ────────────────────────────────────────────────────────────────────────────

// `WebSocket` is a host global in real Workers but Bun ships its own
// WebSocket class without a `WebSocketPair`. Provide a minimal stub good
// enough for the Room's send/close/readyState surface.
class StubWebSocket {
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState: number = StubWebSocket.OPEN;
	sent: Array<Uint8Array | string> = [];
	closeCalls: Array<{ code: number; reason: string }> = [];
	private attachment: unknown = null;
	private failOnSend = false;

	send(data: Uint8Array | string): void {
		if (this.failOnSend) throw new Error('wedged');
		if (this.readyState !== StubWebSocket.OPEN) {
			throw new Error('socket not open');
		}
		this.sent.push(data);
	}

	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = StubWebSocket.CLOSED;
	}

	serializeAttachment(value: unknown): void {
		this.attachment = value;
	}

	deserializeAttachment(): unknown {
		return this.attachment;
	}

	// Test-only: simulate a wedged peer whose `send` always throws.
	__wedge(): void {
		this.failOnSend = true;
	}

	// Test-only: pull text frames out of `sent`.
	textFrames(): string[] {
		return this.sent.filter((f): f is string => typeof f === 'string');
	}
}

class StubWebSocketPair {
	0: StubWebSocket;
	1: StubWebSocket;
	constructor() {
		this[0] = new StubWebSocket();
		this[1] = new StubWebSocket();
	}
}

// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocket ??= StubWebSocket;
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketPair ??= StubWebSocketPair;

// `cloudflare:workers` is not resolvable in Bun. Mock it with a barebones
// DurableObject base class that records `ctx` and `env` so Room's
// constructor can run.
mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

// ────────────────────────────────────────────────────────────────────────────
// DURABLE OBJECT CTX STUB
// ────────────────────────────────────────────────────────────────────────────

type SqlRow = { id: number; data: ArrayBuffer };

/**
 * In-memory SQL surface that satisfies the subset of `ctx.storage.sql`
 * the Room touches: schema DDL, SELECT all updates, INSERT, DELETE,
 * COUNT, and `databaseSize`.
 */
function makeSqlStorage() {
	const updates: SqlRow[] = [];
	let nextId = 1;

	function exec(
		query: string,
		...params: unknown[]
	): { toArray(): SqlRow[]; one(): { count: number } } {
		const q = query.trim().toUpperCase();
		if (q.startsWith('CREATE TABLE')) {
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('SELECT DATA FROM UPDATES')) {
			return {
				toArray: () => [...updates],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('SELECT COUNT(*)')) {
			return {
				toArray: () => [],
				one: () => ({ count: updates.length }),
			};
		}
		if (q.startsWith('INSERT INTO UPDATES')) {
			const blob = params[0] as Uint8Array;
			const copy = new ArrayBuffer(blob.byteLength);
			new Uint8Array(copy).set(blob);
			updates.push({ id: nextId++, data: copy });
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		if (q.startsWith('DELETE FROM UPDATES')) {
			updates.length = 0;
			return { toArray: () => [], one: () => ({ count: 0 }) };
		}
		throw new Error(`Unsupported SQL: ${query}`);
	}

	return {
		exec,
		get databaseSize() {
			return updates.reduce((acc, r) => acc + r.data.byteLength, 0);
		},
		transactionSync(fn: () => void) {
			fn();
		},
	};
}

function makeStorage() {
	let alarm: number | null = null;
	return {
		sql: makeSqlStorage(),
		async setAlarm(when: number) {
			alarm = when;
		},
		async getAlarm() {
			return alarm;
		},
		async deleteAlarm() {
			alarm = null;
		},
		async deleteAll() {},
	};
}

type StubCtx = {
	storage: ReturnType<typeof makeStorage>;
	acceptedSockets: StubWebSocket[];
	acceptWebSocket(ws: StubWebSocket): void;
	getWebSockets(): StubWebSocket[];
	blockConcurrencyWhile(fn: () => Promise<unknown>): Promise<void>;
	setWebSocketAutoResponse(_pair: unknown): void;
};

function makeCtx(): StubCtx {
	const acceptedSockets: StubWebSocket[] = [];
	return {
		storage: makeStorage(),
		acceptedSockets,
		acceptWebSocket(ws: StubWebSocket) {
			acceptedSockets.push(ws);
		},
		getWebSockets() {
			return acceptedSockets.slice();
		},
		async blockConcurrencyWhile(fn: () => Promise<unknown>) {
			await fn();
		},
		setWebSocketAutoResponse(_pair: unknown) {},
	};
}

// `WebSocketRequestResponsePair` is a global constructor in real Workers.
// biome-ignore lint/suspicious/noExplicitAny: globalThis shim
(globalThis as any).WebSocketRequestResponsePair ??= class {
	constructor(_a: string, _b: string) {}
};

// ────────────────────────────────────────────────────────────────────────────
// HELPERS
// ────────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: Room exposes typed CF surfaces
// (DurableObject, WebSocket) we are stubbing; cast to keep tests pragmatic.
type RoomLike = any;

async function makeRoom(): Promise<{ room: RoomLike; ctx: StubCtx }> {
	// Dynamic import so the cloudflare:workers mock is in place.
	const { Room } = await import('./durable-object.js');
	const ctx = makeCtx();
	// biome-ignore lint/suspicious/noExplicitAny: env unused in our scenarios
	const room = new Room(ctx as any, {} as any) as RoomLike;
	// blockConcurrencyWhile is fire-and-forget in real CF; await readiness here.
	await Promise.resolve();
	return { room, ctx };
}

function upgradeRequest(): Request {
	return new Request('https://relay.test/', {
		method: 'GET',
		headers: {
			Upgrade: 'websocket',
			'sec-websocket-protocol': 'epicenter',
		},
	});
}

/** Drive an upgrade end-to-end and return the server-side socket. */
async function upgrade(
	room: RoomLike,
	_label?: string,
): Promise<StubWebSocket> {
	const response = await room.fetch(upgradeRequest());
	expect(response.status).toBe(101);
	const ctx = room.ctx as StubCtx;
	return ctx.acceptedSockets[ctx.acceptedSockets.length - 1]!;
}

/** Wrap a frame as the `ArrayBuffer` `webSocketMessage` expects for binary input. */
function toArrayBuffer(frame: Uint8Array): ArrayBuffer {
	return frame.slice().buffer;
}

/** A well-formed binary sync frame: sync sub-type varint + payload. */
function frameWithSyncType(
	syncType: number,
	payload: Uint8Array = new Uint8Array(0),
): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, syncType);
		encoding.writeVarUint8Array(enc, payload);
	});
}

// ────────────────────────────────────────────────────────────────────────────
// TESTS
// ────────────────────────────────────────────────────────────────────────────

describe('Room sync: binary update fan-out', () => {
	test('STEP1 frames receive a STEP2 reply', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		const replies = ws.sent
			.slice(before)
			.filter((frame): frame is Uint8Array => frame instanceof Uint8Array);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('an update from one socket reaches peers but not its origin', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');

		const beforeA = wsA.sent.length;
		const beforeB = wsB.sent.length;

		// wsA sends a sync UPDATE frame carrying fresh doc state.
		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		const frame = encodeSyncUpdate({
			update: Y.encodeStateAsUpdateV2(source),
		});
		await room.webSocketMessage(wsA, toArrayBuffer(frame));

		// The peer receives one new binary frame; the origin receives none.
		const newBinary = (ws: StubWebSocket, before: number) =>
			ws.sent.slice(before).filter((f) => f instanceof Uint8Array);
		expect(newBinary(wsB, beforeB).length).toBe(1);
		expect(newBinary(wsA, beforeA).length).toBe(0);
	});

	test('truncated frames are caught without throwing out of the handler', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		const truncated = new Uint8Array([SYNC_MESSAGE_TYPE.UPDATE, 10]);

		await room.webSocketMessage(ws, toArrayBuffer(truncated));

		// Handler swallows the decode error: no response, no close.
		// (Whether it logs and via which logger is implementation detail.)
		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});

	test('decodable out-of-range sync sub-types are no-ops', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;

		await room.webSocketMessage(ws, toArrayBuffer(frameWithSyncType(99)));

		expect(ws.sent.slice(before)).toEqual([]);
		expect(ws.closeCalls).toEqual([]);
	});
});

describe('Room connection lifetime', () => {
	test('a socket past the max lifetime is closed with the reconnect code and its frame is dropped', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		const before = ws.sent.length;
		// Age the connection past MAX_CONNECTION_LIFETIME_MS (30 min). The
		// lifetime bound is now a RoomCore invariant that reads `authenticatedAt` from
		// the core's connection set; the stub keeps the attachment by reference and
		// the core holds the same object, so mutating it in place is exactly what
		// the core sees (in production authenticatedAt is simply 31 min old).
		const attachment = ws.deserializeAttachment() as {
			authenticatedAt: number;
		};
		attachment.authenticatedAt = Date.now() - 31 * 60_000;

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		// Closed with the transient reconnect code (not the permanent 4401),
		// and the STEP1 produced no STEP2 reply because the frame was dropped.
		expect(ws.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(ws.sent.slice(before)).toEqual([]);
	});

	test('a fresh socket is served normally and not closed', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');

		await room.webSocketMessage(
			ws,
			toArrayBuffer(encodeSyncStep1({ doc: new Y.Doc() })),
		);

		expect(ws.closeCalls).toEqual([]);
	});

	test('the alarm sweep closes an idle over-age socket with no inbound frame', async () => {
		const { room } = await makeRoom();
		const wsOld = await upgrade(room, 'A');
		const wsFresh = await upgrade(room, 'B');
		// Age wsOld past the lifetime in place (the core holds the same object);
		// it never sends a frame, the idle case the per-message check cannot catch
		// and the alarm sweep exists to cover.
		const attachment = wsOld.deserializeAttachment() as {
			authenticatedAt: number;
		};
		attachment.authenticatedAt = Date.now() - 31 * 60_000;

		await room.alarm();

		expect(wsOld.closeCalls.map((c) => c.code)).toEqual([4408]);
		expect(wsFresh.closeCalls).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TEXT FRAMES
// ────────────────────────────────────────────────────────────────────────────

describe('Room: malformed text frames', () => {
	test('an unknown text frame type closes the socket with 4400', async () => {
		const { room } = await makeRoom();
		const callerWs = await upgrade(room, 'caller');

		await room.webSocketMessage(
			callerWs,
			JSON.stringify({ type: 'totally_bogus' }),
		);

		expect(callerWs.closeCalls).toHaveLength(1);
		expect(callerWs.closeCalls[0]?.code).toBe(4400);
	});
});
