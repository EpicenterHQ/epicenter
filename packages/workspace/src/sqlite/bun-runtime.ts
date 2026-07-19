import { Database } from 'bun:sqlite';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import {
	attachAuthenticatedDocumentConnection,
	rowDocumentWebSocketUrl,
} from '../document-provider/connection/index.js';
import {
	createSqliteDocumentLog,
	type SqliteDocumentLog,
} from '../document-provider/sqlite-document-log.js';

import {
	accountStorageIdentity,
	type WorkspaceAccount,
} from './account-runtime.js';
import {
	captureLocalWorkspace,
	deleteLocalWorkspace,
	type LogicalWorkspaceCopy,
	type LogicalWorkspaceExport,
	logicalWorkspaceIntents,
} from './canonical-addition.js';
import {
	createCanonicalSyncSupervisor,
	type WorkspaceSyncSettlement,
} from './canonical-sync-supervisor.js';
import {
	type CurrentStateReplicaTransport,
	createCurrentStateReplica,
} from './current-state-replica.js';
import { classifyCurrentStateTransport } from './current-state-transport.js';
import {
	initializeLocalWorkspaceStorage,
	readLocalRow,
} from './local-workspace-storage.js';
import { createWorkspaceRuntime } from './runtime.js';
import type { WorkspaceDefinition } from './runtime-definition.js';

const ownedRoots = new Set<string>();

export type BunWorkspaceAccount = WorkspaceAccount<
	(
		workspaceId: string,
	) => CurrentStateReplicaTransport | Promise<CurrentStateReplicaTransport>
>;

type BunWorkspaceRuntimeBehaviorOptions = {
	onRecordsChanged?(workspaceId: string): void;
	onSyncError?(cause: unknown, workspaceId: string): void;
	recordPollIntervalMs?: number;
	/** Native auth-owned document transport. Omit only for Device workspaces. */
	documentTransport?: {
		baseUrl: string;
		openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	};
};

export type BunWorkspaceRuntimeOptions = BunWorkspaceRuntimeBehaviorOptions & {
	/** Parent of the runtime-owned `device` and `accounts` directories. */
	workspacesRoot: string;
};

