import type { Account } from '@epicenter/auth';
import {
	isOpenWebSocketDenial,
	type WebSocketAddress,
} from '@epicenter/sync/transport';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { Context } from 'hono';
import {
	type BunWebSocketData,
	type BunWebSocketHandler,
	getBunServer,
} from 'hono/bun';

const MAX_BUFFER = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT = 30_000;
type Relay = {
	open(socket: ServerWebSocket<HostSocketData>): void;
	message(message: string | Buffer): void;
	close(): void;
};
type HostSocketData = BunWebSocketData & { relay?: Relay };

/** Bun's native message preserves a Buffer's byte range and send backpressure. */
export function createAccountRelay(
	home: BunWebSocketHandler<BunWebSocketData>,
) {
	const websocket: WebSocketHandler<HostSocketData> = {
		maxPayloadLength: MAX_BUFFER,
		backpressureLimit: MAX_BUFFER,
		closeOnBackpressureLimit: true,
		open(ws) {
			if (ws.data.relay) ws.data.relay.open(ws);
			else home.open(ws);
		},
		message(ws, message) {
			if (ws.data.relay) ws.data.relay.message(message);
			else home.message(ws, message);
		},
		close(ws, code, reason) {
			if (ws.data.relay) ws.data.relay.close();
			else home.close(ws, code, reason);
		},
	};
	return {
		websocket,
		upgrade(c: Context, account: Account | null, address: WebSocketAddress) {
			let local: ServerWebSocket<HostSocketData> | undefined;
			let upstream: WebSocket | undefined;
			let closed = false;
			let ready = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const close = () => {
				if (closed) return;
				closed = true;
				clearTimeout(timeout);
				if (upstream && upstream.readyState < WebSocket.CLOSING)
					upstream.close();
				if (local && local.readyState < WebSocket.CLOSING) local.close();
			};
			const send = (data: string | ArrayBuffer) => {
				if (closed || !local) return;
				const size =
					typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
				if (
					local.getBufferedAmount() + size > MAX_BUFFER ||
					local.send(data) === 0
				)
					close();
			};
			const refuse = (code: string) => {
				send(JSON.stringify({ type: 'refused', code }));
				close();
			};
			const relay: Relay = {
				open(socket) {
					local = socket;
					timeout = setTimeout(close, HANDSHAKE_TIMEOUT);
					if (!account) {
						refuse('signed-out');
						return;
					}
					void account
						.openWebSocket(address)
						.then((remote) => {
							upstream = remote;
							if (closed) {
								remote.close();
								return;
							}
							remote.binaryType = 'arraybuffer';
							const opened = () => {
								clearTimeout(timeout);
								ready = true;
								send(JSON.stringify({ type: 'ready' }));
							};
							remote.addEventListener('open', opened, { once: true });
							remote.addEventListener(
								'message',
								(event: MessageEvent<string | ArrayBuffer>) => {
									if (!ready) {
										close();
										return;
									}
									send(event.data);
								},
							);
							remote.addEventListener('close', close, { once: true });
							remote.addEventListener('error', close, { once: true });
							if (remote.readyState === WebSocket.OPEN) opened();
						})
						.catch((error: unknown) => {
							if (isOpenWebSocketDenial(error)) refuse(error.code);
							else close();
						});
				},
				message(message) {
					if (!ready || !upstream || closed) {
						close();
						return;
					}
					const size =
						typeof message === 'string'
							? Buffer.byteLength(message)
							: message.byteLength;
					if (upstream.bufferedAmount + size > MAX_BUFFER) {
						close();
						return;
					}
					upstream.send(message);
				},
				close() {
					local = undefined;
					close();
				},
			};
			const server = getBunServer<Server<HostSocketData>>(c);
			if (!server) return c.text('WebSocket server unavailable', 503);
			if (
				!server.upgrade(c.req.raw, {
					data: { relay, events: {}, url: new URL(c.req.url), protocol: '' },
				})
			) {
				return c.text('WebSocket upgrade required', 400);
			}
			return new Response(null);
		},
	};
}
