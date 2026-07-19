import type { SqliteDatabase } from '@epicenter/sqlite';
import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
import {
	createSqliteDocumentLog,
	type SqliteDocumentLog,
} from '../document-provider/sqlite-document-log.js';
import {
	type BrowserRecordOperation,
	type BrowserRuntimeMessage,
	type BrowserWorkerInbound,
	type BrowserWorkspaceManifest,
	WORKSPACE_STORAGE_HELD_ERROR_NAME,
	WORKSPACE_STORAGE_MOVED_ERROR_NAME,
} from './browser-runtime-protocol.js';
import {
	acquireBrowserStorageLease,
	type BrowserStorageLease,
} from './browser-storage-lease.js';
import {
	captureLocalWorkspace,
	deleteLocalWorkspace,
	logicalWorkspaceIntents,
} from './canonical-addition.js';
import { type CanonicalKv, createCanonicalKv } from './canonical-kv.js';
import { type CanonicalRows, createCanonicalRows } from './canonical-rows.js';
import {
	type CanonicalSyncSupervisor,
	createCanonicalSyncSupervisor,
} from './canonical-sync-supervisor.js';
import {
	type CurrentStateReplica,
	type CurrentStateReplicaTransport,
	createCurrentStateReplica,
} from './current-state-replica.js';
import {
	CurrentStateTransportInterruption,
	classifyCurrentStateTransport,
} from './current-state-transport.js';
import type { KvDefinitions } from './kv-definition.js';
import { defineTable, type TableLensDefinitions } from './lens-definition.js';
import {
	initializeLocalWorkspaceStorage,
	readLocalRow,
} from './local-workspace-storage.js';

type WorkerScope = {
	postMessage(message: BrowserRuntimeMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: MessageEvent<BrowserWorkerInbound>) => void,
	): void;
};

type OpenedRecords = {
	manifest: BrowserWorkspaceManifest;
	database: Database;
	pool: SAHPoolUtil;
	sqlite: SqliteDatabase;
	records: CanonicalRows;
	kv: CanonicalKv<KvDefinitions>;
	documents: SqliteDocumentLog;
	replica?: CurrentStateReplica;
	sync?: CanonicalSyncSupervisor;
	/** Held until Worker termination so this storage has one SQLite owner. */
	retainedLease: BrowserStorageLease;
	/** Set when a newer tab stole the storage; every later operation throws. */
	stolen?: Error;
};

const scope = self as unknown as WorkerScope;
const opened = new Map<string, Promise<OpenedRecords>>();
const transportRequests = new Map<
	number,
	{ resolve(value: unknown): void; reject(cause: unknown): void }
>();
let sqliteModule: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
const sahPools = new Map<string, Promise<SAHPoolUtil>>();

/**
 * One SAH pool VFS per workspace storage key.
 *
 * The pool VFS needs no cross-origin isolation (unlike the
 * SharedArrayBuffer-backed 'opfs' VFS), so statically hosted production
 * pages, Tauri WebViews, and iOS Safari can run this worker. A pool
 * directory admits exactly one live VFS instance; the exclusive storage
 * lease acquired before this call already guarantees that for the key, and
 * per-key directories keep concurrent device and account workers disjoint.
 */
