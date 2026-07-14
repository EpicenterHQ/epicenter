/**
 * Async workspace service over the synchronous application database.
 *
 * Browser workers and native hosts expose this port to async clients. One
 * mutate request becomes one SQLite transaction; the committed event is
 * materialized from post-commit database state before the request resolves.
 */

import type {
	TableCommitDelta,
	WorkspaceCommitDelta,
	WorkspaceMutation,
	WorkspaceServicePort,
	WorkspaceServiceRequest,
	WorkspaceServiceResponse,
} from './client.js';
import type {
	ApplicationDatabase,
	ApplicationTable,
	CommittedApplicationChanges,
} from './database.js';
import type { TableDefinitions } from './definition.js';
import type { RecordsRecoveryCheckpoint } from './recovery-checkpoint.js';
import type { WorkspaceInvalidation } from './service-protocol.js';

type UntypedRow = { id: string } & Record<string, unknown>;
type UntypedTable = ApplicationTable<UntypedRow>;

export type WorkspaceServiceOptions = {
	/** Receives observer failures. Must not throw. */
	onObserverError(error: unknown): void;
	/** Present only when a replica runtime owns a frozen recovery checkpoint. */
	readRecoveryCheckpoint?(): RecordsRecoveryCheckpoint;
};

type WorkspaceServiceRuntime = WorkspaceServicePort &
	Disposable & {
		refresh(invalidation: WorkspaceInvalidation): Promise<void>;
		observeChanges(
			callback: (
				delta: WorkspaceCommitDelta,
				source: 'commit' | 'refresh',
			) => void,
		): () => void;
	};

