import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';

import {
	acquireBrowserStorageLease,
	type BrowserStorageLease,
} from '../../browser/storage-lease.js';
import type { LensDefinition } from '../../lens.js';
import type { ValidatedLimits } from '../../protocol/v1/index.js';
import { createReplicaBlobStore } from './blob-store.js';
import { createBrowserOpfsBlobFileStore } from './browser-opfs-blob-files.js';
import { createBrowserReplicaOwnerLifetime } from './browser-owner-lifetime.js';
import { openReplicaStore } from './replica-store.js';

const DEFAULT_DATABASE_FILENAME = '/epicenter-data-v1.sqlite3';
const DEFAULT_POOL_DIRECTORY = '.epicenter-data-v1-sahpool';
const DEFAULT_POOL_NAME = 'epicenter-data-v1';
const OWNER_GENERATION_FILENAME = '.epicenter-data-owner-generation';
const SNAPSHOT_FILENAME_PATTERN =
	/^\/epicenter-snapshot-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite3$/u;

type ReplicaInitialization = {
	replicaId: string;
	authorityLifetime?: string;
};

export type OpenBrowserReplicaOwnerOptions = {
	limits: ValidatedLimits;
	initialize?: ReplicaInitialization;
	databaseFilename?: string;
	poolDirectory?: string;
	poolName?: string;
	onStolen?: () => void;
	signal?: AbortSignal;
};

type IntegrityRow = { integrity_check: string };

async function incrementOwnerGeneration(): Promise<number> {
	const root = await (
		navigator as Navigator & {
			storage: {
				getDirectory(): Promise<{
					getFileHandle(
						name: string,
						options: { create: boolean },
					): Promise<{
						getFile(): Promise<{ text(): Promise<string> }>;
						createWritable(): Promise<{
							write(value: string): Promise<void>;
							close(): Promise<void>;
							abort(cause?: unknown): Promise<void>;
						}>;
					}>;
				}>;
			};
		}
	).storage.getDirectory();
	const handle = await root.getFileHandle(OWNER_GENERATION_FILENAME, {
		create: true,
	});
	const text = await (await handle.getFile()).text();
	const previous = text === '' ? 0 : Number(text);
	if (!Number.isSafeInteger(previous) || previous < 0) {
		throw new Error('browser owner generation is corrupt');
	}
	if (previous === Number.MAX_SAFE_INTEGER) {
		throw new Error('browser owner generation is exhausted');
	}
	const next = previous + 1;
	const writable = await handle.createWritable();
	try {
		await writable.write(String(next));
		await writable.close();
	} catch (cause) {
		await writable.abort(cause).catch(() => undefined);
		throw cause;
	}
	return next;
}

