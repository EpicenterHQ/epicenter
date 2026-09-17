/// <reference lib="dom" />

import { isAppId } from '@epicenter/constants/app-id';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { assertBlobFormat, blobKeyFormat } from './blob-format.js';
import type { BlobId } from './blob-id.js';
import { parseBlobId } from './blob-id.js';
import { blobListOptions } from './blob-metadata.js';
import {
	type BlobSource,
	BlobSourceError,
	type BlobSources,
} from './blob-source.js';
import type { BlobStore } from './blob-store.js';
import {
	type BlobListPage,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

const DATABASE_VERSION = 2;
const BLOBS = 'blobs';
const SIZE_INDEX = 'by-id-size';

/** One application's bytes on this browser profile and origin. */
export type BrowserBlobScope = { appId: string };

/** Account and library changes never select another local byte store. */
export function browserBlobStoreName({ appId }: BrowserBlobScope): string {
	if (!isAppId(appId)) throw new TypeError('Invalid blob application ID.');
	return `epicenter/${appId}/blobs`;
}

type StoredBlob = { id: BlobId; bytes: ArrayBuffer; size: number };

function requestResult<TValue>(request: IDBRequest<TValue>): Promise<TValue> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error('IndexedDB request failed.'));
	});
}

function openDatabase(
	indexedDb: IDBFactory,
	name: string,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDb.open(name, DATABASE_VERSION);
		let isBlocked = false;
		request.onblocked = () => {
			isBlocked = true;
			reject(
				new Error('Blob IndexedDB upgrade is blocked by another connection.'),
			);
		};
		request.onupgradeneeded = (event) => {
			// A rejected open must not later upgrade the database after its lock
			// has been released. IndexedDB cannot cancel a pending open request.
			if (isBlocked || event.oldVersion !== 0) {
				request.transaction?.abort();
				return;
			}
			const blobs = request.result.createObjectStore(BLOBS, { keyPath: 'id' });
			blobs.createIndex(SIZE_INDEX, ['id', 'size']);
		};
		request.onerror = () =>
			reject(request.error ?? new Error('Could not open blob IndexedDB.'));
		request.onsuccess = () => {
			const database = request.result;
			database.onversionchange = () => database.close();
			if (isBlocked) {
				database.close();
				return;
			}
			resolve(database);
		};
	});
}

async function transact<TValue>(
	indexedDb: IDBFactory,
	name: string,
	mode: IDBTransactionMode,
	run: (store: IDBObjectStore) => Promise<TValue>,
): Promise<TValue> {
	const database = await openDatabase(indexedDb, name);
	try {
		const transaction = database.transaction(BLOBS, mode);
		const completed = new Promise<void>((resolve, reject) => {
			let requestError: unknown;
			transaction.oncomplete = () => resolve();
			transaction.onabort = () =>
				reject(
					transaction.error ??
						requestError ??
						new Error('Blob transaction aborted.'),
				);
			transaction.onerror = (event) => {
				const target = event.target;
				requestError =
					target !== null && 'error' in target ? target.error : undefined;
				// Wait for abort before releasing the connection and operation lock.
			};
		});
		try {
			const [value] = await Promise.all([
				run(transaction.objectStore(BLOBS)),
				completed,
			]);
			return value;
		} catch (cause) {
			try {
				transaction.abort();
			} catch {
				// Completion or a request failure may have already ended it.
			}
			await completed.catch(() => {});
			throw cause;
		}
	} finally {
		database.close();
	}
}

function indexedStat(key: IDBValidKey) {
	if (!Array.isArray(key)) throw new Error('Invalid blob size index key.');
	const [rawId, size] = key;
	const id = parseBlobId(rawId);
	if (
		!id ||
		typeof size !== 'number' ||
		!Number.isSafeInteger(size) ||
		size < 0
	)
		throw new Error('Invalid blob size index entry.');
	return { id, size, contentType: blobKeyFormat(id).contentType };
}