export function createDeviceBunWorkspaceRuntime({
	workspacesRoot,
	...options
}: BunWorkspaceRuntimeOptions) {
	const runtime = createBunRuntimeWithPersistence({
		...options,
		ownerRoot: resolve(workspacesRoot, 'device'),
	});
	return Object.freeze({
		open: runtime.open,
		async capture(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return runtime.captureLocal(definition.id);
		},
		/** A Device export is the local capture; there is no authority to settle. */
		async export(
			definition: WorkspaceDefinition,
		): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			await runtime.captureDurability(definition.id);
			return {
				settlement: null,
				...(await runtime.captureLocal(definition.id)),
			};
		},
		async delete(definition: WorkspaceDefinition) {
			await runtime.open(definition);
			await runtime.deleteLocal(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

export function createAccountBunWorkspaceRuntime({
	account,
	workspacesRoot,
	...options
}: BunWorkspaceRuntimeOptions & { account: BunWorkspaceAccount }) {
	const identity = accountStorageIdentity(account);
	const runtime = createBunRuntimeWithPersistence({
		...options,
		ownerRoot: resolve(workspacesRoot, 'accounts', identity.key),
		accountWitness: JSON.stringify(identity.witness),
		recordTransport: account.transport,
	});
	return Object.freeze({
		open: runtime.open,
		async add(definition: WorkspaceDefinition, copy: LogicalWorkspaceCopy) {
			await runtime.open(definition);
			await runtime.whenReady(definition.id);
			await runtime.addToAccount(definition.id, copy);
		},
		async export(
			definition: WorkspaceDefinition,
		): Promise<LogicalWorkspaceExport> {
			await runtime.open(definition);
			return runtime.exportAccount(definition.id);
		},
		[Symbol.asyncDispose]: runtime[Symbol.asyncDispose],
	});
}

/** Open a Bun runtime whose `open()` eagerly acquires its SQLite owner. */
function createBunRuntimeWithPersistence({
	ownerRoot,
	accountWitness,
	recordTransport,
	onRecordsChanged = () => undefined,
	onSyncError = () => undefined,
	recordPollIntervalMs = 30_000,
	documentTransport,
}: BunWorkspaceRuntimeBehaviorOptions & {
	ownerRoot: string;
	accountWitness?: string;
	recordTransport?: BunWorkspaceAccount['transport'];
}) {
	if (!Number.isFinite(recordPollIntervalMs) || recordPollIntervalMs <= 0) {
		throw new Error('Record poll interval must be a positive finite number');
	}
	const root = resolve(ownerRoot);
	const localWorkspaces = new Map<
		string,
		{
			sqlite: ReturnType<typeof createBunSqliteAdapter>;
			documents: SqliteDocumentLog;
			notifyDeleted(addresses: { table: string; rowId: string }[]): void;
			emitChanged(): void;
		}
	>();
	const accountWorkspaces = new Map<
		string,
		{
			replica: ReturnType<typeof createCurrentStateReplica>;
			documents: SqliteDocumentLog;
			settle(): Promise<WorkspaceSyncSettlement>;
			wake(): void;
			emitChanged(): void;
		}
	>();
	if (ownedRoots.has(root)) {
		throw new Error(`Workspace runtime storage already has an owner: ${root}`);
	}
	ownedRoots.add(root);
	try {
		mkdirSync(root, { recursive: true });
		if (accountWitness !== undefined) {
			bindAccountWitness(root, accountWitness);
		}
	} catch (cause) {
		ownedRoots.delete(root);
		throw cause;
	}

	const runtime = createWorkspaceRuntime({
		async openWorkspaceOwner(workspaceId, signal) {
			const path = join(root, workspaceId, 'store.sqlite3');
			let database: Database | undefined;
			try {
				mkdirSync(dirname(path), { recursive: true });
				database = new Database(path, { create: true });
				database.exec('PRAGMA busy_timeout = 5000');
				database.exec('PRAGMA journal_mode = WAL');
				const sqlite = createBunSqliteAdapter(database);
				const transport = await abortable(
					Promise.resolve(recordTransport?.(workspaceId)),
					signal,
				);
				let ownerDisposed = false;
				const reportSyncError = (cause: unknown): void => {
					try {
						onSyncError(cause, workspaceId);
					} catch {
						// Reporting cannot become another synchronization failure.
					}
				};
				const emitRecordsChanged = (): void => {
					if (ownerDisposed) return;
					try {
						onRecordsChanged(workspaceId);
					} catch (cause) {
						reportSyncError(cause);
					}
				};
				if (!transport) {
					initializeLocalWorkspaceStorage(sqlite);
					const documents = createSqliteDocumentLog({
						database: sqlite,
						isRowLive: ({ table, rowId }) =>
							readLocalRow(sqlite, table, rowId) !== undefined,
					});
					const deletionListeners = new Set<
						(addresses: { table: string; rowId: string }[]) => void
					>();
					localWorkspaces.set(workspaceId, {
						sqlite,
						documents,
						notifyDeleted(addresses) {
							for (const listener of deletionListeners) {
								try {
									listener(addresses);
								} catch (cause) {
									reportSyncError(cause);
								}
							}
						},
						emitChanged: emitRecordsChanged,
					});
					return {
						sqlite,
						documentLog: documents,
						onLocalCommit() {
							queueMicrotask(emitRecordsChanged);
						},
						subscribeRowsDeleted(listener) {
							deletionListeners.add(listener);
							return () => deletionListeners.delete(listener);
						},
						async [Symbol.asyncDispose]() {
							ownerDisposed = true;
							localWorkspaces.delete(workspaceId);
							database?.close();
						},
					};
				}

				const deletionListeners = new Set<
					(addresses: { table: string; rowId: string }[]) => void
				>();
				const cancellableTransport: CurrentStateReplicaTransport = {
					push: (request) => abortable(transport.push(request), signal),
					pull: (request) => abortable(transport.pull(request), signal),
					acquire: (request) => abortable(transport.acquire(request), signal),
				};
				// The log reads liveness through the replica's current projection;
				// the closure is only invoked on appends, after both exist.
				const documents = createSqliteDocumentLog({
					database: sqlite,
					isRowLive: ({ table, rowId }) =>
						replica.readCurrentRow(table, rowId) !== undefined,
				});
				const replica = createCurrentStateReplica({
					sqlite,
					transport: cancellableTransport,
					documents,
					onRemoteCommit() {
						emitRecordsChanged();
					},
					onRowsDeleted(addresses) {
						for (const listener of deletionListeners) listener(addresses);
					},
				});
				const supervisor = createCanonicalSyncSupervisor({
					driver: classifyCurrentStateTransport(replica),
					pollIntervalMs: recordPollIntervalMs,
					onFatal(cause) {
						if (!signal.aborted) reportSyncError(cause);
					},
				});
				accountWorkspaces.set(workspaceId, {
					replica,
					documents,
					settle: supervisor.settle,
					wake: supervisor.wake,
					emitChanged: emitRecordsChanged,
				});
				return {
					sqlite,
					documentLog: documents,
					...(documentTransport
						? {
								connectDocument(address, document) {
									const connection = attachAuthenticatedDocumentConnection({
										document,
										url: rowDocumentWebSocketUrl({
											baseUrl: documentTransport.baseUrl,
											workspaceId,
											address,
										}),
										openWebSocket: documentTransport.openWebSocket,
									});
									return {
										connection,
										dispose: connection.dispose,
									};
								},
							}
						: {}),
					sync: supervisor,
					admitIntent(intent) {
						replica.admit(intent);
						queueMicrotask(() => {
							emitRecordsChanged();
							supervisor.wake();
						});
					},
					readCurrentRow: replica.readCurrentRow,
					subscribeRowsDeleted(
						listener: (addresses: { table: string; rowId: string }[]) => void,
					) {
						deletionListeners.add(listener);
						return () => deletionListeners.delete(listener);
					},
					async [Symbol.asyncDispose]() {
						ownerDisposed = true;
						accountWorkspaces.delete(workspaceId);
						await supervisor.dispose();
						database?.close();
					},
				};
			} catch (cause) {
				database?.close();
				throw cause;
			}
		},
	});

	let isDisposed = false;
	return Object.freeze({
		open: runtime.open,
		captureDurability: runtime.captureDurability,
		whenReady: runtime.whenReady,
		async captureLocal(workspaceId: string): Promise<LogicalWorkspaceCopy> {
			const state = localWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			return captureLocalWorkspace(state.sqlite, state.documents.capture);
		},
		async deleteLocal(workspaceId: string): Promise<void> {
			const state = localWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Device workspace '${workspaceId}' is not open`);
			// Revoke live handles first so already-captured edits drain into the
			// log before deletion; then scalar and document death commit in one
			// transaction.
			await runtime.revokeDocuments(
				workspaceId,
				new Error('Device workspace data was deleted'),
			);
			const addresses = state.sqlite.all<{ table: string; rowId: string }>(
				`SELECT table_key AS "table", row_id AS "rowId" FROM "rows"
				 ORDER BY table_key, row_id`,
			);
			deleteLocalWorkspace(state.sqlite, state.documents.deleteAllRows);
			state.notifyDeleted(addresses);
			state.emitChanged();
		},
		async exportAccount(workspaceId: string): Promise<LogicalWorkspaceExport> {
			const state = accountWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Account workspace '${workspaceId}' is not open`);
			// Best effort: a pending settlement (offline, storage-limit) never
			// blocks export; the outcome reports the quality of the scalar cut.
			const settlement = await state.settle();
			await runtime.captureDurability(workspaceId);
			// captureVisible folds each row's compact document state owner-side.
			return { settlement, ...state.replica.captureVisible() };
		},
		async addToAccount(
			workspaceId: string,
			copy: LogicalWorkspaceCopy,
		): Promise<void> {
			const state = accountWorkspaces.get(workspaceId);
			if (!state)
				throw new Error(`Account workspace '${workspaceId}' is not open`);
			state.replica.admitMany(logicalWorkspaceIntents(copy));
			// The runtime importer applies through an already-open destination
			// document (so retry-add never conflicts with its persistence lease)
			// and otherwise imports through a disposed transient lease.
			for (const row of copy.rows) {
				if (row.document === undefined) continue;
				await runtime.importDocument(
					workspaceId,
					{ table: row.table, rowId: row.rowId },
					row.document,
				);
			}
			queueMicrotask(() => {
				state.emitChanged();
				state.wake();
			});
		},
		async [Symbol.asyncDispose]() {
			if (isDisposed) return;
			isDisposed = true;
			try {
				await runtime[Symbol.asyncDispose]();
			} finally {
				ownedRoots.delete(root);
			}
		},
	});
}

export type BunWorkspaceRuntime = ReturnType<
	typeof createDeviceBunWorkspaceRuntime
>;

function bindAccountWitness(root: string, encoded: string): void {
	const path = join(root, 'account.json');
	if (existsSync(path)) {
		if (readFileSync(path, 'utf8') !== encoded) {
			throw new Error(
				`Account workspace storage identity does not match ${path}`,
			);
		}
		return;
	}
	writeFileAtomic(path, encoded);
}

function writeFileAtomic(path: string, value: string | Uint8Array): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, value, { flag: 'wx' });
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const abort = () => rejectPromise(signal.reason);
		signal.addEventListener('abort', abort, { once: true });
		promise.then(resolvePromise, rejectPromise).finally(() => {
			signal.removeEventListener('abort', abort);
		});
	});
}
