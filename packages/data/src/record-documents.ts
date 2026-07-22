import * as Y from '@y/y';
import type { RowDocument } from './documents.js';
import type { RecordAddress } from './protocol/v1/index.js';
import { registerRecordDocumentConnectionTarget } from './record-document-connection.js';
import type { ReplicaStore } from './store/replica/index.js';

const hydrationOrigin = Symbol('epicenter-record-document-hydration');

type UpdateListener = (update: Uint8Array, origin: unknown) => void;

type LiveDocument = Y.Doc & {
	on(name: 'updateV2', listener: UpdateListener): UpdateListener;
	off(name: 'updateV2', listener: UpdateListener): void;
	destroy(): void;
};

type DocumentEntry = {
	address: RecordAddress;
	document: LiveDocument;
	references: number;
	acceptedUpdateDepth: number;
	revoked?: Error;
	revocationListeners: Set<(error: Error) => void>;
	stopPersistence(): void;
};

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

/** Own live Yjs handles over the V1 record document chain. */
export function createRecordDocumentRuntime(replica: ReplicaStore) {
	const entries = new Map<string, DocumentEntry>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter document runtime is disposed');
	}

	function requireLive(address: RecordAddress): void {
		if (replica.visible(address)?.state === 'live') return;
		throw new Error(
			`Cannot open document for absent record '${address.namespace}/${address.collection}/${address.recordKey}'`,
		);
	}

	function destroyEntry(entry: DocumentEntry): void {
		const key = addressKey(entry.address);
		if (entries.get(key) === entry) entries.delete(key);
		entry.stopPersistence();
		entry.document.destroy();
	}

	function notifyRevocation(entry: DocumentEntry): void {
		if (entry.revoked === undefined) return;
		for (const listener of entry.revocationListeners) {
			try {
				listener(entry.revoked);
			} catch {
				// A subscriber cannot interrupt terminal document cleanup.
			}
		}
		entry.revocationListeners.clear();
	}

	function createEntry(address: RecordAddress): DocumentEntry {
		requireLive(address);
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		let entry: DocumentEntry | undefined;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === hydrationOrigin || (entry?.acceptedUpdateDepth ?? 0) > 0) {
				return;
			}
			replica.appendLocalDocumentUpdate(address, new Uint8Array(update));
		};
		document.on('updateV2', persist);
		try {
			const stored = replica.exportDocument(address);
			if (stored !== undefined) {
				Y.applyUpdateV2(document, stored, hydrationOrigin);
			}
			requireLive(address);
			entry = {
				address: structuredClone(address),
				document,
				references: 0,
				acceptedUpdateDepth: 0,
				revocationListeners: new Set(),
				stopPersistence() {
					document.off('updateV2', persist);
				},
			};
			entries.set(addressKey(address), entry);
			return entry;
		} catch (cause) {
			document.off('updateV2', persist);
			document.destroy();
			throw cause;
		}
	}

	function entryFor(address: RecordAddress): DocumentEntry {
		requireOpen();
		return entries.get(addressKey(address)) ?? createEntry(address);
	}

	function installAccepted(
		address: RecordAddress,
		update: Uint8Array,
		origin: unknown,
	): void {
		replica.installAcceptedDocumentUpdate(address, update);
		const entry = entries.get(addressKey(address));
		if (entry === undefined) return;
		entry.acceptedUpdateDepth += 1;
		try {
			Y.applyUpdateV2(entry.document, new Uint8Array(update), origin);
		} finally {
			entry.acceptedUpdateDepth -= 1;
		}
	}

	function createHandle(entry: DocumentEntry): RowDocument {
		let isHandleDisposed = false;
		entry.references += 1;

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (entry.revoked !== undefined) throw entry.revoked;
		}

		const handle: RowDocument = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return entry.document.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				requireUsable();
				return entry.document.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				requireUsable();
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				entry.references -= 1;
				if (entry.references === 0 && entry.revoked === undefined) {
					destroyEntry(entry);
				}
			},
		};
		registerRecordDocumentConnectionTarget(handle, {
			address: structuredClone(entry.address),
			applyUpdate(update, origin) {
				requireUsable();
				installAccepted(entry.address, update, origin);
			},
			encodeStateVector() {
				requireUsable();
				return new Uint8Array(Y.encodeStateVector(entry.document));
			},
			encodeStateAsUpdate(stateVector) {
				requireUsable();
				return new Uint8Array(
					Y.encodeStateAsUpdateV2(entry.document, stateVector),
				);
			},
			observe(listener) {
				requireUsable();
				entry.document.on('updateV2', listener);
				return () => entry.document.off('updateV2', listener);
			},
			subscribeRevocation(listener) {
				requireUsable();
				entry.revocationListeners.add(listener);
				return () => entry.revocationListeners.delete(listener);
			},
		});
		return handle;
	}

	function revoke(address: RecordAddress): void {
		const entry = entries.get(addressKey(address));
		if (entry === undefined) return;
		entry.revoked = new Error(
			`Row document was revoked because '${address.namespace}/${address.collection}/${address.recordKey}' is no longer live`,
		);
		notifyRevocation(entry);
		destroyEntry(entry);
	}

	return {
		async open(address: RecordAddress): Promise<RowDocument> {
			return createHandle(entryFor(structuredClone(address)));
		},
		installAccepted(address: RecordAddress, update: Uint8Array): void {
			installAccepted(address, update, hydrationOrigin);
		},
		revoke,
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			for (const entry of [...entries.values()]) {
				entry.revoked = new Error('Epicenter document runtime is disposed');
				notifyRevocation(entry);
				destroyEntry(entry);
			}
		},
	};
}

export type RecordDocumentRuntime = ReturnType<
	typeof createRecordDocumentRuntime
>;