/** Immutable ArrayBuffer records with a covering index for metadata reads. */
export function createBrowserBlobStore(
	scope: BrowserBlobScope & { indexedDb?: IDBFactory; locks?: BlobLockManager },
): BlobStore {
	const {
		indexedDb = globalThis.indexedDB,
		locks = (globalThis as { navigator?: { locks?: BlobLockManager } })
			.navigator?.locks,
	} = scope;
	const database = browserBlobStoreName(scope);

	async function operate<TValue, TError>(
		id: BlobId | undefined,
		run: () => Promise<Result<TValue, TError | BlobStoreFailed>>,
	): Promise<Result<TValue, TError | BlobStoreFailed>> {
		if (id !== undefined && !parseBlobId(id))
			return BlobStoreError.BlobStoreFailed({
				id,
				cause: new TypeError('Blob id must be a complete blob key.'),
			});
		if (!locks)
			return BlobStoreError.BlobStoreFailed({
				id,
				cause: BrowserBlobStoreError.LocksUnsupported({ database }).error,
			});
		const result = await tryAsync({
			try: () =>
				locks.request(
					`epicenter.blobs:${database}`,
					{ mode: 'shared', ifAvailable: true },
					async (lock): Promise<Result<TValue, TError | BlobStoreFailed>> => {
						if (lock === null)
							return BlobStoreError.BlobStoreFailed({
								id,
								cause: BrowserBlobStoreError.BlobStoreHeld({ database }).error,
							});
						return run();
					},
				),
			catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
		});
		return result.error === null ? result.data : Err(result.error);
	}

	return {
		list(options) {
			return operate(undefined, () =>
				tryAsync({
					try: async () => {
						const { cursor, limit } = blobListOptions(options);
						const items = await transact(
							indexedDb,
							database,
							'readonly',
							(store) =>
								new Promise<BlobListPage['items']>((resolve, reject) => {
									const items: BlobListPage['items'] = [];
									const range =
										cursor === undefined
											? undefined
											: IDBKeyRange.lowerBound(
													[cursor, Number.MAX_SAFE_INTEGER],
													true,
												);
									const request = store.index(SIZE_INDEX).openKeyCursor(range);
									request.onerror = () => reject(request.error);
									request.onsuccess = () => {
										try {
											const entry = request.result;
											if (!entry) return resolve(items);
											const stat = indexedStat(entry.key);
											items.push(stat);
											if (items.length > limit) return resolve(items);
											entry.continue();
										} catch (cause) {
											reject(cause);
										}
									};
								}),
						);
						const hasMore = items.length > limit;
						if (hasMore) items.pop();
						return {
							items,
							...(hasMore ? { nextCursor: items.at(-1)!.id } : {}),
						};
					},
					catch: (cause) => BlobStoreError.BlobStoreFailed({ cause }),
				}),
			);
		},
		put(id, blob) {
			return operate(id, () =>
				tryAsync({
					try: async () => {
						assertBlobFormat(id, blob);
						const bytes = await blob.arrayBuffer();
						await transact(indexedDb, database, 'readwrite', async (store) => {
							await requestResult(
								store.add({
									id,
									bytes,
									size: bytes.byteLength,
								} satisfies StoredBlob),
							);
						});
					},
					catch: (cause) =>
						cause instanceof DOMException && cause.name === 'ConstraintError'
							? BlobStoreError.BlobAlreadyExists({ id })
							: BlobStoreError.BlobStoreFailed({ id, cause }),
				}),
			);
		},
		get(id) {
			return operate(id, async () => {
				const result = await tryAsync({
					try: async () => {
						const { contentType } = blobKeyFormat(id);
						const record: StoredBlob | undefined = await transact(
							indexedDb,
							database,
							'readonly',
							(store) => requestResult(store.get(id)),
						);
						if (record === undefined) return undefined;
						if (
							!(record.bytes instanceof ArrayBuffer) ||
							record.size !== record.bytes.byteLength ||
							record.id !== id
						)
							throw new Error('Invalid stored blob.');
						return new Blob([record.bytes], { type: contentType });
					},
					catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
				});
				if (result.error !== null) return Err(result.error);
				return result.data === undefined
					? BlobStoreError.BlobNotFound({ id })
					: Ok(result.data);
			});
		},
		stat(id) {
			return operate(id, async () => {
				const result = await tryAsync({
					try: async () => {
						blobKeyFormat(id);
						return transact(indexedDb, database, 'readonly', async (store) => {
							const range = IDBKeyRange.bound(
								[id, 0],
								[id, Number.MAX_SAFE_INTEGER],
							);
							const entry = await requestResult(
								store.index(SIZE_INDEX).openKeyCursor(range),
							);
							return entry === null ? undefined : indexedStat(entry.key);
						});
					},
					catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
				});
				if (result.error !== null) return Err(result.error);
				if (result.data === undefined)
					return BlobStoreError.BlobNotFound({ id });
				return Ok({
					size: result.data.size,
					contentType: result.data.contentType,
				});
			});
		},
		delete(id) {
			return operate(id, () =>
				tryAsync({
					try: async () => {
						blobKeyFormat(id);
						await transact(indexedDb, database, 'readwrite', async (store) => {
							await requestResult(store.delete(id));
						});
					},
					catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
				}),
			);
		},
	};
}

