/// <reference lib="dom" />

import type { PrincipalId } from '@epicenter/principal';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';
import type { BlobId } from './blob-id.js';
import {
	type BlobSource,
	BlobSourceError,
	type BlobSources,
} from './blob-source.js';
import {
	type BlobStat,
	type BlobStore,
	BlobStoreError,
	type BlobStoreFailed,
} from './blob-store.js';

const DATABASE_VERSION = 1;
const DATA_STORE = 'blob-data';
const METADATA_STORE = 'blob-metadata';

/**
 * Whose bytes a browser blob store holds: one application's, for one account.
 *
 * The same two segments the replica address carries (ADR-0348), because the
 * bytes are the account's: a second person signing in on a shared browser
 * must not reach the first one's recordings, and removing one account's local
 * data has to be able to take its audio and leave everybody else's.
 */
export type BrowserBlobScope = {
	/** The opening application, which is one segment of the name. */
	appId: string;
	/** The account whose bytes these are, as the authority asserted it. */
	principalId: PrincipalId;
};

/**
 * Where one account's blobs live in this browser (ADR-0349).
 *
 * ```txt
 * epicenter/v5/<app-id>/<principal-id>/blobs
 * ```
 *
 * One IndexedDB database per application per principal, named as the sibling
 * of that account's replicas, `epicenter/v5/<app-id>/<principal-id>/<data-id>/<n>`.
 * The two spellings live in two packages and are pinned to each other by test
 * rather than by a shared constant: `@epicenter/data` does not know blobs
 * exist, and this package does not open replicas.
 *
 * Per principal rather than per data id, because the authority keeps one copy
 * per principal (`principals/<id>/blobs/<blobId>`) and rows in two of one
 * app's data ids may cite one `BlobId`. Not per generation, because a restore
 * mints a new generation citing the same ids, and a per-generation store would
 * copy or orphan every blob.
 *
 * `blobs` cannot collide with a data id: a data id is reverse-domain and must
 * contain a dot. It cannot be mistaken for a generation either: generation
 * enumeration matches `<data-id>/` with the trailing slash and requires the
 * remainder to be a number, so this name is invisible to it.
 *
 * Each segment is refused rather than canonicalized, under the rule the replica
 * address and a desktop partition already use: not empty, no path separator,
 * and not `.` or `..`. A principal id is whatever the authority minted, and
 * normalizing one here would invent an equivalence the authority never stated.
 * The app id's fuller grammar is enforced where a handle is composed
 * (`createEpicenter`); here it only has to be one segment so a name can never
 * be read as somebody else's.
 *
 * A bad segment THROWS. This runs at a composition root with values a program
 * supplied, the way `createBrowserDevice` refuses a bad app id, and a durable
 * name is not a place to be lenient.
 */
export function browserBlobStoreName({
	appId,
	principalId,
}: BrowserBlobScope): string {
	assertOneSegment(appId, 'app id');
	assertOneSegment(principalId, 'principal id');
	return `epicenter/v5/${appId}/${principalId}/blobs`;
}