export function createWorkspaceService<TTables extends TableDefinitions>(
	database: ApplicationDatabase<TTables>,
	{ onObserverError, readRecoveryCheckpoint }: WorkspaceServiceOptions,
) {
	const definition = database.definition;
	const observers = new Set<(delta: WorkspaceCommitDelta) => void>();
	const changeObservers = new Set<
		(delta: WorkspaceCommitDelta, source: 'commit' | 'refresh') => void
	>();
	const tables = database.tables as unknown as Record<string, UntypedTable>;
	let requestTail: Promise<void> = Promise.resolve();
	let isDisposed = false;

	function assertOpen(): void {
		if (isDisposed) throw new Error('Workspace service is disposed');
	}

	function tableFor(name: string): UntypedTable {
		const table = tables[name];
		if (!table || !Object.hasOwn(definition.tables, name)) {
			throw new Error(`Unknown workspace table '${name}'`);
		}
		return table;
	}

	function notify(
		delta: WorkspaceCommitDelta,
		source: 'commit' | 'refresh',
	): void {
		for (const observer of [...observers]) {
			try {
				observer(structuredClone(delta));
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// A broken error sink must not make a committed command look failed.
				}
			}
		}
		for (const observer of [...changeObservers]) {
			try {
				observer(structuredClone(delta), source);
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// A broken error sink must not make committed state look failed.
				}
			}
		}
	}

	const stopDatabaseObserver = database.observe((changes) => {
		notify(materializeDelta(changes, tables), 'commit');
	});

	function applyMutation(
		mutation: WorkspaceMutation,
		tx: {
			tables: Record<string, UntypedTable>;
		},
	): unknown {
		function transactionTable(name: string): UntypedTable {
			tableFor(name);
			const table = tx.tables[name];
			if (!table)
				throw new Error(`Transaction has no workspace table '${name}'`);
			return table;
		}
		switch (mutation.kind) {
			case 'create': {
				const table = transactionTable(mutation.table);
				const row = mutation.row as UntypedRow;
				table.create(row);
				return table.get(row.id);
			}
			case 'patch':
				return transactionTable(mutation.table).patch(
					mutation.rowId,
					mutation.cells,
				);
			case 'remove':
				transactionTable(mutation.table).remove(mutation.rowId);
				return null;
			default:
				mutation satisfies never;
				throw new Error('Unknown workspace mutation');
		}
	}

	function executeRequest(
		request: WorkspaceServiceRequest,
	): WorkspaceServiceResponse {
		assertOpen();
		switch (request.kind) {
			case 'describe':
				return {
					kind: 'workspace',
					workspaceKind: database.identity.kind,
					workspaceId: database.identity.workspaceId,
					recordsDescriptor: database.identity.recordsDescriptor,
					recordsSchemaHash: database.identity.recordsSchemaHash,
				};
			case 'readTablesSnapshot':
				return {
					kind: 'tablesSnapshot',
					rows: database.readLogicalSnapshot().rows,
				};
			case 'readRecoveryCheckpoint':
				if (!readRecoveryCheckpoint) {
					throw new Error('Workspace is not a synchronized replica');
				}
				return {
					kind: 'recoveryCheckpoint',
					checkpoint: readRecoveryCheckpoint(),
				};
			case 'get':
				return { kind: 'row', row: tableFor(request.table).get(request.rowId) };
			case 'list':
				return {
					kind: 'rows',
					rows: tableFor(request.table).list(
						request.options as Parameters<UntypedTable['list']>[0],
					),
				};
			case 'has':
				return {
					kind: 'boolean',
					value: tableFor(request.table).has(request.rowId),
				};
			case 'count':
				return { kind: 'count', value: tableFor(request.table).count() };
			case 'sql':
				return {
					kind: 'sql',
					rows: database.sql(request.query, request.parameters),
				};
			case 'mutate':
				return {
					kind: 'mutation',
					results: database.transact((tx) =>
						request.mutations.map((mutation) =>
							applyMutation(mutation, {
								tables: tx.tables as unknown as Record<string, UntypedTable>,
							}),
						),
					),
				};
			default:
				request satisfies never;
				throw new Error('Unknown workspace service request');
		}
	}

	function request(
		serviceRequest: WorkspaceServiceRequest,
	): Promise<WorkspaceServiceResponse> {
		let capturedRequest: WorkspaceServiceRequest;
		try {
			assertOpen();
			capturedRequest = structuredClone(serviceRequest);
		} catch (cause) {
			return Promise.reject(cause);
		}
		return enqueue(() => executeRequest(capturedRequest));
	}

	function enqueue<TResult>(run: () => TResult): Promise<TResult> {
		const response = requestTail.then(run);
		requestTail = response.then(
			() => undefined,
			() => undefined,
		);
		return response;
	}

	function refresh(invalidation: WorkspaceInvalidation): Promise<void> {
		let captured: WorkspaceInvalidation;
		try {
			assertOpen();
			captured = structuredClone(invalidation);
		} catch (cause) {
			return Promise.reject(cause);
		}
		return enqueue(() => {
			assertOpen();
			const changes: CommittedApplicationChanges = {
				tables: new Map(
					Object.entries(captured.tables).map(([table, ids]) => [
						table,
						new Set(ids),
					]),
				),
			};
			notify(materializeDelta(changes, tables), 'refresh');
		});
	}

	return {
		request,
		refresh,
		observe(callback: (delta: WorkspaceCommitDelta) => void) {
			assertOpen();
			observers.add(callback);
			return () => {
				observers.delete(callback);
			};
		},
		observeChanges(
			callback: (
				delta: WorkspaceCommitDelta,
				source: 'commit' | 'refresh',
			) => void,
		) {
			assertOpen();
			changeObservers.add(callback);
			return () => {
				changeObservers.delete(callback);
			};
		},
		[Symbol.dispose]() {
			if (isDisposed) return;
			isDisposed = true;
			stopDatabaseObserver();
			observers.clear();
			changeObservers.clear();
		},
	} satisfies WorkspaceServiceRuntime;
}

function materializeDelta(
	changes: CommittedApplicationChanges,
	tables: Record<string, UntypedTable>,
): WorkspaceCommitDelta {
	const tableDeltas: Record<string, TableCommitDelta> = {};
	for (const [tableName, changedIds] of changes.tables) {
		const table = tables[tableName];
		if (!table)
			throw new Error(`Committed unknown workspace table '${tableName}'`);
		const upserted: UntypedRow[] = [];
		const removed: string[] = [];
		for (const id of changedIds) {
			const row = table.get(id);
			if (row) upserted.push(row);
			else removed.push(id);
		}
		tableDeltas[tableName] = { upserted, removed };
	}

	return { tables: tableDeltas };
}
