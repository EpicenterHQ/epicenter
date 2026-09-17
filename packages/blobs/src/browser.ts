/// <reference lib="dom" />

import { isAppId } from '@epicenter/constants/app-id';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import { parseBlobId, type BlobId } from './blob-id.js';
import {
	blobListOptions,
	isBlobMetadata,
	normalizeContentType,
} from './blob-metadata.js';
import {
	type BlobSource,
	BlobSourceError,
	type BlobSources,
} from './blob-source.js';
import {
	type BlobStat,
	type BlobListPage,
	type BlobStore,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

const DATABASE_VERSION = 1;
const DATA_STORE = 'blob-data';
const METADATA_STORE = 'blob-metadata';

/** One application's bytes on this browser profile and origin. */
export type BrowserBlobScope = { appId: string };

/** Account and library changes never select another local byte store. */
export function browserBlobStoreName({ appId }: BrowserBlobScope): string {
	if (!isAppId(appId)) throw new TypeError('Invalid blob application ID.');
	return `epicenter/${appId}/blobs`;
}

type StoredBlob = {
	id: BlobId;
	bytes: ArrayBuffer;
};

type StoredBlobMetadata = BlobStat & {
	id: BlobId;
};

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
		transaction.onerror = (event) => {
			const requestError =
				typeof event.target === 'object' &&
				event.target !== null &&
				'error' in event.target
					? event.target.error
					: undefined;
			reject(
				transaction.error ??
					requestError ??
					new Error('IndexedDB transaction failed'),
			);
		};
		transaction.onabort = () =>
			reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
	});
}

function openDatabase(
	indexedDb: IDBFactory,
	databaseName: string,
): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDb.open(databaseName, DATABASE_VERSION);
		let blocked = false;
		request.onupgradeneeded = () => {
			request.result.createObjectStore(DATA_STORE, { keyPath: 'id' });
			request.result.createObjectStore(METADATA_STORE, { keyPath: 'id' });
		};
		request.onsuccess = () => {
			if (blocked) {
				request.result.close();
				return;
			}
			resolve(request.result);
		};
		request.onerror = () =>
			reject(request.error ?? new Error('Could not open blob IndexedDB'));
		request.onblocked = () => {
			blocked = true;
			reject(new Error('Blob IndexedDB open is blocked by another connection'));
		};
	});
}

async function withDatabase<TResult>(
	indexedDb: IDBFactory,
	databaseName: string,
	operation: (database: IDBDatabase) => Promise<TResult>,
): Promise<TResult> {
	const database = await openDatabase(indexedDb, databaseName);
	try {
		return await operation(database);
	} finally {
		database.close();
	}
}

function isConstraintError(cause: unknown): boolean {
	return cause instanceof DOMException && cause.name === 'ConstraintError';
}

/**
 * Construct an inert app-local store. Writes atomically commit ArrayBuffer bytes
 * and metadata together; metadata reads never materialize the bytes.
 */
export function createBrowserBlobStore(
	scope: BrowserBlobScope & {
		indexedDb?: IDBFactory;
		locks?: BlobLockManager;
	},
): BlobStore {
	const { indexedDb = globalThis.indexedDB, locks = platformLocks() } = scope;
	const database = browserBlobStoreName(scope);
	const store = createStoreAt(database, indexedDb);
	async function operate<TValue, TError>(
		id: BlobId | undefined,
		run: () => Promise<Result<TValue, TError>>,
	): Promise<Result<TValue, TError | BlobStoreFailed>> {
		const result = await withLock<Result<TValue, TError>, never>(
			locks,
			database,
			'shared',
			async () => Ok(await run()),
		);
		if (result.error !== null)
			return BlobStoreError.BlobStoreFailed({ id, cause: result.error });
		return result.data;
	}
	return {
		list: (options) => operate(undefined, () => store.list(options)),
		put: (id, blob) => operate(id, () => store.put(id, blob)),
		copy: (sourceId, destinationId) =>
			operate(destinationId, () => store.copy(sourceId, destinationId)),
		get: (id) => operate(id, () => store.get(id)),
		stat: (id) => operate(id, () => store.stat(id)),
		async statMany(ids) {
			if (ids.length === 0) return [];
			const result = await withLock<
				Awaited<ReturnType<BlobStore['statMany']>>,
				never
			>(locks, database, 'shared', async () => Ok(await store.statMany(ids)));
			if (result.error !== null)
				return ids.map((id) =>
					BlobStoreError.BlobStoreFailed({ id, cause: result.error }),
				);
			return result.data;
		},
		delete: (id) => operate(id, () => store.delete(id)),
	};
}

