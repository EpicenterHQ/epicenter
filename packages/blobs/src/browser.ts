/// <reference lib="dom" />

import { isAppId } from '@epicenter/constants/app-id';
import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
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
	type BlobAlreadyExists,
	type BlobListPage,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

const DATABASE_VERSION = 2;
const BLOBS = 'blobs';
const SIZE_INDEX = 'by-id-size';

/** One application's bytes on this browser profile and origin. */
export type BrowserBlobScope = { appId: string; account?: AccountIdentity };

/** The captured account selects local bytes shared by stores in this app. */
export function browserBlobStoreName({
	appId,
	account,
}: BrowserBlobScope): string {
	if (!isAppId(appId)) throw new TypeError('Invalid blob application ID.');
	return `epicenter/${appId}/device/${deviceOwnerPath(account)}/blobs`;
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
			// A rejected open must not later upgrade the database after its caller
			// has received failure. IndexedDB cannot cancel a pending open request.
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
				// Wait for abort before closing the connection.
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
	scope: BrowserBlobScope & {
		idb: { factory: IDBFactory; keyRange: typeof IDBKeyRange };
	},
): BlobStore {
	const { idb } = scope;
	const database = browserBlobStoreName(scope);

	async function operate<T extends Result<unknown, unknown>>(
		id: BlobId | undefined,
		run: () => Promise<T>,
	): Promise<T | Err<BlobStoreFailed>> {
		if (id !== undefined && !parseBlobId(id))
			return BlobStoreError.BlobStoreFailed({
				id,
				cause: new TypeError('Blob id must be a complete blob key.'),
			});
		return run();
	}

	return {
		list(options) {
			return operate(undefined, () =>
				tryAsync({
					try: async () => {
						const { cursor, limit } = blobListOptions(options);
						const items = await transact(
							idb.factory,
							database,
							'readonly',
							(store) =>
								new Promise<BlobListPage['items']>((resolve, reject) => {
									const items: BlobListPage['items'] = [];
									const range =
										cursor === undefined
											? undefined
											: idb.keyRange.lowerBound(
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
			return operate<Result<void, BlobAlreadyExists | BlobStoreFailed>>(
				id,
				() =>
					tryAsync({
						try: async () => {
							assertBlobFormat(id, blob);
							const bytes = await blob.arrayBuffer();
							await transact(
								idb.factory,
								database,
								'readwrite',
								async (store) => {
									await requestResult(
										store.add({
											id,
											bytes,
											size: bytes.byteLength,
										} satisfies StoredBlob),
									);
								},
							);
						},
						catch: (cause) =>
							typeof cause === 'object' &&
							cause !== null &&
							'name' in cause &&
							cause.name === 'ConstraintError'
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
							idb.factory,
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
						return transact(
							idb.factory,
							database,
							'readonly',
							async (store) => {
								const range = idb.keyRange.bound(
									[id, 0],
									[id, Number.MAX_SAFE_INTEGER],
								);
								const entry = await requestResult(
									store.index(SIZE_INDEX).openKeyCursor(range),
								);
								return entry === null ? undefined : indexedStat(entry.key);
							},
						);
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
						await transact(
							idb.factory,
							database,
							'readwrite',
							async (store) => {
								await requestResult(store.delete(id));
							},
						);
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
