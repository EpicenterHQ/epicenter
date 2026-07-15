/**
 * `Room` Durable Object tests.
 *
 * Exercises the relay's two WebSocket wire surfaces through the live `Room`:
 *
 * Presence: the relay broadcasts one `presence` text frame carrying the
 * FULL peer list on every connection change. Covers the directed frame
 * on upgrade, the first-socket rebroadcast, multi-tab dedup (the list is
 * unchanged so no rebroadcast), the debounced rebroadcast on last-socket
 * close, graceful handoff cancellation, the 4401 grace bypass, and
 * broadcast resilience against wedged sockets.
 *
 * Binary sync: a y-protocols update from one socket fans out to peer
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

function upgradeRequest(nodeId: string, principalId = 'user-test'): Request {
	return new Request(
		`https://relay.test/?principalId=${principalId}&nodeId=${nodeId}`,
		{
			method: 'GET',
			headers: {
				Upgrade: 'websocket',
				'sec-websocket-protocol': 'epicenter',
			},
		},
	);
}

/** Drive an upgrade end-to-end and return the server-side socket. */
async function upgrade(
	room: RoomLike,
	nodeId: string,
	principalId = 'user-test',
): Promise<StubWebSocket> {
	const response = await room.fetch(upgradeRequest(nodeId, principalId));
	expect(response.status).toBe(101);
	// In real CF the response carries the CLIENT socket on `response.webSocket`;
	// Bun's `Response` ignores the field but the server socket is the
	// most-recently `acceptWebSocket`'d one.
	const ctx = room.ctx as StubCtx;
	const serverSocket = ctx.acceptedSockets[ctx.acceptedSockets.length - 1]!;
	return serverSocket;
}

type WirePeer = {
	nodeId: string;
	connectedAt: number;
	agentId?: string;
};
type PresenceFrame = { type: 'presence'; peers: WirePeer[] };

/** Parse text frames of a given `type` off the wire. */
function jsonFrames(
	ws: StubWebSocket,
	type: string,
): Array<Record<string, unknown>> {
	return ws
		.textFrames()
		.map((t) => {
			try {
				return JSON.parse(t) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((f): f is Record<string, unknown> => f !== null && f.type === type);
}

/** Parse all `presence` text frames out of the wire. */
function presenceFrames(ws: StubWebSocket): PresenceFrame[] {
	return jsonFrames(ws, 'presence').filter((p): p is PresenceFrame =>
		Array.isArray((p as { peers?: unknown }).peers),
	);
}

/** Project a presence frame down to just its nodeIds, for assertions
 *  that don't care about connectedAt timestamps. */
function nodeIds(frame: PresenceFrame): string[] {
	return frame.peers.map((d) => d.nodeId);
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

describe('Room presence: directed frame on upgrade', () => {
	test('first socket receives an empty node list', async () => {
		const { room } = await makeRoom();
		const ws = await upgrade(room, 'A');
		expect(presenceFrames(ws).map(nodeIds)).toEqual([[]]);
	});

	test('second node upgrade sees the first node in its directed frame', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		expect(presenceFrames(ws).map(nodeIds)).toEqual([['A']]);
	});

	test('directed frame to a new tab excludes the receiver own node', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		await upgrade(room, 'B');
		const ws = await upgrade(room, 'A'); // second A tab
		// The new tab's only frame is the directed one; it lists B, not A.
		expect(nodeIds(presenceFrames(ws)[0]!)).toEqual(['B']);
	});

	test('directed frame entries include connectedAt and carry no action manifest', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'A');
		const ws = await upgrade(room, 'B');
		const [frame] = presenceFrames(ws);
		expect(frame).toBeDefined();
		const [nodeA] = frame!.peers;
		expect(nodeA).toBeDefined();
		expect(nodeA!.nodeId).toBe('A');
		expect(typeof nodeA!.connectedAt).toBe('number');
		expect(nodeA).not.toHaveProperty('actions');
	});
});

describe('Room presence: agent designation', () => {
	test('a published agentId rides the peer entry to other nodes', async () => {
		const { room } = await makeRoom();
		const daemonWs = await upgrade(room, 'daemon');
		await room.webSocketMessage(
			daemonWs,
			JSON.stringify({
				type: 'presence_publish',
				agentId: 'vocab-home',
			}),
		);
		// A node connecting after the publish sees the peer's designation in its
		// directed snapshot: the join key a picker uses to light up that agent.
		const observer = await upgrade(room, 'observer');
		const daemon = presenceFrames(observer)[0]!.peers.find(
			(p) => p.nodeId === 'daemon',
		);
		expect(daemon!.agentId).toBe('vocab-home');
	});

	test('a peer that never publishes an agentId omits it', async () => {
		const { room } = await makeRoom();
		await upgrade(room, 'plain');
		const observer = await upgrade(room, 'observer');
		const plain = presenceFrames(observer)[0]!.peers.find(
			(p) => p.nodeId === 'plain',
		);
		expect(plain!.agentId).toBeUndefined();
	});
});

