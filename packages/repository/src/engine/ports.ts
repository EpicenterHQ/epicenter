/**
 * What the device engine needs from its host: a transport to the server and a
 * store for blob bytes. Both are injected so the same engine runs in a browser
 * worker, on desktop, in the CLI and in tests.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Batch, BatchOutcome, Broadcast, Welcome } from '../protocol.js';

export const TransportError = defineErrors({
	/** The server cannot be reached; the engine waits for `onOnline`. */
	Offline: () => ({ message: 'The server is not reachable' }),
});
export type TransportError = InferErrors<typeof TransportError>;

/** One device's connection. Calls fail with `Offline` while disconnected. */
export type Link = {
	hello(seq: number): Promise<Result<Welcome, TransportError>>;
	push(batch: Batch): Promise<Result<BatchOutcome, TransportError>>;
	close(): void;
};

export type Transport = {
	connect(handlers: {
		device: string;
		/** Another device's applied batch. */
		onBroadcast(broadcast: Broadcast): void;
		/** The connection is back: the engine says hello and sends its outbox. */
		onOnline(): void;
	}): Link;
};

/**
 * Blob bytes by LFS oid. `put` throws when the bytes are not stored; the
 * engine writes a pointer only after it resolves.
 */
export type BlobStore = {
	put(oid: string, bytes: Uint8Array, type: string): Promise<void>;
	get(oid: string): Promise<Uint8Array | null>;
	url(oid: string): Promise<string | null>;
};

/** Blob bytes in memory: one store shared by devices stands in for R2. */
export function createMemoryBlobStore(): BlobStore {
	const objects = new Map<string, { bytes: Uint8Array; type: string }>();
	return {
		async put(oid, bytes, type) {
			objects.set(oid, { bytes: bytes.slice(), type });
		},
		async get(oid) {
			return objects.get(oid)?.bytes.slice() ?? null;
		},
		async url(oid) {
			const object = objects.get(oid);
			return object === undefined ? null : `memory://blobs/${oid}?type=${encodeURIComponent(object.type)}`;
		},
	};
}
