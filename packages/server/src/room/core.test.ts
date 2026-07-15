/**
 * `RoomCore` conformance suite: the runtime-agnostic room behavior, tested ONCE
 * against the pure core rather than partially re-derived per backend.
 *
 * `createRoomCore` imports nothing Cloudflare and never branches on runtime, so
 * every invariant a backend relies on lives here: the unknown-text-frame
 * close, binary sync, compaction, the connection-lifetime bound (`handleMessage`
 * for active sockets, `sweepExpiredConnections` for idle ones), and liveness
 * ping/pong. The backends only own their adapter glue (the
 * Durable Object hibernation accept + alarm, the Bun `server.upgrade` + timer),
 * which their own tests cover; both inherit this behavior unchanged.
 *
 * Time is controlled by construction, not fake timers: the lifetime bound reads
 * a connection's `authenticatedAt` (set old to age a socket) and
 * `sweepExpiredConnections(now)` takes the clock as a parameter. The 2MB
 * compaction cap is a defensive guard not exercised here (it
 * needs a >2MB doc).
 */

import { describe, expect, test } from 'bun:test';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as Y from 'yjs';
import type { RoomSocket, RoomSocketAuth, RoomUpdateLog } from './contracts.js';
import { createRoomCore } from './core.js';

const MINUTE_MS = 60_000;
const LIFETIME_MS = 30 * MINUTE_MS;

/** An in-memory {@link RoomUpdateLog}; copies on the way in and out like the real backends. */
function memoryUpdateLog(): RoomUpdateLog {
	let rows: Uint8Array[] = [];
	return {
		loadAll: () => rows.map((r) => new Uint8Array(r)),
		append: (u) => {
			rows.push(new Uint8Array(u));
		},
		replaceAll: (c) => {
			rows = [new Uint8Array(c)];
		},
		entryCount: () => rows.length,
	};
}

/** A {@link RoomSocket} that records what the core sends and closes it. */
class StubSocket implements RoomSocket {
	readyState = 1;
	readonly sent: Array<string | Uint8Array> = [];
	readonly closes: Array<{ code: number; reason: string }> = [];

	send(data: string | Uint8Array): void {
		if (this.readyState !== 1) throw new Error('socket not open');
		this.sent.push(data);
	}
	close(code: number, reason: string): void {
		this.closes.push({ code, reason });
		this.readyState = 3;
	}
	get codes(): number[] {
		return this.closes.map((c) => c.code);
	}
	/** Decoded text frames of one `type`. */
	json(type: string): Array<Record<string, unknown>> {
		return this.sent
			.filter((f): f is string => typeof f === 'string')
			.map((t) => JSON.parse(t) as Record<string, unknown>)
			.filter((f) => f.type === type);
	}
	binary(): Uint8Array[] {
		return this.sent.filter((f): f is Uint8Array => f instanceof Uint8Array);
	}
}

function auth(opts?: { authenticatedAt?: number }): RoomSocketAuth {
	return { authenticatedAt: opts?.authenticatedAt ?? Date.now() };
}

function newRoom() {
	return createRoomCore({ updateLog: memoryUpdateLog() });
}

/** Connect a fresh stub socket and return it. */
function connect(
	core: ReturnType<typeof createRoomCore>,
	opts?: { authenticatedAt?: number },
): StubSocket {
	const ws = new StubSocket();
	core.addConnection(ws, auth(opts));
	return ws;
}

// ────────────────────────────────────────────────────────────────────────────
// Text frames
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: text frames', () => {
	test('an unparseable or unknown text frame closes the socket with 4400', () => {
		const core = newRoom();
		const ws = connect(core);
		core.handleMessage(ws, JSON.stringify({ type: 'totally-bogus' }));
		expect(ws.codes).toEqual([4400]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Sync (binary WS)
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: sync', () => {
	test('a binary SyncStep1 frame gets a SyncStep2 reply', () => {
		const core = newRoom();
		const ws = connect(core);
		const before = ws.binary().length;
		core.handleMessage(ws, encodeSyncStep1({ doc: new Y.Doc() }));
		const replies = ws.binary().slice(before);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('a doc update fans out to peers but never echoes to its origin', () => {
		const core = newRoom();
		const a = connect(core);
		const b = connect(core);
		const beforeA = a.binary().length;
		const beforeB = b.binary().length;
		const src = new Y.Doc();
		src.getMap('d').set('k', 'v');
		core.handleMessage(
			a,
			encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(src) }),
		);
		expect(b.binary().length).toBe(beforeB + 1);
		expect(a.binary().length).toBe(beforeA);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Compaction
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: compaction', () => {
	test('compact collapses a multi-entry log into one row', () => {
		const updateLog = memoryUpdateLog();
		const core = createRoomCore({ updateLog });
		const ws = new StubSocket();
		core.addConnection(ws, auth());
		for (const v of ['a', 'b', 'c']) {
			const d = new Y.Doc();
			d.getMap('m').set('k', v);
			core.handleMessage(
				ws,
				encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(d) }),
			);
		}
		expect(updateLog.entryCount()).toBeGreaterThan(1);
		core.compact();
		expect(updateLog.entryCount()).toBe(1);
	});

	test('compact is a no-op on an empty log', () => {
		const updateLog = memoryUpdateLog();
		const core = createRoomCore({ updateLog });
		expect(updateLog.entryCount()).toBe(0);
		core.compact();
		expect(updateLog.entryCount()).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Connection lifetime (the cross-backend re-auth invariant)
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: connection lifetime', () => {
	test('an inbound frame on an over-age socket closes it 4408 and is dropped', () => {
		const core = newRoom();
		const ws = new StubSocket();
		core.addConnection(
			ws,
			auth({ authenticatedAt: Date.now() - (LIFETIME_MS + MINUTE_MS) }),
		);
		const beforeBinary = ws.binary().length;
		// A STEP1 would normally get a STEP2 reply; instead the socket is closed.
		core.handleMessage(ws, encodeSyncStep1({ doc: new Y.Doc() }));
		expect(ws.codes).toEqual([4408]);
		expect(ws.binary().length).toBe(beforeBinary); // frame dropped, no reply
	});

	test('sweepExpiredConnections closes idle over-age sockets and spares fresh ones', () => {
		const core = newRoom();
		const old = new StubSocket();
		core.addConnection(
			old,
			auth({ authenticatedAt: Date.now() - (LIFETIME_MS + MINUTE_MS) }),
		);
		const fresh = connect(core);
		core.sweepExpiredConnections(Date.now());
		expect(old.codes).toEqual([4408]);
		expect(fresh.codes).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Liveness ping/pong
// ────────────────────────────────────────────────────────────────────────────

describe('RoomCore: liveness', () => {
	test('a literal `ping` text frame is answered `pong` and never treated as a protocol error', () => {
		const core = newRoom();
		const ws = connect(core);
		const before = ws.sent.length;
		core.handleMessage(ws, 'ping');
		expect(ws.sent.slice(before)).toEqual(['pong']);
		expect(ws.codes).toEqual([]); // not closed 4400
	});
});
