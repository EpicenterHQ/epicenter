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
import type { ValidatedLimits } from '../../protocol/v1/index.js';
import { createReplicaBlobStore } from './blob-store.js';
import { createBrowserOpfsBlobFileStore } from './browser-opfs-blob-files.js';
import { openReplicaStore } from './replica-store.js';

const DEFAULT_DATABASE_FILENAME = '/epicenter-data-v1.sqlite3';
const DEFAULT_POOL_DIRECTORY = '.epicenter-data-v1-sahpool';
const DEFAULT_POOL_NAME = 'epicenter-data-v1';

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
};

type IntegrityRow = { integrity_check: string };

function configureDatabase(database: Database): void {
	database.exec(`
		PRAGMA busy_timeout = 5000;
		PRAGMA journal_mode = DELETE;
		PRAGMA synchronous = EXTRA;
		PRAGMA temp_store = MEMORY;
	`);
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
}: OpenBrowserReplicaOwnerOptions) {
	let lease: BrowserStorageLease | undefined;
	let pool: SAHPoolUtil | undefined;
	let database: Database | undefined;
	let isDisposed = false;
	try {
		lease = await acquireBrowserStorageLease(navigator.locks);
		const sqlite = await sqlite3InitModule();
		pool = await sqlite.installOpfsSAHPoolVfs({
			name: poolName,
			directory: poolDirectory,
		});
		const openedPool = pool;
		database = new openedPool.OpfsSAHPoolDb(databaseFilename);
		configureDatabase(database);
		const files = await createBrowserOpfsBlobFileStore();
		let openedStores = createStores(database, limits, files, initialize);
		await openedStores.blobs.reopenSweep();

		return {
			get store() {
				if (isDisposed) throw new Error('browser replica owner is disposed');
				return openedStores.store;
			},
			get blobs() {
				if (isDisposed) throw new Error('browser replica owner is disposed');
				return openedStores.blobs;
			},
			integrityCheck(): void {
				if (isDisposed) throw new Error('browser replica owner is disposed');
				const adapter = createBrowserSqliteAdapter(
					database as unknown as BrowserSqliteDatabase,
				);
				const rows = adapter.all<IntegrityRow>('PRAGMA integrity_check');
				if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') {
					throw new Error('browser replica SQLite integrity check failed');
				}
			},
			async reopen(): Promise<void> {
				if (isDisposed) throw new Error('browser replica owner is disposed');
				database?.close();
				database = new openedPool.OpfsSAHPoolDb(databaseFilename);
				configureDatabase(database);
				openedStores = createStores(database, limits, files);
				await openedStores.blobs.reopenSweep();
			},
			async dispose(): Promise<void> {
				if (isDisposed) return;
				isDisposed = true;
				await settleCleanup(
					[
						() => database?.close(),
						() => pool?.pauseVfs(),
						() => lease?.release(),
					],
					'Browser replica owner cleanup failed',
				);
			},
		};
	} catch (cause) {
		await settleCleanup(
			[() => database?.close(), () => pool?.pauseVfs(), () => lease?.release()],
			'Browser replica owner opening and cleanup failed',
			cause,
		);
		throw cause;
	}
}

export type BrowserReplicaOwner = Awaited<
	ReturnType<typeof openBrowserReplicaOwner>
>;