function assertOneSegment(segment: string, label: string): void {
	if (
		segment.length === 0 ||
		segment === '.' ||
		segment === '..' ||
		segment.includes('/') ||
		segment.includes('\\')
	) {
		throw new Error(
			`The ${label} ${JSON.stringify(segment)} cannot name a blob store.`,
		);
	}
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
 * Create one account's browser-local blob store, backed by IndexedDB at
 * {@link browserBlobStoreName}.
 *
 * The scope is required, and there is no way to name the database directly:
 * a store this constructor hands back is always one application's and one
 * account's, so an unscoped store cannot be built by omission. Construction is
 * inert; the database is created by the first verb that opens it.
 *
 * Blob bytes and metadata live in separate object stores within one database.
 * Browser persistence uses `ArrayBuffer`, not `Blob`: WebKit rejects Blob/File
 * values in IndexedDB object stores. The public API still accepts and returns
 * `Blob`, so this platform codec does not leak into application code. Writes
 * and deletes update both stores atomically, while `stat` reads only metadata.
 */
export function createBrowserBlobStore({
	appId,
	principalId,
	indexedDb = indexedDB,
	locks = platformLocks(),
}: BrowserBlobScope & {
	indexedDb?: IDBFactory;
	locks?: BlobLockManager;
}): BlobStore {
	const database = browserBlobStoreName({ appId, principalId });
	const store = createStoreAt(database, indexedDb);
	async function operate<TValue, TError>(
		id: BlobId,
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
		put: (id, blob) => operate(id, () => store.put(id, blob)),
		get: (id) => operate(id, () => store.get(id)),
		stat: (id) => operate(id, () => store.stat(id)),
		delete: (id) => operate(id, () => store.delete(id)),
	};
}

/** The store over one database, whatever it is named. */
function createStoreAt(databaseName: string, indexedDb: IDBFactory): BlobStore {
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

/**
 * The one database every browser build opened before bytes were the account's.
 *
 * It is not a store this package will construct for a caller. It exists here
 * so that what an earlier build wrote can be claimed by the rows that cite it
 * and, once nothing cites what is left, deleted by the person it may belong
 * to. Nothing here enumerates its ids (ADR-0154); a claim walks the ids the
 * application's rows supply, and the summary counts and sizes what remains.
 */
const UNSCOPED_DATABASE_NAME = 'epicenter-blobs';

/** How long an erase waits for another tab's connection to close. */
const DELETE_BLOCKED_TIMEOUT_MS = 10_000;

/**
 * The slice of the Web Locks API an erase and a claim need, declared so a
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
	/** Listing databases or reading a summary failed. */
	BlobSummaryFailed: ({ cause }: { cause: unknown }) => ({
		message: `Could not read the earlier blob store: ${extractErrorMessage(cause)}`,
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
 * Erase one account's blob store on this browser (ADR-0349, ADR-0351).
 *
 * A second explicit delete beside the generation erase, against the same
 * captured principal, never a widened filter: generation enumeration must not
 * learn to see this database. It never touches the authority's copy.
 *
 * Every verb takes a shared lock for its entire operation; erase refuses
 * while any verb or claim holds the database. Callers must stop producers
 * before erasing. These operation locks cannot prevent a surviving idle
 * handle or a newly opened session from creating the database afterward.
 */
export function eraseBlobStore({
	appId,
	principalId,
	indexedDb = indexedDB,
	locks = platformLocks(),
}: BrowserBlobScope & {
	indexedDb?: IDBFactory;
	locks?: BlobLockManager;
}): Promise<Result<void, BrowserBlobStoreError>> {
	const database = browserBlobStoreName({ appId, principalId });
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

/** What an earlier build left in the unscoped store, without naming any of it. */
export type UnscopedBlobSummary = {
	/** How many blobs remain. */
	count: number;
	/** Their total size in bytes, from metadata; no blob bytes are read. */
	bytes: number;
};

/** What one claim did. */
export type UnscopedBlobClaim = {
	/** Ids whose bytes moved into this account's store. */
	claimed: number;
	/** Ids the unscoped store did not hold: never on this device, or already claimed. */
	absent: number;
	/** Ids skipped after one operation failed; the walk went on to the next. */
	skipped: number;
	/** What is left for nobody this claim could name. */
	unclaimed: UnscopedBlobSummary;
};

async function unscopedExists(
	indexedDb: IDBFactory,
): Promise<Result<boolean, BrowserBlobStoreError>> {
	return tryAsync({
		try: async () =>
			(await indexedDb.databases()).some(
				({ name }) => name === UNSCOPED_DATABASE_NAME,
			),
		catch: (cause) => BrowserBlobStoreError.BlobSummaryFailed({ cause }),
	});
}

/** Count and size the unscoped store's metadata by cursor; never its bytes. */
function summarizeUnscoped(
	indexedDb: IDBFactory,
): Promise<Result<UnscopedBlobSummary, BrowserBlobStoreError>> {
	return tryAsync({
		try: () =>
			withDatabase(indexedDb, UNSCOPED_DATABASE_NAME, async (database) => {
				const transaction = database.transaction(METADATA_STORE, 'readonly');
				const completed = whenTransactionCompletes(transaction);
				const summary: UnscopedBlobSummary = { count: 0, bytes: 0 };
				await new Promise<void>((resolve, reject) => {
					const cursor = transaction.objectStore(METADATA_STORE).openCursor();
					cursor.onerror = () =>
						reject(cursor.error ?? new Error('IndexedDB cursor failed'));
					cursor.onsuccess = () => {
						const current = cursor.result;
						if (current === null) {
							resolve();
							return;
						}
						const { size } = current.value as StoredBlobMetadata;
						summary.count += 1;
						summary.bytes += size;
						current.continue();
					};
				});
				await completed;
				return summary;
			}),
		catch: (cause) => BrowserBlobStoreError.BlobSummaryFailed({ cause }),
	});
}

/**
 * How much an earlier build left in the unscoped store on this browser.
 *
 * Zero when the store does not exist, and it is never created by asking: an
 * open would run the upgrade and leave an empty database behind on every
 * device, forever.
 */
export async function unscopedBrowserBlobs({
	indexedDb = indexedDB,
	locks = platformLocks(),
}: {
	indexedDb?: IDBFactory;
	locks?: BlobLockManager;
} = {}): Promise<Result<UnscopedBlobSummary, BrowserBlobStoreError>> {
	return withLock(locks, UNSCOPED_DATABASE_NAME, 'shared', async () => {
		const exists = await unscopedExists(indexedDb);
		if (exists.error !== null) return Err(exists.error);
		if (!exists.data) return Ok({ count: 0, bytes: 0 });
		return summarizeUnscoped(indexedDb);
	});
}

/**
 * Claim, for one account, the bytes an earlier build wrote to the unscoped
 * store: the ones this account's rows cite (ADR-0349).
 *
 * Rows are the inventory (ADR-0154). For each id, the bytes are copied into
 * the account's store and then removed from the unscoped one, in that order,
 * so an interruption leaves a duplicate and never a loss: the next claim's
 * `put` answers `BlobAlreadyExists`, which is consumed as success, and the
 * delete then completes. It is a MOVE. If two accounts on one browser ever
 * cite one id, whichever claims first takes the bytes; a reference travels
 * between accounts and the bytes do not (ADR-0325).
 *
 * Bytes no supplied row cites are somebody else's or nobody's, and ADR-0351
 * forbids deleting bytes of unproven ownership, so they stay and are counted.
 * Even an empty legacy database stays until an explicit delete.
 *
 * One failed id is skipped and the walk goes on; a second consecutive failure
 * is systemic (quota, a blocked open) and aborts with that error. Both locks
 * are held for the whole walk, the account's so an erase cannot interleave and
 * the unscoped store's so a delete of it cannot, and both refuse rather than
 * queue: a refusal means another tab is doing this, and the caller can leave it
 * to that tab.
 */
export async function claimUnscopedBrowserBlobs({
	appId,
	principalId,
	ids,
	indexedDb = indexedDB,
	locks = platformLocks(),
}: BrowserBlobScope & {
	ids: readonly BlobId[];
	indexedDb?: IDBFactory;
	locks?: BlobLockManager;
}): Promise<
	Result<UnscopedBlobClaim, BrowserBlobStoreError | BlobStoreFailed>
> {
	const database = browserBlobStoreName({ appId, principalId });
	const walk = async (): Promise<
		Result<UnscopedBlobClaim, BrowserBlobStoreError | BlobStoreFailed>
	> => {
		const exists = await unscopedExists(indexedDb);
		if (exists.error !== null) return Err(exists.error);
		if (!exists.data)
			return Ok({
				claimed: 0,
				absent: ids.length,
				skipped: 0,
				unclaimed: { count: 0, bytes: 0 },
			});
		const unscoped = createStoreAt(UNSCOPED_DATABASE_NAME, indexedDb);
		const scoped = createStoreAt(database, indexedDb);
		const claim = { claimed: 0, absent: 0, skipped: 0 };
		let consecutiveFailures = 0;
		const failed = (
			error: BlobStoreFailed,
		): Err<BlobStoreFailed> | undefined => {
			consecutiveFailures += 1;
			if (consecutiveFailures >= 2) return Err(error);
			claim.skipped += 1;
			return undefined;
		};

		for (const id of ids) {
			const got = await unscoped.get(id);
			if (got.error !== null) {
				if (got.error.name === 'BlobNotFound') {
					claim.absent += 1;
					consecutiveFailures = 0;
					continue;
				}
				const abort = failed(got.error);
				if (abort !== undefined) return abort;
				continue;
			}
			const put = await scoped.put(id, got.data);
			if (put.error !== null && put.error.name !== 'BlobAlreadyExists') {
				const abort = failed(put.error);
				if (abort !== undefined) return abort;
				continue;
			}
			const removed = await unscoped.delete(id);
			if (removed.error !== null) {
				const abort = failed(removed.error);
				if (abort !== undefined) return abort;
				continue;
			}
			claim.claimed += 1;
			consecutiveFailures = 0;
		}

		const unclaimed = await summarizeUnscoped(indexedDb);
		if (unclaimed.error !== null) return Err(unclaimed.error);
		return Ok({ ...claim, unclaimed: unclaimed.data });
	};
	return withLock(locks, database, 'shared', () =>
		withLock(locks, UNSCOPED_DATABASE_NAME, 'exclusive', walk),
	);
}

/**
 * Delete the unscoped store whole, on a person's explicit choice.
 *
 * The one deletion of bytes whose owner this package cannot prove, and it is
 * a person's to make (ADR-0351): the application tells them how much is there
 * and that some of it may be another account's, and they decide. Holds the
 * unscoped store's lock so a claim in another tab cannot be reading it.
 */
export function deleteUnscopedBrowserBlobs({
	indexedDb = indexedDB,
	locks = platformLocks(),
}: {
	indexedDb?: IDBFactory;
	locks?: BlobLockManager;
} = {}): Promise<Result<void, BrowserBlobStoreError>> {
	return eraseDatabase(indexedDb, locks, UNSCOPED_DATABASE_NAME);
}
