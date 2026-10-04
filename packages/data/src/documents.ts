import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import * as Y from '@y/y';

import type { Replica } from './replica/index.js';

const COMPACTION_THRESHOLD = 64;
const hydrationOrigin = Object.freeze({ kind: 'epicenter-document-hydration' });

export type DocumentAddress = {
	namespace: string;
	table: string;
	rowId: string;
};

type StoredUpdate = SqliteRow & {
	update_sequence: number;
	update_bytes: Uint8Array | ArrayBuffer;
};

type DocumentEntry = {
	address: DocumentAddress;
	document: LiveDocument;
	references: number;
	revoked: Error | undefined;
	revocationListeners: Set<(error: Error) => void>;
	stopPersistence(): void;
};

type UpdateListener = (update: Uint8Array, origin: unknown) => void;

type LiveDocument = Y.Doc & {
	on(name: 'updateV2', listener: UpdateListener): UpdateListener;
	off(name: 'updateV2', listener: UpdateListener): void;
	destroy(): void;
};

export type RowDocumentConnectionTarget = {
	address: DocumentAddress;
	applyUpdate(update: Uint8Array, origin?: unknown): void;
	encodeStateVector(): Uint8Array;
	encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
	observe(listener: UpdateListener): () => void;
	subscribeRevocation(listener: (error: Error) => void): () => void;
};

const rowDocumentAccess = new WeakMap<
	RowDocument,
	RowDocumentConnectionTarget
>();

export function registerRowDocumentConnectionTarget(
	document: RowDocument,
	target: RowDocumentConnectionTarget,
): void {
	rowDocumentAccess.set(document, target);
}

