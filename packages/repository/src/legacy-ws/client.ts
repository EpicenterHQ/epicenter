/**
 * The WebSocket transport for devices, in browsers and in Bun. It keeps one
 * socket open, reconnecting with backoff; while it is down every call fails
 * with `Offline`, and each time it opens the engine says hello and resends
 * its outbox from the first unsent batch.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { type Transport, TransportError } from '../engine/ports.js';
import type { Batch, BatchOutcome, Welcome } from '../protocol.js';
import type { ClientFrame, ServerFrame } from './messages.js';

export type WebSocketTransportOptions = {
	/** The server's URL; the device id is added as `device`. Identity is the server's to establish. */
	url: string;
	/** Backoff between reconnects, doubling from `minMs` to `maxMs`. */
	retry?: { minMs: number; maxMs: number };
};

export function createWebSocketTransport({ url, retry = { minMs: 250, maxMs: 5_000 } }: WebSocketTransportOptions): Transport {
	return {
		connect({ device, onBroadcast, onOnline }) {
			const address = new URL(url);
			address.searchParams.set('device', device);
			let socket: WebSocket | null = null;
			let closed = false;
			let delay = retry.minMs;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let next = 1;
			const waiting = new Map<number, (value: Result<unknown, TransportError>) => void>();

			function open() {
				const attempt = new WebSocket(address);
				attempt.onopen = () => {
					socket = attempt;
					delay = retry.minMs;
					onOnline();
				};
				attempt.onmessage = (event) => {
					const frame = JSON.parse(String(event.data)) as ServerFrame;
					if (frame.type === 'broadcast') {
						onBroadcast(frame.broadcast);
						return;
					}
					waiting.get(frame.id)?.(Ok(frame.value));
					waiting.delete(frame.id);
				};
				attempt.onclose = () => {
					if (socket === attempt) socket = null;
					for (const resolve of waiting.values()) resolve(TransportError.Offline({ sent: true }));
					waiting.clear();
					if (closed) return;
					timer = setTimeout(open, delay);
					delay = Math.min(delay * 2, retry.maxMs);
				};
			}
			open();

			/** Send one frame and wait for its reply, or fail at once while the socket is down. */
			function call(frame: { type: 'hello'; seq: number } | { type: 'push'; batch: Batch }) {
				const current = socket;
				if (current === null || current.readyState !== WebSocket.OPEN) return Promise.resolve(TransportError.Offline({ sent: false }));
				const id = next++;
				return new Promise<Result<unknown, TransportError>>((resolve) => {
					waiting.set(id, resolve);
					current.send(JSON.stringify({ ...frame, id } satisfies ClientFrame));
				});
			}

			return {
				connected: () => socket !== null && socket.readyState === WebSocket.OPEN,
				hello: (seq) => call({ type: 'hello', seq }) as Promise<Result<Welcome, TransportError>>,
				push: (batch) => call({ type: 'push', batch }) as Promise<Result<BatchOutcome, TransportError>>,
				close() {
					closed = true;
					clearTimeout(timer);
					socket?.close();
				},
			};
		},
	};
}