function configureDatabase(database: Database): void {
	database.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = EXTRA;
		PRAGMA temp_store = MEMORY;
	`);
}

function sweepSnapshotDebris(pool: SAHPoolUtil): void {
	for (const filename of pool.getFileNames()) {
		if (SNAPSHOT_FILENAME_PATTERN.test(filename)) pool.unlink(filename);
	}
}

function createStores(
	database: Database,
	limits: ValidatedLimits,
	files: Awaited<ReturnType<typeof createBrowserOpfsBlobFileStore>>,
	initialize?: ReplicaInitialization,
) {
	const adapter = createBrowserSqliteAdapter(
		database as unknown as BrowserSqliteDatabase,
	);
	return {
		store: openReplicaStore({
			database: adapter,
			limits,
			...(initialize === undefined ? {} : { initialize }),
		}),
		blobs: createReplicaBlobStore(adapter, files),
	};
}

async function settleCleanup(
	stages: readonly (() => unknown | Promise<unknown>)[],
	message: string,
	initialFailure?: unknown,
): Promise<void> {
	const failures: unknown[] =
		initialFailure === undefined ? [] : [initialFailure];
	for (const stage of stages) {
		try {
			await stage();
		} catch (cause) {
			failures.push(cause);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}

/**
 * Open the sole OPFS SQLite owner for one browser origin replica.
 *
 * This function must run in the dedicated worker that won the origin storage
 * lease. Quota and runtime-capability failures escape this owner boundary and
 * never become semantic replica errors.
 */
export async function openBrowserReplicaOwner({
	limits,
	initialize,
	databaseFilename = DEFAULT_DATABASE_FILENAME,
	poolDirectory = DEFAULT_POOL_DIRECTORY,
	poolName = DEFAULT_POOL_NAME,
	onStolen,
	signal,
}: OpenBrowserReplicaOwnerOptions) {
	let lease: BrowserStorageLease | undefined;
	let pool: SAHPoolUtil | undefined;
	let database: Database | undefined;
	let ownerGeneration: number | undefined;
	let stopInvalidationSources = () => undefined;
	const lifetime = createBrowserReplicaOwnerLifetime({
		stopSources() {
			stopInvalidationSources();
		},
		closeDatabase() {
			const opened = database;
			database = undefined;
			opened?.close();
		},
		pauseVfs() {
			const opened = pool;
			pool = undefined;
			opened?.pauseVfs();
		},
		async releaseLease() {
			const held = lease;
			lease = undefined;
			await held?.release();
		},
	});
	try {
		lease = await acquireBrowserStorageLease(navigator.locks, {
			onStolen() {
				lifetime.ownerLost();
				onStolen?.();
			},
			...(signal === undefined ? {} : { signal }),
		});
		lifetime.requireOpening();
		ownerGeneration = await incrementOwnerGeneration();
		lifetime.requireOpening();
		signal?.throwIfAborted();
		const sqlite = await sqlite3InitModule();
		lifetime.requireOpening();
		pool = await sqlite.installOpfsSAHPoolVfs({
			name: poolName,
			directory: poolDirectory,
		});
		lifetime.requireOpening();
		const openedPool = pool;
		sweepSnapshotDebris(openedPool);
		database = new openedPool.OpfsSAHPoolDb(databaseFilename);
		configureDatabase(database);
		const files = await createBrowserOpfsBlobFileStore();
		lifetime.requireOpening();
		let openedStores = createStores(database, limits, files, initialize);
		const invalidationListeners = new Set<() => void>();
		let stopRecords: (() => void) | undefined;
		let stopBlobs: (() => void) | undefined;
		function notifyInvalidation(): void {
			for (const listener of invalidationListeners) {
				try {
					listener();
				} catch {
					// An observer cannot interrupt the storage owner.
				}
			}
		}
		function bindInvalidationSources(): void {
			stopRecords?.();
			stopBlobs?.();
			stopRecords = openedStores.store.subscribe(notifyInvalidation);
			stopBlobs = openedStores.blobs.subscribe(notifyInvalidation);
		}
		stopInvalidationSources = () => {
			const failures: unknown[] = [];
			const records = stopRecords;
			stopRecords = undefined;
			const blobs = stopBlobs;
			stopBlobs = undefined;
			invalidationListeners.clear();
			for (const stop of [records, blobs]) {
				try {
					stop?.();
				} catch (cause) {
					failures.push(cause);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					'Browser replica invalidation cleanup failed',
				);
			}
		};
		bindInvalidationSources();
		await openedStores.blobs.reopenSweep();
		lifetime.activate();

		return {
			get ownerGeneration() {
				lifetime.requireActive();
				if (ownerGeneration === undefined)
					throw new Error('browser replica owner generation is unavailable');
				return ownerGeneration;
			},
			get store() {
				lifetime.requireActive();
				return openedStores.store;
			},
			get blobs() {
				lifetime.requireActive();
				return openedStores.blobs;
			},
			subscribeInvalidation(listener: () => void): () => void {
				lifetime.requireActive();
				invalidationListeners.add(listener);
				return () => invalidationListeners.delete(listener);
			},
			integrityCheck(): void {
				lifetime.requireActive();
				const adapter = createBrowserSqliteAdapter(
					database as unknown as BrowserSqliteDatabase,
				);
				const rows = adapter.all<IntegrityRow>('PRAGMA integrity_check');
				if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
					throw new Error('browser replica SQLite integrity check failed');
				}
			},
			async captureSnapshot({ lens }: { lens?: LensDefinition } = {}) {
				lifetime.requireActive();
				const filename = `/epicenter-snapshot-${crypto.randomUUID()}.sqlite3`;
				let artifactDatabase: Database | undefined;
				const cleanup = (initialFailure?: unknown) =>
					settleCleanup(
						[
							() => artifactDatabase?.close(),
							() => {
								openedPool.unlink(filename);
							},
						],
						'Browser snapshot cleanup failed',
						initialFailure,
					);
				let metadata: ReturnType<typeof openedStores.store.captureSnapshot>;
				let bytes: Uint8Array;
				try {
					await openedPool.reserveMinimumCapacity(
						Number(openedPool.getFileCount()) + 3,
					);
					artifactDatabase = new openedPool.OpfsSAHPoolDb(filename);
					configureDatabase(artifactDatabase);
					metadata = openedStores.store.captureSnapshot({
						database: createBrowserSqliteAdapter(
							artifactDatabase as unknown as BrowserSqliteDatabase,
						),
						...(lens === undefined ? {} : { lens }),
					});
					artifactDatabase.close();
					artifactDatabase = undefined;
					bytes = await openedPool.exportFile(filename);
				} catch (cause) {
					await cleanup(cause);
					throw cause;
				}
				await cleanup();
				return {
					artifact: new Blob([bytes], { type: 'application/vnd.sqlite3' }),
					metadata,
				};
			},
			async reopen(): Promise<void> {
				lifetime.requireActive();
				database?.close();
				database = new openedPool.OpfsSAHPoolDb(databaseFilename);
				configureDatabase(database);
				openedStores = createStores(database, limits, files);
				bindInvalidationSources();
				await openedStores.blobs.reopenSweep();
				lifetime.requireActive();
			},
			async dispose(): Promise<void> {
				stopInvalidationSources();
				await lifetime.dispose();
			},
		};
	} catch (cause) {
		await settleCleanup(
			[lifetime.dispose],
			'Browser replica owner opening and cleanup failed',
			cause,
		);
		throw cause;
	}
}

export type BrowserReplicaOwner = Awaited<
	ReturnType<typeof openBrowserReplicaOwner>
>;
