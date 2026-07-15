/**
 * Tests for `openCollaboration`.
 *
 * The fake `openWebSocket` resolves immediately with a socket that stays in
 * `CONNECTING` (we never call `onopen`), so the supervisor parks in
 * `attemptConnection`. That means these tests only cover the synchronous
 * setup of `openCollaboration`: peer defaults, connect deadlines, and the
 * `Symbol.dispose` sugar. Socket-coupled behavior (presence routing, binary
 * sync, disconnect settling) is intentionally out of scope here and needs a
 * different fake.
 *
 * The fake's `close() -> onclose` is what lets `ydoc.destroy()` unpark the
 * supervisor so the test process exits cleanly.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { openCollaboration } from './open-collaboration.js';

const url = 'wss://ignored.invalid/api/rooms/test';

/**
 * Minimal fake WebSocket. Stays in CONNECTING (readyState 0) until `close()`
 * is called, at which point it transitions to CLOSED and fires `onclose`.
 * The supervisor assigns `binaryType`, `onopen`, `onerror`, `onmessage` on
 * the way through; those writes land on the plain object and are never read.
 */
function fakeWebSocket(): Promise<WebSocket> {
	const ws = {
		readyState: 0,
		onclose: null as ((e: CloseEvent) => void) | null,
		close() {
			if (ws.readyState === 3) return;
			ws.readyState = 3;
			ws.onclose?.({ code: 1000, reason: '' } as CloseEvent);
		},
	};
	return Promise.resolve(ws as unknown as WebSocket);
}

function setup() {
	const ydoc = new Y.Doc({ guid: 'open-collab-test' });
	const collaboration = openCollaboration(ydoc, {
		url,
		openWebSocket: fakeWebSocket,
		onReconnectSignal: () => () => {},
	});
	return { ydoc, collaboration };
}

describe('openCollaboration', () => {
	test('dispose destroys the underlying ydoc', () => {
		const { ydoc, collaboration } = setup();
		let destroyed = 0;
		ydoc.once('destroy', () => destroyed++);
		collaboration[Symbol.dispose]();
		expect(destroyed).toBe(1);
	});

	test('connectDeadlineMs rejects whenConnected when the handshake never lands', async () => {
		// The fake socket parks in CONNECTING and never sends STEP2, so the only
		// way whenConnected settles is the deadline.
		const ydoc = new Y.Doc({ guid: 'open-collab-deadline' });
		const collaboration = openCollaboration(ydoc, {
			url,
			openWebSocket: fakeWebSocket,
			onReconnectSignal: () => () => {},
			connectDeadlineMs: 20,
		});
		try {
			await expect(collaboration.whenConnected).rejects.toThrow(
				/sync handshake exceeded 20ms/,
			);
		} finally {
			ydoc.destroy();
		}
	});
});
