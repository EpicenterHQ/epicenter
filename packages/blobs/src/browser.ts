/// <reference lib="dom" />

import { Err, Ok, tryAsync, trySync } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import {
	type BlobSource,
	BlobSourceError,
	type BlobSources,
} from './blob-source.js';
import { type BlobStat, BlobStoreError, type Blobs } from './blobs.js';

const DATABASE_VERSION = 1;
const DATA_STORE = 'blob-data';
const METADATA_STORE = 'blob-metadata';
const DEFAULT_DATABASE_NAME = 'epicenter-blobs';

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
 * Create a browser-local blob store backed by IndexedDB.
 *
 * Blob bytes and metadata live in separate object stores within one database.
 * Browser persistence uses `ArrayBuffer`, not `Blob`: WebKit rejects Blob/File
 * values in IndexedDB object stores. The public API still accepts and returns
 * `Blob`, so this platform codec does not leak into application code. Writes
 * and deletes update both stores atomically, while `stat` reads only metadata.
 */
export function createBrowserBlobs({
	databaseName = DEFAULT_DATABASE_NAME,
	indexedDb = indexedDB,
}: {
	databaseName?: string;
	indexedDb?: IDBFactory;
} = {}): Blobs {
	return {
		async put(id, blob) {
			return tryAsync({
				try: async () => {
					const bytes = await blob.arrayBuffer();
					return withDatabase(indexedDb, databaseName, async (database) => {
						const transaction = database.transaction(
							[DATA_STORE, METADATA_STORE],
							'readwrite',
						);
						const completed = whenTransactionCompletes(transaction);
						transaction.objectStore(DATA_STORE).add({
							id,
							bytes,
						} satisfies StoredBlob);
						transaction.objectStore(METADATA_STORE).add({
							id,
							size: blob.size,
							contentType: blob.type,
						} satisfies StoredBlobMetadata);
						await completed;
					});
				},
				catch: (cause) =>
					isConstraintError(cause)
						? BlobStoreError.BlobAlreadyExists({ id })
						: BlobStoreError.BlobStoreFailed({ id, cause }),
			});
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
			return Ok({ size: data.size, contentType: data.contentType });
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
	blobs: Pick<Blobs, 'get'>,
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
			const { data: blob, error } = await blobs.get(id);
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