/** The store over one database, whatever it is named. */
function createStoreAt(databaseName: string, indexedDb: IDBFactory): BlobStore {
	async function publish(id: BlobId, blob: Blob) {
		return tryAsync({
			try: async () => {
				const bytes = await blob.arrayBuffer();
				return withDatabase(indexedDb, databaseName, async (database) => {
					const transaction = database.transaction(
						[DATA_STORE, METADATA_STORE],
						'readwrite',
					);
					const completed = whenTransactionCompletes(transaction);
					transaction
						.objectStore(DATA_STORE)
						.add({ id, bytes } satisfies StoredBlob);
					transaction.objectStore(METADATA_STORE).add({
						id,
						size: blob.size,
						contentType: normalizeContentType(blob.type),
					} satisfies StoredBlobMetadata);
					await completed;
				});
			},
			catch: (cause) =>
				isConstraintError(cause)
					? BlobStoreError.BlobAlreadyExists({ id })
					: BlobStoreError.BlobStoreFailed({ id, cause }),
		});
	}
	const store: BlobStore = {
		list(options) {
			return tryAsync({
				try: async () => {
					const { cursor, limit } = blobListOptions(options);
					return withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							[DATA_STORE, METADATA_STORE],
							'readonly',
						);
						const completed = whenTransactionCompletes(transaction);
						const items: BlobListPage['items'] = [];
						const scanned = new Promise<void>((resolve, reject) => {
							const request = transaction
								.objectStore(METADATA_STORE)
								.openCursor();
							request.onerror = () => reject(request.error);
							request.onsuccess = () => {
								const entry = request.result;
								if (!entry) return resolve();
								const id = parseBlobId(entry.key);
								if (cursor !== undefined && entry.key < cursor)
									return entry.continue(cursor);
								if (!id || id === cursor) return entry.continue();
								const metadata: unknown = entry.value;
								if (!isBlobMetadata(metadata))
									return reject(new Error('Invalid blob metadata.'));
								// getKey checks completeness without retrieving the ArrayBuffer.
								const body = transaction.objectStore(DATA_STORE).getKey(id);
								body.onerror = () => reject(body.error);
								body.onsuccess = () => {
									if (body.result !== undefined)
										items.push({
											id,
											size: metadata.size,
											contentType: metadata.contentType,
										});
									if (items.length > limit) return resolve();
									entry.continue();
								};
							};
						});
						await Promise.all([scanned, completed]);
						const hasMore = items.length > limit;
						if (hasMore) items.pop();
						return {
							items,
							...(hasMore ? { nextCursor: items.at(-1)!.id } : {}),
						};
					});
				},
				catch: (cause) => BlobStoreError.BlobStoreFailed({ cause }),
			});
		},
		async copy(sourceId, destinationId) {
			const source = await store.get(sourceId);
			if (source.error !== null) return source;
			return store.put(destinationId, source.data);
		},

		put(id, blob) {
			return publish(id, blob);
		},

		async get(id) {
			const { data, error } = await tryAsync({
				try: () =>
					withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							[DATA_STORE, METADATA_STORE],
							'readonly',
						);
						const completed = whenTransactionCompletes(transaction);
						const dataRequest = transaction.objectStore(DATA_STORE).get(id);
						const metadataRequest = transaction
							.objectStore(METADATA_STORE)
							.get(id);
						const [stored, metadata] = await Promise.all([
							requestResult(dataRequest) as Promise<StoredBlob | undefined>,
							requestResult(metadataRequest) as Promise<
								StoredBlobMetadata | undefined
							>,
							completed,
						]);
						return stored && metadata ? { stored, metadata } : undefined;
					}),
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
			if (error !== null) return Err(error);
			if (data === undefined) return BlobStoreError.BlobNotFound({ id });
			return Ok(
				new Blob([data.stored.bytes], {
					type: data.metadata.contentType,
				}),
			);
		},

		async stat(id) {
			const { data, error } = await tryAsync({
				try: () =>
					withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							METADATA_STORE,
							'readonly',
						);
						const completed = whenTransactionCompletes(transaction);
						const request = transaction.objectStore(METADATA_STORE).get(id);
						const [stored] = await Promise.all([
							requestResult(request),
							completed,
						]);
						return stored as StoredBlobMetadata | undefined;
					}),
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
			if (error !== null) return Err(error);
			if (data === undefined) return BlobStoreError.BlobNotFound({ id });
			return Ok({
				size: data.size,
				contentType: data.contentType,
			});
		},

		async statMany(ids) {
			if (ids.length === 0) return [];
			const result = await tryAsync({
				try: () =>
					withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							METADATA_STORE,
							'readonly',
						);
						const completed = whenTransactionCompletes(transaction);
						const store = transaction.objectStore(METADATA_STORE);
						// Queue every request before yielding, while the transaction is active.
						const requests = ids.map(
							(id) =>
								requestResult(store.get(id)) as Promise<
									StoredBlobMetadata | undefined
								>,
						);
						const [metadata] = await Promise.all([
							Promise.all(requests),
							completed,
						]);
						return metadata;
					}),
				catch: (cause) => Err({ cause }),
			});
			if (result.error !== null)
				return ids.map((id) =>
					BlobStoreError.BlobStoreFailed({ id, cause: result.error.cause }),
				);
			return ids.map((id, index) => {
				const metadata = result.data[index];
				return metadata === undefined
					? BlobStoreError.BlobNotFound({ id })
					: Ok({
							size: metadata.size,
							contentType: metadata.contentType,
						});
			});
		},

		delete(id) {
			return tryAsync({
				try: () =>
					withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							[DATA_STORE, METADATA_STORE],
							'readwrite',
						);
						const completed = whenTransactionCompletes(transaction);
						transaction.objectStore(DATA_STORE).delete(id);
						transaction.objectStore(METADATA_STORE).delete(id);
						await completed;
					}),
				catch: (cause) => BlobStoreError.BlobStoreFailed({ id, cause }),
			});
		},
	};
	return store;
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
