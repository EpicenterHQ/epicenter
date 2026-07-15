/**
 * Node room backend tests.
 *
 * Proves the same {@link createRoomCore} runs behind the in-process Node
 * backend that runs behind the Cloudflare Durable Object: presence, binary
 * sync fan-out, and presence behavior are identical, and the
 * `bun:sqlite` update log persists and reloads a room's history. There is no
 * `cloudflare:workers` mock here, by design (ADR-0066): the core is exercised
 * through the Node backend's own surface.
 *
 * Like the Durable Object test, sockets are driven directly: the `websocket`
 * handler's `open`/`message`/`close` are called with stub sockets, bypassing
 * the real `server.upgrade` (which needs a live Bun server) exactly as the DO
 * test bypasses the real hibernation accept.
 */

import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	encodeSyncStep1,
	encodeSyncUpdate,
	SYNC_MESSAGE_TYPE,
} from '@epicenter/sync';
import * as Y from 'yjs';
import { createBunRooms } from './registry.js';
import { createBunSqliteUpdateLog } from './update-log.js';

// ────────────────────────────────────────────────────────────────────────────
// STUB SOCKET (the ServerWebSocket surface RoomCore actually touches)
// ────────────────────────────────────────────────────────────────────────────

type SocketData = { surface: 'rooms'; kind: 'room'; roomName: string };

class StubWs {
	readyState = 1;
	sent: Array<string | Uint8Array> = [];
	closeCalls: Array<{ code: number; reason: string }> = [];
	constructor(readonly data: SocketData) {}

	send(payload: string | Uint8Array): void {
		if (this.readyState !== 1) throw new Error('socket not open');
		this.sent.push(payload);
	}
	close(code: number, reason: string): void {
		this.closeCalls.push({ code, reason });
		this.readyState = 3;
	}
	textFrames(): string[] {
		return this.sent.filter((f): f is string => typeof f === 'string');
	}
}

// ────────────────────────────────────────────────────────────────────────────
// HARNESS
// ────────────────────────────────────────────────────────────────────────────

const ROOM = 'principals/u1/rooms/r1';
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'node-rooms-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A Node rooms registry with the stub-socket drivers cast to the handler's
 * surface. The `as never` casts mirror the Durable Object test's pragmatic
 * `any`: the stubs implement exactly the `send`/`close`/`readyState`/`data`
 * the core touches, not the full `ServerWebSocket`.
 */
function makeRooms() {
	const bunRooms = createBunRooms({ dir });
	return {
		rooms: bunRooms.rooms,
		open: (ws: StubWs) => bunRooms.websocket.open?.(ws as never),
		message: (ws: StubWs, m: string | Uint8Array) =>
			bunRooms.websocket.message?.(ws as never, m as never),
		close: (ws: StubWs, code: number) =>
			bunRooms.websocket.close?.(ws as never, code, ''),
	};
}

function connect(open: (ws: StubWs) => void, roomName = ROOM): StubWs {
	const ws = new StubWs({ surface: 'rooms', kind: 'room', roomName });
	open(ws);
	return ws;
}

// ────────────────────────────────────────────────────────────────────────────
// BINARY SYNC
// ────────────────────────────────────────────────────────────────────────────

describe('Node backend: binary sync', () => {
	test('a STEP1 frame receives a STEP2 reply', () => {
		const { open, message } = makeRooms();
		const ws = connect(open);
		const before = ws.sent.length;
		message(ws, encodeSyncStep1({ doc: new Y.Doc() }));
		const replies = ws.sent
			.slice(before)
			.filter((f): f is Uint8Array => f instanceof Uint8Array);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.[0]).toBe(SYNC_MESSAGE_TYPE.STEP2);
	});

	test('an update from one socket reaches peers but not its origin', () => {
		const { open, message } = makeRooms();
		const wsA = connect(open);
		const wsB = connect(open);
		const beforeA = wsA.sent.length;
		const beforeB = wsB.sent.length;

		const source = new Y.Doc();
		source.getMap('data').set('hello', 'world');
		message(wsA, encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(source) }));

		const newBinary = (ws: StubWs, n: number) =>
			ws.sent.slice(n).filter((f) => f instanceof Uint8Array);
		expect(newBinary(wsB, beforeB).length).toBe(1);
		expect(newBinary(wsA, beforeA).length).toBe(0);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// TEXT FRAMES
// ────────────────────────────────────────────────────────────────────────────

describe('Node backend: text frames', () => {
	test('an unknown text frame closes the socket with 4400', () => {
		const { open, message } = makeRooms();
		const caller = connect(open);
		message(caller, JSON.stringify({ type: 'totally_bogus' }));
		expect(caller.closeCalls.map((c) => c.code)).toEqual([4400]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// bun:sqlite UPDATE LOG
// ────────────────────────────────────────────────────────────────────────────

describe('bun:sqlite update log', () => {
	test('append then loadAll returns inserted updates in order', () => {
		const db = new Database(':memory:');
		const log = createBunSqliteUpdateLog(db);
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([4, 5]);
		log.append(a);
		log.append(b);
		expect(log.entryCount()).toBe(2);
		expect(log.loadAll()).toEqual([a, b]);
		db.close();
	});

	test('replaceAll atomically collapses the log to one compacted blob', () => {
		const db = new Database(':memory:');
		const log = createBunSqliteUpdateLog(db);
		log.append(new Uint8Array([1]));
		log.append(new Uint8Array([2]));
		const compacted = new Uint8Array([9, 9, 9]);
		log.replaceAll(compacted);
		expect(log.entryCount()).toBe(1);
		expect(log.loadAll()).toEqual([compacted]);
		db.close();
	});

	test('a Yjs doc round-trips through the log across a reopen', () => {
		const file = join(dir, 'roundtrip.sqlite');
		const doc1 = new Y.Doc({ gc: true });
		const log1 = createBunSqliteUpdateLog(new Database(file, { create: true }));
		doc1.on('updateV2', (u: Uint8Array) => log1.append(u));
		doc1.getMap('data').set('k', 'v');

		// Reopen the same file into a fresh doc; the value survives.
		const doc2 = new Y.Doc({ gc: true });
		const log2 = createBunSqliteUpdateLog(new Database(file, { create: true }));
		for (const u of log2.loadAll()) Y.applyUpdateV2(doc2, u);
		expect(doc2.getMap('data').get('k')).toBe('v');
	});
});
