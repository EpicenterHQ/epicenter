/// <reference lib="dom" />

import * as Y from '@y/y';
import type {
	DocumentPersistenceLease,
	RowAddress,
} from './persistence.js';

const DATABASE_VERSION = 1;
const UPDATES_STORE = 'updates';
const ADDRESS_INDEX = 'address';
const DEFAULT_COMPACTION_THRESHOLD = 64;

type StoredUpdate = {
	id?: number;
	address: string;
	update: Uint8Array<ArrayBuffer>;
};

type BroadcastMessage = {
	senderId: string;
	address: RowAddress;
	update: Uint8Array<ArrayBuffer>;
};

export type DocumentBroadcastChannel = {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(value: unknown): void;
	close(): void;
};

type ActiveLease = DocumentPersistenceLease & {
	document: Y.Doc;
	fail(cause: unknown): void;
};

function asError(cause: unknown, fallback: string): Error {
	return cause instanceof Error ? cause : new Error(fallback, { cause });
}

function requestResult<TResult>(
	request: IDBRequest<TResult>,
): Promise<TResult> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('IndexedDB request failed'));
	});
}

function whenTransactionCompletes(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction failed'));
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});
}

function encodeAddress(address: RowAddress): string {
	if (
		typeof address.table !== 'string' ||
		address.table.length === 0 ||
		typeof address.rowId !== 'string' ||
		address.rowId.length === 0
	) {
		throw new TypeError('Document row address must contain a table and row id');
	}
	return JSON.stringify([address.table, address.rowId]);
}

function copyAddress(address: RowAddress): RowAddress {
	return { table: address.table, rowId: address.rowId };
}

function isBroadcastMessage(value: unknown): value is BroadcastMessage {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<BroadcastMessage>;
	return (
		typeof candidate.senderId === 'string' &&
		typeof candidate.address?.table === 'string' &&
		typeof candidate.address.rowId === 'string' &&
		candidate.update instanceof Uint8Array
	);
}

function defaultBroadcastChannel(name: string): DocumentBroadcastChannel {
	if (typeof BroadcastChannel === 'undefined') {
		throw new Error('BroadcastChannel is unavailable for browser documents');
	}
	const native = new BroadcastChannel(name);
	const channel: DocumentBroadcastChannel = {
		onmessage: null,
		postMessage(value) {
			native.postMessage(value);
		},
		close() {
			native.close();
		},
	};
	native.onmessage = (event) => channel.onmessage?.({ data: event.data });
	return channel;
}

/**
 * Open one workspace-scoped browser document store.
 *
 * One versioned IndexedDB database owns independent Yjs 14 update logs for all
 * row addresses. Live documents exchange updateV2 changes through a
 * BroadcastChannel while IndexedDB remains the durability owner.
 */