/**
 * Create revocable browser sources over one local blob store.
 *
 * Each `open` owns one independent object URL. The caller must dispose that
 * acquisition when its media element or download no longer needs it; the
 * storage layer deliberately has no shared URL cache or reference counts.
 * Disposal is idempotent and revokes the object URL exactly once; revocation
 * is synchronous, though an already-started fetch of the URL may complete.
 */
export function createBrowserBlobSources(
	local: Pick<BlobStore, 'get'>,
	{
		createObjectUrl = URL.createObjectURL,
		revokeObjectUrl = URL.revokeObjectURL,
	}: {
		createObjectUrl?: (blob: Blob) => string;
		revokeObjectUrl?: (url: string) => void;
	} = {},
): BlobSources {
	return {
		async open(id) {
			const { data: blob, error } = await local.get(id);
			if (error !== null) return Err(error);

			const { data: url, error: urlError } = trySync({
				try: () => createObjectUrl(blob),
				catch: (cause) => BlobSourceError.BlobSourceFailed({ id, cause }),
			});
			if (urlError !== null) return Err(urlError);
			let isDisposed = false;
			return Ok({
				url,
				[Symbol.dispose]() {
					if (isDisposed) return;
					isDisposed = true;
					revokeObjectUrl(url);
				},
			} satisfies BlobSource);
		},
	};
}

/** How long an erase waits for another tab's connection to close. */
const DELETE_BLOCKED_TIMEOUT_MS = 10_000;

/**
 * The slice of the Web Locks API blob operations need, declared so a
 * test can hand in its own and so the assumption about the platform is
 * written down: shared operations, exclusive erasure, and refuse rather than queue.
 */
export type BlobLockManager = {
	request<TValue>(
		name: string,
		options: { mode: 'shared' | 'exclusive'; ifAvailable: true },
		callback: (lock: unknown) => Promise<TValue>,
	): Promise<TValue>;
};

function platformLocks(): BlobLockManager | undefined {
	return (globalThis as { navigator?: { locks?: BlobLockManager } }).navigator
		?.locks;
}

/**
 * Namespaced so it cannot collide with the lock the replica holds on its own
 * address, or with any other lock on an origin every Epicenter app shares.
 */
function lockName(database: string): string {
	return `epicenter.blobs:${database}`;
}

export const BrowserBlobStoreError = defineErrors({
	/** No `navigator.locks`. Refused rather than run unguarded. */
	LocksUnsupported: ({ database }: { database: string }) => ({
		message: `This runtime has no Web Locks, so '${database}' cannot be accessed safely.`,
		database,
	}),
	/** An incompatible operation holds this database right now. */
	BlobStoreHeld: ({ database }: { database: string }) => ({
		message: `'${database}' is held by another blob operation.`,
		database,
	}),
	/** The lock request itself threw, for a reason nobody can name. */
	LockRequestFailed: ({
		database,
		cause,
	}: {
		database: string;
		cause: unknown;
	}) => ({
		message: `Could not take the lock on '${database}': ${extractErrorMessage(cause)}`,
		database,
		cause,
	}),
	/** The database delete failed or another tab kept it open too long. */
	BlobEraseFailed: ({
		database,
		cause,
	}: {
		database: string;
		cause: unknown;
	}) => ({
		message: `Could not erase '${database}': ${extractErrorMessage(cause)}`,
		database,
		cause,
	}),
});
export type BrowserBlobStoreError = InferErrors<typeof BrowserBlobStoreError>;

