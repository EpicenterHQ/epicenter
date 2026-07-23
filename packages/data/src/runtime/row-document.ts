import * as Y from '@y/y';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { ReplicaStore } from '../store/replica/index.js';
import { RuntimeError } from './errors.js';

type UpdateListener = (update: Uint8Array, origin: unknown) => void;
const hydrationOrigin = Symbol('epicenter-runtime-document-hydration');

type LiveDocumentEntry = {
	addressKey: string;
	document: Y.Doc;
	references: number;
	isRevoked: boolean;
	isDestroyed: boolean;
	persist: UpdateListener;
};

/**
 * A revocable borrower of one runtime-shared document.
 *
 * Y shared types returned by `get` are document-scoped live references, not
 * per-handle copies. Terminal revocation detaches the shared document from
 * persistence and the runtime registry; any retained raw type then belongs
 * only to that unreachable orphaned document.
 */
export type RowDocument = {
	get: Y.Doc['get'];
	getText(name?: string): ReturnType<Y.Doc['get']>;
	transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T;
	export(): Uint8Array;
	whenDurable(): Promise<void>;
	observe(listener: UpdateListener): () => void;
	subscribe(listener: UpdateListener): () => void;
	[Symbol.asyncDispose](): Promise<void>;
};

function key(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

export function createRowDocumentRegistry({
	store,
	onLocalUpdate,
}: {
	store: ReplicaStore;
	onLocalUpdate(address: RecordAddress): void;
}) {
	const entries = new Map<string, LiveDocumentEntry>();
	let disposed = false;

	function destroy(entry: LiveDocumentEntry): void {
		if (entry.isDestroyed) return;
		entry.isDestroyed = true;
		entry.document.off('updateV2', entry.persist);
		if (entries.get(entry.addressKey) === entry) {
			entries.delete(entry.addressKey);
		}
		entry.document.destroy();
	}

	function revoke(entry: LiveDocumentEntry): void {
		if (entry.isRevoked) return;
		entry.isRevoked = true;
		destroy(entry);
	}

	function revokeAll(): void {
		for (const entry of [...entries.values()]) revoke(entry);
	}

	function hydrate(address: RecordAddress, addressKey: string): LiveDocumentEntry {
		const document = new Y.Doc({ gc: true });
		try {
			const initial = store.exportDocument(address);
			if (initial !== undefined) {
				Y.applyUpdateV2(document, initial, hydrationOrigin);
			}
		} catch (cause) {
			document.destroy();
			throw cause;
		}
		const entry: LiveDocumentEntry = {
			addressKey,
			document,
			references: 0,
			isRevoked: false,
			isDestroyed: false,
			persist(update: Uint8Array, origin: unknown): void {
				if (origin === hydrationOrigin) return;
				if (entry.isRevoked) {
					throw RuntimeError.RevokedDocument({ address: addressKey }).error;
				}
				store.appendLocalDocumentUpdate(address, new Uint8Array(update));
				onLocalUpdate(address);
			},
		};
		document.on('updateV2', entry.persist);
		entries.set(addressKey, entry);
		return entry;
	}

	function open(address: RecordAddress): RowDocument {
		if (disposed) throw new Error('Epicenter is disposed');
		const addressKey = key(address);
		const entry = entries.get(addressKey) ?? hydrate(address, addressKey);
		entry.references += 1;
		let handleDisposed = false;
		const listeners = new Set<UpdateListener>();

		function requireUsable(): void {
			if (handleDisposed) throw new Error('Row document handle is disposed');
			if (entry.isRevoked)
				throw RuntimeError.RevokedDocument({ address: addressKey }).error;
		}

		return Object.freeze({
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			getText(name?: string) {
				requireUsable();
				return entry.document.get(name);
			},
			transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T {
				requireUsable();
				return entry.document.transact(run, origin);
			},
			export(): Uint8Array {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(entry.document));
			},
			async whenDurable(): Promise<void> {
				// In-process appends commit synchronously inside persist; the
				// method exists so RPC-backed runtimes can honor real latency.
				requireUsable();
			},
			observe(listener: UpdateListener): () => void {
				requireUsable();
				listeners.add(listener);
				entry.document.on('updateV2', listener);
				return () => {
					listeners.delete(listener);
					entry.document.off('updateV2', listener);
				};
			},
			subscribe(listener: UpdateListener): () => void {
				requireUsable();
				listeners.add(listener);
				entry.document.on('updateV2', listener);
				return () => {
					listeners.delete(listener);
					entry.document.off('updateV2', listener);
				};
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (handleDisposed) return;
				handleDisposed = true;
				for (const listener of listeners) {
					entry.document.off('updateV2', listener);
				}
				listeners.clear();
				entry.references -= 1;
				if (entry.references === 0) destroy(entry);
			},
		});
	}

	return {
		open,
		invalidate(address: RecordAddress): void {
			// Only the terminal tombstone revokes open handles; reversible unset
			// leaves the document chain and its handles intact (ADR-0160).
			const lanes = store.record(address);
			const terminal =
				lanes === null ||
				lanes.confirmed?.state === 'tombstone' ||
				lanes.sealed?.op === 'tombstone' ||
				lanes.pending?.op === 'tombstone';
			if (!terminal) return;
			const entry = entries.get(key(address));
			if (entry !== undefined) revoke(entry);
		},
		revokeAll,
		dispose(): void {
			if (disposed) return;
			disposed = true;
			revokeAll();
		},
	};
}
