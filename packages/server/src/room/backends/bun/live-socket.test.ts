/**
 * Live-socket integration test for the Bun room backend.
 *
 * Boots a real `Bun.serve` wired to {@link createBunRooms}, then drives it
 * with real `WebSocket` clients. This exercises the exact path the stub test
 * cannot: `server.upgrade(request, { data })` resolving the WS-upgrade
 * impedance (Bun cannot return a 101 from `fetch`), the top-level `websocket`
 * handler delivering frames to `RoomCore`, and real binary/text frames flowing
 * back over the wire. It is the Bun half of the "a room syncs over WebSocket"
 * proof (ADR-0066 Wave 4); auth is omitted here on purpose, since this asserts
 * the transport, not the gate (the gate is proven by the route's own tests).
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeSyncUpdate, MAIN_SUBPROTOCOL } from '@epicenter/sync';
import type { Server } from 'bun';
import * as Y from 'yjs';
import { type BunRoomSocketData, createBunRooms } from './registry.js';

const ROOM = 'principals/u1/rooms/r1';

let dir: string;
let server: Server<BunRoomSocketData>;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'node-rooms-live-'));
	const bunRooms = createBunRooms({ dir });
	server = Bun.serve({
		port: 0, // ephemeral
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/ws') {
				if (url.searchParams.get('reject') === 'true') {
					return bunRooms.rooms.rejectUpgrade({
						request: req,
						code: 4401,
						reason: 'rejected',
					});
				}
				return bunRooms.rooms.get(ROOM).handleUpgrade({
					request: req,
				});
			}
			return new Response('ok');
		},
		websocket: bunRooms.websocket,
	});
	bunRooms.bindServer(server);
});

afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

type Frame = { text?: string; binary?: Uint8Array };

/** Open a client, collecting every frame it receives. */
async function openClient(): Promise<{
	ws: WebSocket;
	frames: Frame[];
}> {
	const ws = new WebSocket(`ws://localhost:${server.port}/ws`, [
		MAIN_SUBPROTOCOL,
	]);
	ws.binaryType = 'arraybuffer';
	const frames: Frame[] = [];
	ws.onmessage = (e) => {
		if (typeof e.data === 'string') frames.push({ text: e.data });
		else frames.push({ binary: new Uint8Array(e.data as ArrayBuffer) });
	};
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error('socket errored'));
	});
	return { ws, frames };
}

/** Poll until `pred` holds or the deadline passes. */
async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function readRawHandshake(
	path: string,
	protocols: string,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const client = net.createConnection({ port: Number(server.port) }, () => {
			client.write(
				`GET ${path} HTTP/1.1\r\n` +
					`Host: localhost:${server.port}\r\n` +
					'Upgrade: websocket\r\n' +
					'Connection: Upgrade\r\n' +
					'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
					'Sec-WebSocket-Version: 13\r\n' +
					`Sec-WebSocket-Protocol: ${protocols}\r\n` +
					'\r\n',
			);
		});
		let buf = '';
		const timer = setTimeout(
			() => reject(new Error('no 101 within timeout')),
			1500,
		);
		client.on('data', (chunk) => {
			buf += chunk.toString('latin1');
			if (!buf.includes('\r\n\r\n')) return;
			clearTimeout(timer);
			client.destroy();
			resolve(buf.split('\r\n\r\n')[0] ?? buf);
		});
		client.on('error', reject);
	});
}

test('a real WebSocket upgrade syncs a binary update across clients', async () => {
	const a = await openClient();
	await waitFor(() => a.frames.some((f) => f.binary));
	const b = await openClient();
	await waitFor(() => b.frames.some((f) => f.binary));

	// A sends a Yjs update; B receives it as a binary frame, A does not echo.
	const aBinaryBefore = a.frames.filter((f) => f.binary).length;
	const bBinaryBefore = b.frames.filter((f) => f.binary).length;
	const doc = new Y.Doc();
	doc.getMap('data').set('hello', 'world');
	a.ws.send(encodeSyncUpdate({ update: Y.encodeStateAsUpdateV2(doc) }));

	await waitFor(() => b.frames.filter((f) => f.binary).length > bBinaryBefore);
	expect(a.frames.filter((f) => f.binary).length).toBe(aBinaryBefore);

	a.ws.close();
	b.ws.close();
});

test('the 101 echoes only the main subprotocol, never a bearer entry', async () => {
	// Bun's uWS layer auto-echoes the client's FIRST offered subprotocol, so a
	// client ordering its bearer first would get the credential echoed back on
	// the wire without the registry's in-place header sanitization. A raw
	// socket reads the actual 101 header bytes; the WebSocket client API hides
	// them.
	const statusAndProtocols = await readRawHandshake(
		'/ws',
		`bearer.secret-token, ${MAIN_SUBPROTOCOL}`,
	);

	expect(statusAndProtocols).toStartWith('HTTP/1.1 101');
	const protocolLines = statusAndProtocols
		.split('\r\n')
		.filter((line) => line.toLowerCase().startsWith('sec-websocket-protocol:'));
	expect(protocolLines).toEqual([
		`Sec-WebSocket-Protocol: ${MAIN_SUBPROTOCOL}`,
	]);
	expect(statusAndProtocols).not.toContain('secret-token');
});

test('a rejected upgrade echoes only the main subprotocol before closing', async () => {
	const statusAndProtocols = await readRawHandshake(
		'/ws?reject=true',
		`bearer.secret-token, ${MAIN_SUBPROTOCOL}`,
	);

	expect(statusAndProtocols).toStartWith('HTTP/1.1 101');
	const protocolLines = statusAndProtocols
		.split('\r\n')
		.filter((line) => line.toLowerCase().startsWith('sec-websocket-protocol:'));
	expect(protocolLines).toEqual([
		`Sec-WebSocket-Protocol: ${MAIN_SUBPROTOCOL}`,
	]);
	expect(statusAndProtocols).not.toContain('secret-token');
});