/**
 * Run one operation while holding a lock on one database, or
 * report why it could not be taken. `run` must resolve a `Result` and never
 * reject; a rejection here is reported as the lock request failing, which is
 * the one channel a thrown callback has.
 */
async function withLock<TValue, TError>(
	locks: BlobLockManager | undefined,
	database: string,
	mode: 'shared' | 'exclusive',
	run: () => Promise<Result<TValue, TError>>,
): Promise<Result<TValue, TError | BrowserBlobStoreError>> {
	if (locks === undefined) {
		return BrowserBlobStoreError.LocksUnsupported({ database });
	}
	const result = await tryAsync({
		try: () =>
			locks.request(
				lockName(database),
				{ mode, ifAvailable: true },
				async (
					lock,
				): Promise<Result<TValue, TError | BrowserBlobStoreError>> =>
					lock === null
						? BrowserBlobStoreError.BlobStoreHeld({ database })
						: run(),
			),
		catch: (cause) =>
			BrowserBlobStoreError.LockRequestFailed({ database, cause }),
	});
	return result.error === null ? result.data : Err(result.error);
}

/**
 * Delete one database whole, waiting out a transient block.
 *
 * Cooperative operations have already released their shared locks and closed
 * their connections. A foreign connection can still block deletion. Report
 * that to the caller after a bound, but keep this promise pending: IndexedDB
 * cannot cancel the request, so its exclusive lock must outlive the timeout.
 */
function deleteDatabase(
	indexedDb: IDBFactory,
	database: string,
	reportBlocked: (cause: Error) => void,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDb.deleteDatabase(database);
		let timer: ReturnType<typeof setTimeout> | undefined;
		request.onsuccess = () => {
			clearTimeout(timer);
			resolve();
		};
		request.onerror = () => {
			clearTimeout(timer);
			reject(request.error ?? new Error('Could not delete blob IndexedDB'));
		};
		request.onblocked = () => {
			timer ??= setTimeout(
				() =>
					reportBlocked(
						new Error(
							'Another tab is holding this blob store open. Close it first.',
						),
					),
				DELETE_BLOCKED_TIMEOUT_MS,
			);
		};
	});
}

/**
 * Erase one application's local blob store on this browser.
 *
 * Every verb takes a shared lock for its entire operation; erase refuses
 * while any verb holds the database. Callers must stop producers
 * before erasing. These operation locks cannot prevent a surviving idle
 * handle or a newly opened session from creating the database afterward.
 */
export function eraseBlobStore(
	scope: BrowserBlobScope & {
		indexedDb?: IDBFactory;
		locks?: BlobLockManager;
	},
): Promise<Result<void, BrowserBlobStoreError>> {
	const { indexedDb = globalThis.indexedDB, locks = platformLocks() } = scope;
	const database = browserBlobStoreName(scope);
	return eraseDatabase(indexedDb, locks, database);
}

/** A blocked delete can report failure, but keeps its lock until IndexedDB settles. */
function eraseDatabase(
	indexedDb: IDBFactory,
	locks: BlobLockManager | undefined,
	database: string,
): Promise<Result<void, BrowserBlobStoreError>> {
	return new Promise((settle) => {
		void withLock(locks, database, 'exclusive', () =>
			tryAsync({
				try: () =>
					deleteDatabase(indexedDb, database, (cause) =>
						settle(BrowserBlobStoreError.BlobEraseFailed({ database, cause })),
					),
				catch: (cause) =>
					BrowserBlobStoreError.BlobEraseFailed({ database, cause }),
			}),
		).then(settle);
	});
}
