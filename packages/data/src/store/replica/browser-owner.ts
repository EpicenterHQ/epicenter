import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
import type { ValidatedLimits } from '../../protocol/v1/index.js';
import { createReplicaBlobStore } from './blob-store.js';
import {
	createBrowserOpfsBlobFileStore,
	type OpfsDirectoryHandle,
} from './browser-opfs-blob-files.js';
import { createBrowserReplicaOwnerLifetime } from './browser-owner-lifetime.js';
import { openReplicaStore, type ReplicaOwner } from './replica-store.js';
import {
	acquireBrowserStorageLease,
	type BrowserStorageLease,
} from './storage-lease.js';

const DEFAULT_DATABASE_FILENAME = '/epicenter-data-v1.sqlite3';
const DEFAULT_POOL_DIRECTORY = '.epicenter-data-v1-sahpool';
const DEFAULT_POOL_NAME = 'epicenter-data-v1';

type ReplicaInitialization = {
	replicaId: string;
	authorityLifetime?: string;
};

export type OpenBrowserReplicaOwnerOptions = {
	limits: ValidatedLimits;
	/** Immutable identity this physical replica must have (ADR-0178). */
	owner: ReplicaOwner | null;
	initialize?: ReplicaInitialization;
	databaseFilename?: string;
	poolDirectory?: string;
	poolName?: string;
	lockName?: string;
	/**
	 * OPFS directory for raw blob bytes. Defaults to the legacy origin-root
	 * `blobs` layout; identity-slotted callers pass their slot directory so
	 * replicas never share blob storage.
	 */
	blobDirectory?: string;
};

async function opfsRoot(): Promise<OpfsDirectoryHandle> {
	return await (
		navigator as unknown as {
			storage: { getDirectory(): Promise<OpfsDirectoryHandle> };
		}
	).storage.getDirectory();
}

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
	owner: ReplicaOwner | null,
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
			owner,
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
	owner,
	initialize,
	databaseFilename = DEFAULT_DATABASE_FILENAME,
	poolDirectory = DEFAULT_POOL_DIRECTORY,
	poolName = DEFAULT_POOL_NAME,
	lockName,
	blobDirectory,
}: OpenBrowserReplicaOwnerOptions) {
	let lease: BrowserStorageLease | undefined;
	let pool: SAHPoolUtil | undefined;
	let database: Database | undefined;
	const lifetime = createBrowserReplicaOwnerLifetime({
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
		lease = await acquireBrowserStorageLease(
			navigator.locks,
			lockName === undefined ? {} : { name: lockName },
		);
		lifetime.requireOpening();
		const sqlite = await sqlite3InitModule();
		lifetime.requireOpening();
		pool = await sqlite.installOpfsSAHPoolVfs({
			name: poolName,
			directory: poolDirectory,
		});
		lifetime.requireOpening();
		const openedPool = pool;
		database = new openedPool.OpfsSAHPoolDb(databaseFilename);
		configureDatabase(database);
		const files = await createBrowserOpfsBlobFileStore(
			blobDirectory === undefined
				? undefined
				: await (await opfsRoot()).getDirectoryHandle(blobDirectory, {
						create: true,
					}),
		);
		lifetime.requireOpening();
		let openedStores = createStores(database, limits, owner, files, initialize);
		await openedStores.blobs.reopenSweep();
		lifetime.activate();

		return {
			get store() {
				lifetime.requireActive();
				return openedStores.store;
			},
			get blobs() {
				lifetime.requireActive();
				return openedStores.blobs;
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
			async reopen(): Promise<void> {
				lifetime.requireActive();
				database?.close();
				database = new openedPool.OpfsSAHPoolDb(databaseFilename);
				configureDatabase(database);
				openedStores = createStores(database, limits, owner, files);
				await openedStores.blobs.reopenSweep();
				lifetime.requireActive();
			},
			dispose: lifetime.dispose,
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