export function createBrowserIndexedDbDocumentStore({
	databaseName,
	indexedDb = indexedDB,
	keyRange = IDBKeyRange,
	compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
	createBroadcastChannel = defaultBroadcastChannel,
}: {
	databaseName: string;
	indexedDb?: IDBFactory;
	keyRange?: typeof IDBKeyRange;
	compactionThreshold?: number;
	createBroadcastChannel?: (name: string) => DocumentBroadcastChannel;
}) {
	if (!Number.isSafeInteger(compactionThreshold) || compactionThreshold < 2) {
		throw new TypeError('Document compaction threshold must be at least two');
	}

	const senderId = crypto.randomUUID();
	const broadcastName = `${databaseName}:yjs-14-documents`;
	const active = new Map<string, ActiveLease>();
	const pendingDeletes = new Set<string>();
	const hydrationOrigin = Object.freeze({ kind: 'indexeddb-hydration' });
	const broadcastOrigin = Object.freeze({ kind: 'broadcast-channel' });
	let deletingAll = false;
	let failure: Error | undefined;
	let databasePromise: Promise<IDBDatabase> | undefined;
	let broadcast: DocumentBroadcastChannel | undefined;
	let operations = 0;

	function requireHealthy(): void {
		if (failure !== undefined) throw failure;
	}

	function closeDatabaseWhenIdle(): void {
		if (
			active.size !== 0 ||
			operations !== 0 ||
			databasePromise === undefined
		) {
			return;
		}
		const closing = databasePromise;
		databasePromise = undefined;
		void closing.then(
			(database) => {
				database.onversionchange = null;
				database.close();
			},
			() => undefined,
		);
	}

	function closeBroadcastWhenIdle(): void {
		if (active.size !== 0 || broadcast === undefined) return;
		broadcast.onmessage = null;
		broadcast.close();
		broadcast = undefined;
	}

	function poison(cause: unknown): Error {
		failure ??= asError(cause, 'Browser document store failed');
		for (const lease of [...active.values()]) lease.fail(failure);
		if (broadcast !== undefined) {
			broadcast.onmessage = null;
			broadcast.close();
			broadcast = undefined;
		}
		const opened = databasePromise;
		databasePromise = undefined;
		void opened?.then(
			(database) => {
				database.onversionchange = null;
				database.close();
			},
			() => undefined,
		);
		return failure;
	}

	function openDatabase(): Promise<IDBDatabase> {
		requireHealthy();
		if (databasePromise !== undefined) return databasePromise;
		databasePromise = new Promise((resolve, reject) => {
			const request = indexedDb.open(databaseName, DATABASE_VERSION);
			let blocked = false;
			request.onupgradeneeded = () => {
				const updates = request.result.createObjectStore(UPDATES_STORE, {
					autoIncrement: true,
					keyPath: 'id',
				});
				updates.createIndex(ADDRESS_INDEX, 'address', { unique: false });
			};
			request.onsuccess = () => {
				if (blocked) {
					request.result.close();
					return;
				}
				request.result.onversionchange = () => {
					poison(
						new Error(
							'Document IndexedDB changed or was deleted by another connection',
						),
					);
				};
				resolve(request.result);
			};
			request.onerror = () =>
				reject(request.error ?? new Error('Could not open document IndexedDB'));
			request.onblocked = () => {
				blocked = true;
				reject(
					new Error('Document IndexedDB open is blocked by another connection'),
				);
			};
		});
		void databasePromise.catch((cause) => poison(cause));
		return databasePromise;
	}

	async function withDatabase<TResult>(
		operation: (database: IDBDatabase) => Promise<TResult>,
	): Promise<TResult> {
		requireHealthy();
		operations += 1;
		try {
			return await operation(await openDatabase());
		} catch (cause) {
			throw poison(cause);
		} finally {
			operations -= 1;
			closeDatabaseWhenIdle();
		}
	}

	async function readUpdates(addressKey: string): Promise<StoredUpdate[]> {
		return withDatabase(async (database) => {
			const transaction = database.transaction(UPDATES_STORE, 'readonly');
			const completed = whenTransactionCompletes(transaction);
			const request = transaction
				.objectStore(UPDATES_STORE)
				.index(ADDRESS_INDEX)
				.getAll(keyRange.only(addressKey));
			const [updates] = await Promise.all([requestResult(request), completed]);
			return updates as StoredUpdate[];
		});
	}

	async function appendAndCompact(
		addressKey: string,
		update: Uint8Array<ArrayBuffer>,
	): Promise<void> {
		await withDatabase(async (database) => {
			const transaction = database.transaction(UPDATES_STORE, 'readwrite');
			const completed = whenTransactionCompletes(transaction);
			transaction.objectStore(UPDATES_STORE).add({
				address: addressKey,
				update,
			} satisfies StoredUpdate);
			await completed;
		});

		const shouldCompact = await withDatabase(async (database) => {
			const transaction = database.transaction(UPDATES_STORE, 'readonly');
			const completed = whenTransactionCompletes(transaction);
			const request = transaction
				.objectStore(UPDATES_STORE)
				.index(ADDRESS_INDEX)
				.count(keyRange.only(addressKey));
			const [count] = await Promise.all([requestResult(request), completed]);
			return count >= compactionThreshold;
		});
		if (!shouldCompact) return;

		await withDatabase(async (database) => {
			const transaction = database.transaction(UPDATES_STORE, 'readwrite');
			const completed = whenTransactionCompletes(transaction);
			const store = transaction.objectStore(UPDATES_STORE);
			let compactionFailure: Error | undefined;
			const request = store
				.index(ADDRESS_INDEX)
				.getAll(keyRange.only(addressKey));
			request.onsuccess = () => {
				const covered = request.result as StoredUpdate[];
				if (covered.length < compactionThreshold) return;
				const compacted = new Y.Doc();
				try {
					for (const entry of covered) Y.applyUpdateV2(compacted, entry.update);
					store.add({
						address: addressKey,
						update: new Uint8Array(Y.encodeStateAsUpdateV2(compacted)),
					} satisfies StoredUpdate);
					for (const entry of covered) {
						if (entry.id === undefined) {
							throw new Error('Stored document update has no primary key');
						}
						store.delete(entry.id);
					}
				} catch (cause) {
					compactionFailure = asError(cause, 'Document compaction failed');
					transaction.abort();
				} finally {
					compacted.destroy();
				}
			};
			try {
				await completed;
			} catch (cause) {
				throw compactionFailure ?? cause;
			}
		});
	}

	async function deleteAddress(addressKey: string): Promise<void> {
		await withDatabase(async (database) => {
			const transaction = database.transaction(UPDATES_STORE, 'readwrite');
			const completed = whenTransactionCompletes(transaction);
			const store = transaction.objectStore(UPDATES_STORE);
			const request = store
				.index(ADDRESS_INDEX)
				.openKeyCursor(keyRange.only(addressKey));
			request.onsuccess = () => {
				const cursor = request.result;
				if (cursor === null) return;
				store.delete(cursor.primaryKey);
				cursor.continue();
			};
			await completed;
		});
	}

	function ensureBroadcast(): DocumentBroadcastChannel {
		requireHealthy();
		if (broadcast !== undefined) return broadcast;
		broadcast = createBroadcastChannel(broadcastName);
		broadcast.onmessage = ({ data }) => {
			if (!isBroadcastMessage(data) || data.senderId === senderId) return;
			let addressKey: string;
			try {
				addressKey = encodeAddress(data.address);
			} catch {
				return;
			}
			const lease = active.get(addressKey);
			if (lease === undefined) return;
			try {
				Y.applyUpdateV2(lease.document, data.update, broadcastOrigin);
			} catch (cause) {
				poison(cause);
			}
		};
		return broadcast;
	}

	function attach(
		address: RowAddress,
		document: Y.Doc,
	): DocumentPersistenceLease {
		requireHealthy();
		const addressKey = encodeAddress(address);
		if (deletingAll || pendingDeletes.has(addressKey)) {
			throw new Error('Document storage deletion is in progress');
		}
		if (active.has(addressKey)) {
			throw new Error('Document persistence is already attached for this row');
		}

		const stableAddress = copyAddress(address);
		ensureBroadcast();
		const hydration = Promise.withResolvers<void>();
		let durabilityTail = hydration.promise;
		let stopped = false;
		let disposePromise: Promise<void> | undefined;

		const handleUpdate = (update: Uint8Array<ArrayBuffer>, origin: unknown) => {
			if (stopped || origin === hydrationOrigin || origin === broadcastOrigin) {
				return;
			}
			const durableBytes = new Uint8Array(update);
			durabilityTail = durabilityTail.then(async () => {
				await appendAndCompact(addressKey, durableBytes);
				requireHealthy();
				ensureBroadcast().postMessage({
					senderId,
					address: stableAddress,
					update: durableBytes,
				} satisfies BroadcastMessage);
			});
			void durabilityTail.catch(() => undefined);
		};

		function stopWrites(): void {
			if (stopped) return;
			stopped = true;
			document.off('updateV2', handleUpdate);
		}

		const lease: ActiveLease = {
			document,
			whenLoaded: hydration.promise,
			whenDurable() {
				return durabilityTail;
			},
			dispose() {
				disposePromise ??= (async () => {
					stopWrites();
					try {
						await durabilityTail;
					} finally {
						active.delete(addressKey);
						closeBroadcastWhenIdle();
						closeDatabaseWhenIdle();
					}
				})();
				return disposePromise;
			},
			fail(cause) {
				stopWrites();
				const rejected = Promise.reject(cause);
				void rejected.catch(() => undefined);
				durabilityTail = rejected;
			},
		};

		active.set(addressKey, lease);
		document.on('updateV2', handleUpdate);
		void (async () => {
			try {
				for (const stored of await readUpdates(addressKey)) {
					Y.applyUpdateV2(document, stored.update, hydrationOrigin);
				}
				if (!document.isLoaded) document.emit('load', [document]);
				hydration.resolve();
			} catch (cause) {
				const poisoned = poison(cause);
				hydration.reject(poisoned);
			}
		})();
		void hydration.promise.catch(() => undefined);
		return lease;
	}

	const store = {
		attach,
		async capture(address: RowAddress) {
			requireHealthy();
			const addressKey = encodeAddress(address);
			const activeCut = active.get(addressKey)?.whenDurable();
			if (activeCut !== undefined) await activeCut;
			try {
				const updates = await readUpdates(addressKey);
				if (updates.length === 0) return undefined;
				const captured = new Y.Doc();
				try {
					for (const stored of updates) {
						Y.applyUpdateV2(captured, stored.update);
					}
					return new Uint8Array(Y.encodeStateAsUpdateV2(captured));
				} finally {
					captured.destroy();
				}
			} catch (cause) {
				throw poison(cause);
			}
		},
		async delete(address: RowAddress) {
			requireHealthy();
			const addressKey = encodeAddress(address);
			if (active.has(addressKey)) {
				throw new Error(
					'Cannot delete document storage while its lease is active',
				);
			}
			if (deletingAll || pendingDeletes.has(addressKey)) {
				throw new Error('Document storage deletion is already in progress');
			}
			pendingDeletes.add(addressKey);
			try {
				await deleteAddress(addressKey);
			} finally {
				pendingDeletes.delete(addressKey);
			}
		},
		async deleteAll() {
			requireHealthy();
			if (active.size !== 0) {
				throw new Error(
					'Cannot delete document storage while leases are active',
				);
			}
			if (deletingAll || pendingDeletes.size !== 0) {
				throw new Error('Document storage deletion is already in progress');
			}
			deletingAll = true;
			try {
				await withDatabase(async (database) => {
					const transaction = database.transaction(UPDATES_STORE, 'readwrite');
					const completed = whenTransactionCompletes(transaction);
					transaction.objectStore(UPDATES_STORE).clear();
					await completed;
				});
			} finally {
				deletingAll = false;
			}
		},
	};

	return store;
}

export type BrowserIndexedDbDocumentStore = ReturnType<
	typeof createBrowserIndexedDbDocumentStore
>;
