import * as Y from '@y/y';

import type { RecordAddress } from '../protocol/v1/index.js';
import type { ReplicaStore } from '../store/replica/index.js';
import { RuntimeError } from './errors.js';

type UpdateListener = (update: Uint8Array, origin: unknown) => void;
const hydrationOrigin = Symbol('epicenter-runtime-document-hydration');

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
	const handles = new Map<string, Set<() => void>>();
	let disposed = false;

	function open(address: RecordAddress): RowDocument {
		if (disposed) throw new Error('Epicenter is disposed');
		const document = new Y.Doc({ gc: true });
		const initial = store.exportDocument(address);
		if (initial !== undefined) {
			Y.applyUpdateV2(document, initial, hydrationOrigin);
		}
		let revoked = false;
		let handleDisposed = false;
		const addressKey = key(address);

		const revoke = () => {
			if (revoked) return;
			revoked = true;
			document.off('updateV2', persist);
		};
		const bucket = handles.get(addressKey) ?? new Set();
		bucket.add(revoke);
		handles.set(addressKey, bucket);

		function requireUsable(): void {
			if (handleDisposed) throw new Error('Row document handle is disposed');
			if (revoked)
				throw RuntimeError.RevokedDocument({ address: addressKey }).error;
		}
		function persist(update: Uint8Array, origin: unknown): void {
			if (origin === hydrationOrigin) return;
			requireUsable();
			store.appendLocalDocumentUpdate(address, new Uint8Array(update));
			onLocalUpdate(address);
		}
		document.on('updateV2', persist);

		return Object.freeze({
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return document.get(...args);
			}) as Y.Doc['get'],
			getText(name?: string) {
				requireUsable();
				return document.get(name);
			},
			transact<T>(run: (transaction: Y.Transaction) => T, origin?: unknown): T {
				requireUsable();
				return document.transact(run, origin);
			},
			export(): Uint8Array {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(document));
			},
			async whenDurable(): Promise<void> {
				// In-process appends commit synchronously inside persist; the
				// method exists so RPC-backed runtimes can honor real latency.
				requireUsable();
			},
			observe(listener: UpdateListener): () => void {
				requireUsable();
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
			subscribe(listener: UpdateListener): () => void {
				requireUsable();
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (handleDisposed) return;
				handleDisposed = true;
				document.off('updateV2', persist);
				bucket.delete(revoke);
				if (bucket.size === 0) handles.delete(addressKey);
				document.destroy();
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
			for (const revoke of handles.get(key(address)) ?? []) revoke();
			handles.delete(key(address));
		},
		async dispose(): Promise<void> {
			if (disposed) return;
			disposed = true;
			for (const bucket of handles.values()) {
				for (const revoke of bucket) revoke();
			}
			handles.clear();
		},
	};
}