function acquireSahPool(
	module: NonNullable<typeof sqliteModule>,
	storageKey: string,
): Promise<SAHPoolUtil> {
	let pool = sahPools.get(storageKey);
	if (!pool) {
		pool = (async () => {
			// The previous owner (a reloaded page or a stolen tab) releases its
			// access handles asynchronously, so first acquisition attempts can
			// race it; retry briefly before declaring the environment unusable.
			let lastFailure: unknown;
			for (let attempt = 0; attempt < 20; attempt += 1) {
				try {
					const util = await module.installOpfsSAHPoolVfs({
						name: `epicenter-${storageKey}`,
						directory: `.epicenter-sahpool-${storageKey}`,
					});
					// A paused pool from an earlier steal in this same worker
					// lifetime resumes instead of reinstalling.
					return util.isPaused() ? await util.unpauseVfs() : util;
				} catch (cause) {
					lastFailure = cause;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
			}
			// Attribute honestly: only access-handle contention means another
			// context still holds the storage (a suspended tab or backgrounded
			// PWA that cannot answer the steal notification). Chromium reports
			// contention as NoModificationAllowedError per spec; WebKit reports
			// InvalidStateError. Anything else (for example OPFS entirely
			// unavailable, as in Safari private browsing) must not tell the
			// user to close other tabs.
			const isHandleContention =
				lastFailure instanceof Error &&
				(lastFailure.name === 'NoModificationAllowedError' ||
					lastFailure.name === 'InvalidStateError');
			if (isHandleContention) {
				const held = new Error(
					`Workspace storage '${storageKey}' is still held by another tab or window; close it (or wait for it to resume) and retry`,
					{ cause: lastFailure },
				);
				held.name = WORKSPACE_STORAGE_HELD_ERROR_NAME;
				throw held;
			}
			throw new Error(
				`Browser storage for workspace '${storageKey}' is unavailable: ${
					lastFailure instanceof Error
						? lastFailure.message
						: String(lastFailure)
				}`,
				{ cause: lastFailure },
			);
		})();
		void pool.catch(() => sahPools.delete(storageKey));
		sahPools.set(storageKey, pool);
	}
	return pool;
}
let tail = Promise.resolve();
let transportId = 0;

async function openRecords(
	manifest: BrowserWorkspaceManifest,
): Promise<OpenedRecords> {
	let opening = opened.get(manifest.workspaceId);
	if (!opening) {
		opening = (async () => {
			let retainedLease: BrowserStorageLease | undefined;
			let database: Database | undefined;
			// The lease is acquired before the database exists; the box lets the
			// steal notification reach the fully built state (or flag a steal
			// that lands mid-open).
			let stolenEarly = false;
			let handleStolen = (): void => {
				stolenEarly = true;
			};
			try {
				retainedLease = await acquireBrowserStorageLease(
					navigator.locks,
					manifest.storageKey,
					{ onStolen: () => handleStolen() },
				);
				sqliteModule ??= await sqlite3InitModule();
				const pool = await acquireSahPool(sqliteModule, manifest.storageKey);
				database = new pool.OpfsSAHPoolDb(
					`/epicenter-${manifest.storageKey}.sqlite3`,
				);
				// EXTRA extends FULL by syncing rollback-journal deletion in DELETE
				// mode, strengthening the configured local commit boundary.
				database.exec(`
					PRAGMA busy_timeout = 5000;
					PRAGMA journal_mode = DELETE;
					PRAGMA synchronous = EXTRA;
					PRAGMA temp_store = MEMORY;
				`);
				const definitions = Object.fromEntries(
					Object.entries(manifest.tables).map(([name, lens]) => [
						name,
						defineTable({ fields: lens.fields, optional: lens.optional }),
					]),
				) as TableLensDefinitions;
				const sqlite = createBrowserSqliteAdapter(
					database as unknown as BrowserSqliteDatabase,
				);
				if (!manifest.rowSync) initializeLocalWorkspaceStorage(sqlite);
				// The log reads liveness through the replica projection when one
				// exists (the closure runs only on appends, after both exist) and
				// through confirmed local rows otherwise.
				const documents = createSqliteDocumentLog({
					database: sqlite,
					isRowLive: ({ table, rowId }) =>
						(replica
							? replica.readCurrentRow(table, rowId)
							: readLocalRow(sqlite, table, rowId)) !== undefined,
				});
				const replica = manifest.rowSync
					? createCurrentStateReplica({
							sqlite,
							transport: createRecordTransport(manifest.workspaceId),
							documents,
							onRemoteCommit() {
								scope.postMessage({
									type: 'records-changed',
									workspaceId: manifest.workspaceId,
								});
							},
							onRowsDeleted(addresses) {
								scope.postMessage({
									type: 'rows-deleted',
									workspaceId: manifest.workspaceId,
									addresses,
								});
							},
						})
					: undefined;
				const records = createCanonicalRows(sqlite, definitions, {
					admitIntent: replica?.admit,
					readCurrentRow: replica?.readCurrentRow,
					deleteDocumentRows: documents.deleteRows,
				});
				const kv = createCanonicalKv(
					sqlite,
					(manifest.kv ?? {}) as KvDefinitions,
					{
						admitIntent: replica?.admit,
						readCurrentRow: replica?.readCurrentRow,
					},
				);
				const sync = replica
					? createCanonicalSyncSupervisor({
							driver: classifyCurrentStateTransport(replica),
							pollIntervalMs: manifest.rowSync?.intervalMs,
							onFatal(cause) {
								scope.postMessage({
									type: 'background-error',
									workspaceId: manifest.workspaceId,
									name: cause instanceof Error ? cause.name : 'Error',
									message:
										cause instanceof Error ? cause.message : String(cause),
								});
							},
						})
					: undefined;
				sync?.onStatusChange((status) => {
					scope.postMessage({
						type: 'sync-status',
						workspaceId: manifest.workspaceId,
						status,
					});
				});
				const state: OpenedRecords = {
					manifest,
					database,
					pool,
					sqlite,
					records,
					kv,
					documents,
					replica,
					sync,
					retainedLease,
				};
				handleStolen = () => markStolen(state);
				if (stolenEarly) handleStolen();
				return state;
			} catch (cause) {
				const cleanupFailures: unknown[] = [];
				try {
					database?.close();
				} catch (cleanupCause) {
					cleanupFailures.push(cleanupCause);
				}
				try {
					await retainedLease?.release();
				} catch (cleanupCause) {
					cleanupFailures.push(cleanupCause);
				}
				if (cleanupFailures.length > 0) {
					throw new AggregateError(
						[cause, ...cleanupFailures],
						'Browser workspace initialization and cleanup failed',
					);
				}
				throw cause;
			}
		})();
		// A failed acquisition is terminal for this Worker: the rejected
		// promise stays cached so every queued and later operation rejects
		// immediately with the same failure (for example the named
		// held-storage error) instead of re-running the multi-second
		// acquisition retry loop per operation. Recovery is an explicit
		// reload, which replaces the Worker.
		opened.set(manifest.workspaceId, opening);
	}
	const state = await opening;
	if (
		state.manifest.storageKey !== manifest.storageKey ||
		JSON.stringify(state.manifest.tables) !== JSON.stringify(manifest.tables) ||
		JSON.stringify(state.manifest.kv) !== JSON.stringify(manifest.kv) ||
		JSON.stringify(state.manifest.rowSync) !== JSON.stringify(manifest.rowSync)
	) {
		throw new Error(
			`Workspace '${manifest.workspaceId}' is already bound to another release-local lens in this Worker`,
		);
	}
	return state;
}

/**
 * A newer tab stole this workspace's storage: stop syncing, close the
 * database, release the SAH pool's access handles so the thief can acquire
 * them, and degrade every later operation to a loud failure. Runs on the
 * worker's operation tail so it never closes the database mid-statement.
 */
function markStolen(state: OpenedRecords): void {
	if (state.stolen) return;
	state.stolen = new Error(
		`Workspace '${state.manifest.workspaceId}' storage moved to a newer tab`,
	);
	state.stolen.name = WORKSPACE_STORAGE_MOVED_ERROR_NAME;
	tail = tail.then(async () => {
		try {
			await state.sync?.[Symbol.asyncDispose]();
		} catch {
			// The supervisor may already be failing; the teardown continues.
		}
		try {
			state.database.close();
		} catch {
			// A close failure must not keep the access handles held below.
		}
		try {
			state.pool.pauseVfs();
			sahPools.delete(state.manifest.storageKey);
		} catch {
			// Pause can fail if another database still uses the pool; the
			// thief's acquisition retry loop absorbs the delay.
		}
		scope.postMessage({
			type: 'background-error',
			workspaceId: state.manifest.workspaceId,
			name: state.stolen?.name ?? WORKSPACE_STORAGE_MOVED_ERROR_NAME,
			message:
				state.stolen?.message ?? 'Workspace storage moved to a newer tab',
		});
	});
}

function createRecordTransport(
	workspaceId: string,
): CurrentStateReplicaTransport {
	const post = (
		action: 'push' | 'pull' | 'acquire',
		body: unknown,
	): Promise<unknown> => {
		const id = ++transportId;
		return new Promise((resolve, reject) => {
			transportRequests.set(id, { resolve, reject });
			scope.postMessage({
				type: 'transport-request',
				transportId: id,
				workspaceId,
				action,
				body,
			});
		});
	};
	return {
		push: (request) => post('push', request),
		pull: (request) => post('pull', request),
		acquire: (request) => post('acquire', request),
	};
}

function tableFor(records: CanonicalRows, name: string) {
	const table = records.tables[name];
	if (!table) throw new Error(`Unknown canonical table '${name}'`);
	return table;
}

async function execute(
	state: OpenedRecords,
	operation: BrowserRecordOperation,
) {
	const { records } = state;
	switch (operation.kind) {
		case 'open':
			return { isReady: state.replica?.isReady() ?? true };
		case 'get':
			return tableFor(records, operation.table).get(operation.id);
		case 'kv-get':
			return state.kv.get(operation.key);
		case 'kv-set':
			return state.kv.set(operation.key, operation.value as never);
		case 'kv-unset':
			state.kv.unset(operation.key);
			return undefined;
		case 'read-current-row':
			return state.replica
				? state.replica.readCurrentRow(operation.table, operation.rowId)
				: readLocalRow(state.sqlite, operation.table, operation.rowId);
		case 'document-load':
			return state.documents.load({
				table: operation.table,
				rowId: operation.rowId,
			});
		case 'document-append':
			state.documents.append(
				{ table: operation.table, rowId: operation.rowId },
				new Uint8Array(operation.update),
			);
			return undefined;
		case 'sync-settle':
			throw new Error('Sync settlement must not block the Worker request tail');
		case 'sync-start-fresh':
			throw new Error(
				'Fresh-lineage acquisition must not block the Worker request tail',
			);
		case 'sync-capture-recovery':
			if (!state.sync) {
				throw new Error('Local-only workspace has no synchronization');
			}
			return state.sync.captureRecovery();
		case 'logical-capture':
			if (state.replica) {
				throw new Error('Only Device workspaces expose logical capture');
			}
			return captureLocalWorkspace(state.sqlite, state.documents.capture);
		case 'capture-visible':
			if (!state.replica) {
				throw new Error('Only Account workspaces expose visible capture');
			}
			return state.replica.captureVisible();
		case 'logical-add':
			if (!state.replica) {
				throw new Error('Only Account workspaces accept logical additions');
			}
			state.replica.admitMany(logicalWorkspaceIntents(operation.copy));
			return undefined;
		case 'logical-delete':
			if (state.replica) {
				throw new Error('Only Device workspaces expose logical deletion');
			}
			deleteLocalWorkspace(state.sqlite, state.documents.deleteAllRows);
			return undefined;
		case 'list':
			return tableFor(records, operation.table).list();
		case 'create':
			return tableFor(records, operation.table).create(operation.input);
		case 'update':
			return tableFor(records, operation.table).update(
				operation.id,
				operation.changes,
			);
		case 'delete':
			tableFor(records, operation.table).delete(operation.id);
			return undefined;
		case 'sql':
			return records.sql(
				operation.query,
				operation.parameters,
				operation.resultSchema,
			);
		default:
			return operation satisfies never;
	}
}

scope.addEventListener('message', (event) => {
	const message = event.data;
	if ('type' in message) {
		const pending = transportRequests.get(message.transportId);
		if (!pending) return;
		transportRequests.delete(message.transportId);
		if (message.type === 'transport-result') pending.resolve(message.value);
		else {
			let cause: Error;
			if (message.pendingReason) {
				cause = new CurrentStateTransportInterruption(
					message.pendingReason,
					message.message,
				);
			} else {
				cause = new Error(message.message);
				cause.name = message.name;
			}
			pending.reject(cause);
		}
		return;
	}
	const request = message;
	tail = tail.then(async () => {
		try {
			const state = await openRecords(request.manifest);
			if (state.stolen) throw state.stolen;
			if (request.operation.kind === 'sync-settle') {
				if (!state.sync) {
					throw new Error('Local-only workspace has no synchronization');
				}
				void state.sync.settle().then(
					(value) => {
						scope.postMessage({ type: 'result', id: request.id, value });
					},
					(cause) => {
						scope.postMessage({
							type: 'error',
							id: request.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					},
				);
				return;
			}
			if (request.operation.kind === 'sync-start-fresh') {
				if (!state.sync) {
					throw new Error('Local-only workspace has no synchronization');
				}
				void state.sync.startFresh().then(
					() => {
						scope.postMessage({
							type: 'result',
							id: request.id,
							value: undefined,
						});
					},
					(cause) => {
						scope.postMessage({
							type: 'error',
							id: request.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					},
				);
				return;
			}
			const value = await execute(state, request.operation);
			scope.postMessage({ type: 'result', id: request.id, value });
			if (
				request.operation.kind === 'create' ||
				request.operation.kind === 'update' ||
				request.operation.kind === 'delete' ||
				request.operation.kind === 'kv-set' ||
				request.operation.kind === 'kv-unset' ||
				request.operation.kind === 'logical-add' ||
				request.operation.kind === 'logical-delete'
			) {
				scope.postMessage({
					type: 'records-changed',
					workspaceId: request.manifest.workspaceId,
				});
				state.sync?.wake();
			}
		} catch (cause) {
			scope.postMessage({
				type: 'error',
				id: request.id,
				name: cause instanceof Error ? cause.name : 'Error',
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	});
});

scope.postMessage({ type: 'ready' });