describe('Room presence: first-socket rebroadcast', () => {
	test('first socket for a node rebroadcasts the list to existing peers', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const before = presenceFrames(wsA).length;
		await upgrade(room, 'B');
		const after = presenceFrames(wsA).slice(before);
		expect(after.map(nodeIds)).toEqual([['B']]);
	});

	test('subsequent socket for the SAME node does NOT rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		await upgrade(room, 'B'); // first B socket: rebroadcast to A
		const beforeSecondTab = presenceFrames(wsA).length;
		await upgrade(room, 'B'); // second B tab: list unchanged, no rebroadcast
		expect(presenceFrames(wsA).slice(beforeSecondTab)).toEqual([]);
	});
});

describe('Room presence: rebroadcast on close', () => {
	test('last socket close debounces a rebroadcast that fires after grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const beforeClose = presenceFrames(wsA).length;
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// Immediately after close: nothing yet (debounce armed).
		expect(presenceFrames(wsA).slice(beforeClose)).toEqual([]);

		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(beforeClose).map(nodeIds)).toEqual([[]]);
	});

	test('intermediate socket close (multi-tab) emits NO rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		await upgrade(room, 'B'); // second B tab keeps the node alive
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsB1, 1000, 'bye', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before)).toEqual([]);
	});
});

describe('Room presence: graceful handoff', () => {
	test('cancel-then-replace: T1 closes, T2 connects inside grace, T2 closes outside grace', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB1 = await upgrade(room, 'B');
		const baseline = presenceFrames(wsA).length;

		await room.webSocketClose(wsB1, 1000, 'tab handoff', true);
		await new Promise((r) => setTimeout(r, 100));
		const wsB2 = await upgrade(room, 'B');
		// Past the original grace window from B1's close:
		await new Promise((r) => setTimeout(r, 350));

		// No "B gone" frame: the replacement cancelled the debounce.
		for (const frame of presenceFrames(wsA).slice(baseline)) {
			expect(nodeIds(frame)).toContain('B');
		}

		// Now close B2 with no replacement.
		const afterMid = presenceFrames(wsA).length;
		await room.webSocketClose(wsB2, 1000, 'gone', true);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(afterMid).map(nodeIds)).toEqual([[]]);
	});
});

describe('Room presence: hibernation/wake', () => {
	test('connections survive a fresh DO construction with the same ctx', async () => {
		// Simulate hibernation by constructing a second `Room` that shares
		// `ctx.getWebSockets()`. The new Room must rebuild `connections`
		// from the surviving sockets without emitting spurious presence
		// transitions to them.
		const { Room } = await import('./durable-object.js');
		const ctx = makeCtx();
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r1 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		await upgrade(r1, 'A');
		await upgrade(r1, 'B');

		// Build a "woken" Room reusing the same accepted sockets.
		// biome-ignore lint/suspicious/noExplicitAny: env unused
		const r2 = new Room(ctx as any, {} as any);
		await Promise.resolve();

		// A new upgrade post-wake should see both A and B in its directed frame.
		const wsC = await upgrade(r2, 'C');
		expect(nodeIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

describe('Room presence: 4401 bypasses grace', () => {
	test('close code 4401 rebroadcasts immediately', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const before = presenceFrames(wsA).length;

		await room.webSocketClose(wsB, 4401, 'auth expired', false);
		// No grace wait.
		expect(presenceFrames(wsA).slice(before).map(nodeIds)).toEqual([[]]);
	});

	test('close code 4401 cancels a pending debounced rebroadcast', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		const wsC = await upgrade(room, 'C');

		// B's close arms the debounced rebroadcast timer.
		await room.webSocketClose(wsB, 1000, 'bye', true);
		// C's 4401 close rebroadcasts immediately and must cancel B's pending
		// timer so A sees exactly one frame, not a later double-fire.
		const before = presenceFrames(wsA).length;
		await room.webSocketClose(wsC, 4401, 'auth expired', false);
		await new Promise((r) => setTimeout(r, 350));
		expect(presenceFrames(wsA).slice(before).map(nodeIds)).toEqual([[]]);
	});
});

describe('Room presence: broadcast resilience', () => {
	test('a wedged socket does not abort the rebroadcast loop', async () => {
		const { room } = await makeRoom();
		const wsA = await upgrade(room, 'A');
		const wsB = await upgrade(room, 'B');
		// Wedge A so future `send` calls throw.
		wsA.__wedge();

		// Trigger a rebroadcast by connecting a third node.
		const wsC = await upgrade(room, 'C');

		// A's wedged socket recorded nothing past wedging, but B must have
		// received a rebroadcast listing C.
		const bFrames = presenceFrames(wsB);
		expect(nodeIds(bFrames[bFrames.length - 1]!)).toContain('C');

		// C's own directed frame saw A and B (sent before any wedged send).
		expect(nodeIds(presenceFrames(wsC)[0]!)).toEqual(['A', 'B']);
	});
});

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
		// lifetime bound is now a RoomCore invariant that reads `connectedAt` from
		// the core's connection set; the stub keeps the attachment by reference and
		// the core holds the same object, so mutating it in place is exactly what
		// the core sees (in production connectedAt is simply 31 min old).
		const attachment = ws.deserializeAttachment() as { connectedAt: number };
		attachment.connectedAt = Date.now() - 31 * 60_000;

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
		const attachment = wsOld.deserializeAttachment() as { connectedAt: number };
		attachment.connectedAt = Date.now() - 31 * 60_000;

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