export type RowDocument = {
	get: Y.Doc['get'];
	transact<TValue>(
		callback: (transaction: Y.Transaction) => TValue,
		origin?: unknown,
	): TValue;
	whenDurable(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
};

export function createDocumentRuntime({
	database,
	replica,
}: {
	database: SqliteDatabase;
	replica: Replica;
}) {
	const entries = new Map<string, DocumentEntry>();
	const opening = new Map<string, Promise<DocumentEntry>>();
	let isDisposed = false;

	function addressKey({ namespace, table, rowId }: DocumentAddress): string {
		return JSON.stringify([namespace, table, rowId]);
	}

	function requireRuntimeOpen(): void {
		if (isDisposed) throw new Error('Epicenter document runtime is disposed');
	}

	function isRowLive(address: DocumentAddress): boolean {
		const result = replica.readRow(address);
		if (result.error !== null) throw result.error;
		return result.data !== undefined;
	}

	function requireRowLive(address: DocumentAddress): void {
		if (isRowLive(address)) return;
		throw new Error(
			`Cannot open document for absent row '${address.namespace}/${address.table}/${address.rowId}'`,
		);
	}

	function readUpdates(address: DocumentAddress): StoredUpdate[] {
		return database.all<StoredUpdate>(
			`SELECT update_sequence, update_bytes
			 FROM document_updates
			 WHERE namespace_key = ? AND table_key = ? AND row_id = ?
			 ORDER BY update_sequence`,
			[address.namespace, address.table, address.rowId],
		);
	}

	function copyBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
		return value instanceof Uint8Array
			? new Uint8Array(value)
			: new Uint8Array(value.slice(0));
	}

	function replay(updates: readonly StoredUpdate[]): LiveDocument {
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		try {
			for (const update of updates) {
				Y.applyUpdateV2(document, copyBytes(update.update_bytes));
			}
			return document;
		} catch (cause) {
			document.destroy();
			throw cause;
		}
	}

	function append(address: DocumentAddress, update: Uint8Array): void {
		database.transaction(() => {
			if (!isRowLive(address)) {
				throw new Error(
					`Cannot persist document update for absent row '${address.namespace}/${address.table}/${address.rowId}'`,
				);
			}
			const nextSequence =
				database.all<SqliteRow & { sequence: number }>(
					`SELECT COALESCE(MAX(update_sequence), 0) + 1 AS sequence
					 FROM document_updates
					 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
					[address.namespace, address.table, address.rowId],
				)[0]?.sequence ?? 1;
			database.run(
				`INSERT INTO document_updates (
					namespace_key, table_key, row_id, update_sequence, update_bytes
				) VALUES (?, ?, ?, ?, ?)`,
				[
					address.namespace,
					address.table,
					address.rowId,
					nextSequence,
					new Uint8Array(update),
				],
			);
			const updates = readUpdates(address);
			if (updates.length < COMPACTION_THRESHOLD) return;
			const compacted = replay(updates);
			try {
				const baseline = new Uint8Array(Y.encodeStateAsUpdateV2(compacted));
				database.run(
					`DELETE FROM document_updates
					 WHERE namespace_key = ? AND table_key = ? AND row_id = ?`,
					[address.namespace, address.table, address.rowId],
				);
				database.run(
					`INSERT INTO document_updates (
						namespace_key, table_key, row_id, update_sequence, update_bytes
					) VALUES (?, ?, ?, 1, ?)`,
					[address.namespace, address.table, address.rowId, baseline],
				);
			} finally {
				compacted.destroy();
			}
		});
	}

	function createEntry(address: DocumentAddress): DocumentEntry {
		requireRowLive(address);
		const document = new Y.Doc({ gc: true }) as LiveDocument;
		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === hydrationOrigin) return;
			append(address, update);
		};
		document.on('updateV2', persist);
		try {
			for (const update of readUpdates(address)) {
				Y.applyUpdateV2(
					document,
					copyBytes(update.update_bytes),
					hydrationOrigin,
				);
			}
			requireRowLive(address);
			const entry: DocumentEntry = {
				address: { ...address },
				document,
				references: 0,
				revoked: undefined,
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

	async function entryFor(address: DocumentAddress): Promise<DocumentEntry> {
		requireRuntimeOpen();
		const cacheKey = addressKey(address);
		const existing = entries.get(cacheKey);
		if (existing !== undefined) return existing;
		const pending = opening.get(cacheKey);
		if (pending !== undefined) return pending;
		const created = Promise.resolve().then(() => createEntry({ ...address }));
		opening.set(cacheKey, created);
		try {
			return await created;
		} finally {
			if (opening.get(cacheKey) === created) opening.delete(cacheKey);
		}
	}

	function destroyEntry(entry: DocumentEntry): void {
		const cacheKey = addressKey(entry.address);
		if (entries.get(cacheKey) === entry) entries.delete(cacheKey);
		entry.stopPersistence();
		entry.document.destroy();
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
		registerRowDocumentConnectionTarget(handle, {
			address: { ...entry.address },
			applyUpdate(update, origin) {
				requireUsable();
				Y.applyUpdateV2(entry.document, new Uint8Array(update), origin);
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
				if (entry.revoked !== undefined) {
					listener(entry.revoked);
					return () => undefined;
				}
				entry.revocationListeners.add(listener);
				return () => entry.revocationListeners.delete(listener);
			},
		});
		return handle;
	}

	return {
		async open(address: DocumentAddress): Promise<RowDocument> {
			const entry = await entryFor(address);
			requireRuntimeOpen();
			if (entry.revoked !== undefined) throw entry.revoked;
			return createHandle(entry);
		},
		/** Revoke every open handle after a lifetime replacement wiped local state. */
		reset(): void {
			for (const entry of [...entries.values()]) {
				entry.revoked = new Error(
					'Row document was revoked because the authority lifetime was replaced',
				);
				for (const listener of entry.revocationListeners) {
					listener(entry.revoked);
				}
				entry.revocationListeners.clear();
				destroyEntry(entry);
			}
		},
		revoke(address: DocumentAddress): void {
			const entry = entries.get(addressKey(address));
			if (entry === undefined) return;
			entry.revoked = new Error(
				`Row document was revoked because '${address.namespace}/${address.table}/${address.rowId}' is no longer live`,
			);
			for (const listener of entry.revocationListeners) {
				listener(entry.revoked);
			}
			entry.revocationListeners.clear();
			destroyEntry(entry);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			await Promise.allSettled(opening.values());
			for (const entry of [...entries.values()]) {
				entry.revoked = new Error('Epicenter document runtime is disposed');
				for (const listener of entry.revocationListeners) {
					listener(entry.revoked);
				}
				entry.revocationListeners.clear();
				destroyEntry(entry);
			}
		},
	};
}

function requireRowDocumentAccess(
	document: RowDocument,
): RowDocumentConnectionTarget {
	const access = rowDocumentAccess.get(document);
	if (access === undefined) throw new Error('Unknown row document handle');
	return access;
}

/** Apply one incremental V2 update at an adapter boundary. */
export function applyRowDocumentUpdate(
	document: RowDocument,
	update: Uint8Array,
	origin?: unknown,
): void {
	requireRowDocumentAccess(document).applyUpdate(update, origin);
}

/** Encode one initial state snapshot for an adapter boundary. */
export function encodeRowDocumentState(document: RowDocument): Uint8Array {
	return requireRowDocumentAccess(document).encodeStateAsUpdate();
}

/** Observe incremental V2 updates at an adapter boundary. */
export function observeRowDocumentUpdates(
	document: RowDocument,
	listener: UpdateListener,
): () => void {
	return requireRowDocumentAccess(document).observe(listener);
}

/** Expose the narrow transport seam for one locally owned row document. */
export function rowDocumentConnectionTarget(
	document: RowDocument,
): RowDocumentConnectionTarget {
	return requireRowDocumentAccess(document);
}
