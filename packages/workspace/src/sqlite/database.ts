/**
 * Typed SQLite application-data runtime.
 *
 * Workspace definitions are compiled into ordinary SQLite tables. This module
 * owns application DDL, value codecs, typed CRUD, atomic transactions, and
 * post-commit invalidation. It deliberately knows nothing about transports or
 * Yjs child documents.
 */

import type {
	Cells,
	Operation,
	RecordSyncSqlite,
	SnapshotRow,
	SqliteRow,
	SqliteValue,
} from '@epicenter/record-sync';
import {
	foldRow,
	isAdmissibleOperationSet,
	isAdmissibleSnapshotRow,
} from '@epicenter/record-sync';
import type { TSchema } from 'typebox';
import {
	assertWorkspaceDefinition,
	type CompiledColumn,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type WorkspaceDefinition,
} from './definition.js';

/** Mutable during apply; coordinators inspect operations before committing. */
export type ApplicationMutationContext = {
	readonly operations: readonly Operation[];
};

/**
 * Own the true commit boundary around application SQL and any replica journal.
 * `commit` must call `apply` exactly once and return only after commit succeeds.
 */
export type ApplicationMutationCoordinator = {
	commit<TResult>(
		context: ApplicationMutationContext,
		apply: () => TResult,
	): TResult;
};

export type ApplicationDatabaseOptions = {
	/** Permanent durable identity mode for this database file. */
	kind: 'standalone' | 'replica';
	coordinator?: ApplicationMutationCoordinator;
	/** Receives every observer failure. Must not throw. */
	onObserverError(error: unknown): void;
};

export type ApplicationDatabaseIdentityInspection =
	| { readonly status: 'initialized' }
	| { readonly status: 'invalid'; readonly reason: string };

export type ApplicationLogicalSnapshot = {
	rows: SnapshotRow[];
};

export type ReplicaProjectionTransaction = {
	/** Fold accepted or pending logical operations without creating outbox work. */
	apply(
		operations: readonly Operation[],
		firstSeenServerSequence: number,
	): void;
	/**
	 * Physically remove rows that exist only as this replica's optimistic
	 * pending creations, before folding an accepted page. Under the strict
	 * fold a row may not be live when its own createRow echo arrives; the
	 * later pending replay recreates whatever the page did not accept.
	 */
	retract(rows: readonly { table: string; rowId: string }[]): void;
	/** Replace accepted logical state before replaying pending outbox operations. */
	replace(rows: readonly SnapshotRow[], snapshotSequence: number): void;
};

/**
 * The replica's local state contradicts the accepted canonical order (for
 * example a createRow folded onto a live identity). Recovery is discarding
 * the replica and rebootstrapping from the authority, never local repair.
 */
export class ReplicaInvariantViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ReplicaInvariantViolationError';
	}
}

type TableReads<TRow extends { id: string }> = {
	get(id: TRow['id']): TRow | null;
	list(options?: {
		where?: Partial<TRow>;
		orderBy?: keyof TRow & string;
		desc?: boolean;
		limit?: number;
		offset?: number;
	}): TRow[];
	has(id: TRow['id']): boolean;
	count(): number;
};

type TableWrites<TRow extends { id: string }> = {
	/** Materialize a new row. The id must be a fresh, never-used identity. */
	create(row: TRow): void;
	patch(id: TRow['id'], cells: Partial<Omit<TRow, 'id'>>): TRow | null;
	/** Physically delete the row. A missing row is a local no-op. */
	remove(id: TRow['id']): void;
};

export type ApplicationTable<TRow extends { id: string }> = TableReads<TRow> &
	TableWrites<TRow> & {
		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>) => void,
		): () => void;
	};

export type ApplicationTables<TTables extends TableDefinitions> = {
	[K in keyof TTables]: ApplicationTable<RowFor<TTables[K]>>;
};

export type ApplicationTransaction<TTables extends TableDefinitions> = {
	tables: ApplicationTables<TTables>;
};

export type CommittedApplicationChanges = {
	tables: ReadonlyMap<string, ReadonlySet<string>>;
};

type Changes = {
	tables: Map<string, Set<string>>;
};

type ColumnCodec = {
	storage: 'TEXT' | 'INTEGER' | 'REAL';
	isNullable: boolean;
	encode(value: unknown): SqliteValue;
	decode(value: SqliteValue): unknown;
};

const QUARANTINE_TABLE = '__epicenter_quarantine';
const META_TABLE = '__epicenter_meta';
const INTERNAL_PREFIX = '__epicenter_';

/** Open typed application tables over an already-open SQLite database. */
export function createApplicationDatabase<TTables extends TableDefinitions>(
	definition: WorkspaceDefinition<TTables>,
	sqlite: RecordSyncSqlite,
	{
		kind,
		coordinator = {
			commit<TResult>(
				_context: ApplicationMutationContext,
				apply: () => TResult,
			): TResult {
				return sqlite.transaction(apply);
			},
		},
		onObserverError,
	}: ApplicationDatabaseOptions,
) {
	assertWorkspaceDefinition(definition);
	const tableObservers = new Map<
		string,
		Set<(changedIds: ReadonlySet<string>) => void>
	>();
	const commitObservers = new Set<
		(changes: CommittedApplicationChanges) => void
	>();
	let activeChanges: Changes | undefined;
	let activeOperations: Operation[] | undefined;

	initializeDatabase(sqlite, definition, kind);

	function publish(changes: Changes): void {
		function notify(run: () => void): void {
			try {
				run();
			} catch (cause) {
				try {
					onObserverError(cause);
				} catch {
					// The injected sink is explicitly non-throwing. A broken sink must not
					// turn an already-committed write into an apparent transaction failure.
				}
			}
		}
		if (changes.tables.size > 0) {
			const committed: CommittedApplicationChanges = {
				tables: new Map(
					[...changes.tables].map(([table, ids]) => [table, new Set(ids)]),
				),
			};
			for (const observer of [...commitObservers]) {
				notify(() => observer(committed));
			}
		}
		for (const [tableName, changedIds] of changes.tables) {
			if (changedIds.size === 0) continue;
			for (const observer of [...(tableObservers.get(tableName) ?? [])]) {
				notify(() => observer(changedIds));
			}
		}
	}

	function mutate<TResult>(run: (changes: Changes) => TResult): TResult {
		if (activeChanges) return run(activeChanges);

		const changes: Changes = { tables: new Map() };
		const operations: Operation[] = [];
		const result = coordinator.commit({ operations }, () => {
			activeChanges = changes;
			activeOperations = operations;
			try {
				const value = run(changes);
				if (operations.length > 0 && !isAdmissibleOperationSet(operations)) {
					throw new Error(
						'Application mutation exceeds record admission limits',
					);
				}
				return value;
			} finally {
				activeChanges = undefined;
				activeOperations = undefined;
			}
		});
		publish(changes);
		return result;
	}

	function record(operation: Operation): void {
		if (!activeOperations) {
			throw new Error('Logical operation recorded outside a mutation');
		}
		activeOperations.push(operation);
	}

	const tables = Object.fromEntries(
		Object.entries(definition.tables).map(([tableName, tableDefinition]) => [
			tableName,
			createApplicationTable({
				sqlite,
				tableName,
				definition: tableDefinition,
				mutate,
				record,
				observe(callback) {
					let observers = tableObservers.get(tableName);
					if (!observers) {
						observers = new Set();
						tableObservers.set(tableName, observers);
					}
					observers.add(callback);
					return () => {
						observers?.delete(callback);
						if (observers?.size === 0) tableObservers.delete(tableName);
					};
				},
			}),
		]),
	) as ApplicationTables<TTables>;

	return {
		definition,
		identity: {
			kind,
			workspaceId: definition.workspaceId,
			recordsDescriptor: definition.recordsDescriptor,
			recordsSchemaHash: definition.recordsSchemaHash,
		},
		kind,
		tables,
		/** Run one conservative, read-only statement against the live app tables. */
		sql(query: string, parameters: readonly SqliteValue[] = []): SqliteRow[] {
			assertSelectStatement(query);
			return sqlite.transaction(() => {
				sqlite.run('PRAGMA query_only = ON');
				try {
					return sqlite.all<SqliteRow>(query, parameters);
				} finally {
					sqlite.run('PRAGMA query_only = OFF');
				}
			});
		},
		/** Group every enclosed table write into one SQLite transaction. */
		transact<TResult>(
			run: (tx: ApplicationTransaction<TTables>) => TResult,
		): TResult {
			if (activeChanges) {
				throw new Error('Nested application transactions are not supported');
			}
			return mutate(() => run({ tables }));
		},
		/** Observe one combined table change set after each successful commit. */
		observe(callback: (changes: CommittedApplicationChanges) => void) {
			commitObservers.add(callback);
			return () => commitObservers.delete(callback);
		},
		/** Read logical application state: live typed and quarantined rows. */
		readLogicalSnapshot(): ApplicationLogicalSnapshot {
			return readLogicalSnapshot(sqlite, definition, tables);
		},
		/**
		 * Run one replica-owned projection transition and publish only after commit.
		 * The caller may update cursor and outbox tables through the same SQLite
		 * connection inside `run`; application callers never receive this surface.
		 */
		applyReplicaTransaction<TResult>(
			run: (projection: ReplicaProjectionTransaction) => TResult,
		): TResult {
			if (activeChanges) {
				throw new Error(
					'Replica projection cannot run inside an application transaction',
				);
			}
			const changes: Changes = { tables: new Map() };
			const result = sqlite.transaction(() =>
				run({
					apply(operations, firstSeenServerSequence) {
						for (const operation of operations) {
							applyLogicalOperation({
								sqlite,
								definition,
								operation,
								firstSeenServerSequence,
								changes,
							});
						}
					},
					retract(rows) {
						retractProjectionRows(sqlite, definition, rows, changes);
					},
					replace(rows, snapshotSequence) {
						replaceLogicalRows({
							sqlite,
							definition,
							rows,
							snapshotSequence,
							changes,
						});
					},
				}),
			);
			publish(changes);
			return result;
		},
	};
}

export type ApplicationDatabase<TTables extends TableDefinitions> = ReturnType<
	typeof createApplicationDatabase<TTables>
>;

function createApplicationTable<TDefinition extends TableDefinition>({
	sqlite,
	tableName,
	definition,
	mutate,
	record,
	observe,
}: {
	sqlite: RecordSyncSqlite;
	tableName: string;
	definition: TDefinition;
	mutate: <TResult>(run: (changes: Changes) => TResult) => TResult;
	record: (operation: Operation) => void;
	observe: (callback: (changedIds: ReadonlySet<string>) => void) => () => void;
}): ApplicationTable<RowFor<TDefinition>> {
	type TRow = RowFor<TDefinition>;
	const columns = definition.columns as Record<string, TSchema>;
	const compiledColumns = definition.compiledColumns as Record<
		string,
		CompiledColumn
	>;
	const columnNames = Object.keys(columns);
	const codecs = Object.fromEntries(
		Object.entries(compiledColumns).map(([name, column]) => [
			name,
			createColumnCodec(column),
		]),
	) as Record<string, ColumnCodec>;
	const quotedTable = quoteIdentifier(tableName);
	function codecFor(column: string): ColumnCodec {
		const codec = codecs[column];
		if (!codec) throw new Error(`Unknown column '${tableName}.${column}'`);
		return codec;
	}

	function mark(changes: Changes, id: string): void {
		let ids = changes.tables.get(tableName);
		if (!ids) {
			ids = new Set();
			changes.tables.set(tableName, ids);
		}
		ids.add(id);
	}

	function get(id: TRow['id']): TRow | null {
		const rows = sqlite.all<SqliteRow>(
			`SELECT ${columnNames.map(quoteIdentifier).join(', ')} FROM ${quotedTable} WHERE "id" = ?`,
			[id],
		);
		const row = rows[0];
		return row ? decodeRow<TRow>(row, columns, codecs) : null;
	}

	function list(
		options: {
			where?: Partial<TRow>;
			orderBy?: keyof TRow & string;
			desc?: boolean;
			limit?: number;
			offset?: number;
		} = {},
	): TRow[] {
		const clauses: string[] = [];
		const parameters: SqliteValue[] = [];
		for (const [column, value] of Object.entries(options.where ?? {})) {
			const codec = codecs[column];
			if (!codec) throw new Error(`Unknown column '${tableName}.${column}'`);
			if (value === null) clauses.push(`${quoteIdentifier(column)} IS NULL`);
			else {
				clauses.push(`${quoteIdentifier(column)} = ?`);
				parameters.push(codec.encode(value));
			}
		}

		let sql = `SELECT ${columnNames.map(quoteIdentifier).join(', ')} FROM ${quotedTable}`;
		if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
		if (options.orderBy !== undefined) {
			if (!codecs[options.orderBy]) {
				throw new Error(
					`Unknown order column '${tableName}.${options.orderBy}'`,
				);
			}
			sql += ` ORDER BY ${quoteIdentifier(options.orderBy)}${options.desc ? ' DESC' : ' ASC'}`;
		}
		if (options.limit !== undefined) {
			if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
				throw new Error('list() limit must be a non-negative safe integer');
			}
			sql += ' LIMIT ?';
			parameters.push(options.limit);
		}
		if (options.offset !== undefined) {
			if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
				throw new Error('list() offset must be a non-negative safe integer');
			}
			if (options.limit === undefined) sql += ' LIMIT -1';
			sql += ' OFFSET ?';
			parameters.push(options.offset);
		}

		return sqlite
			.all<SqliteRow>(sql, parameters)
			.map((row) => decodeRow<TRow>(row, columns, codecs));
	}

	return {
		get,
		list,
		has(id) {
			return (
				sqlite.all<SqliteRow>(
					`SELECT 1 AS "present" FROM ${quotedTable} WHERE "id" = ? LIMIT 1`,
					[id],
				).length > 0
			);
		},
		count() {
			return (
				sqlite.all<{ count: number }>(
					`SELECT count(*) AS "count" FROM ${quotedTable}`,
				)[0]?.count ?? 0
			);
		},
		create(row) {
			assertRow(tableName, definition, row);
			mutate((changes) => {
				if (
					sqlite.all<SqliteRow>(
						`SELECT 1 AS "present" FROM ${quotedTable} WHERE "id" = ? LIMIT 1`,
						[row.id],
					).length > 0 ||
					hasQuarantinedRow(sqlite, tableName, row.id)
				) {
					throw new Error(
						`Cannot create existing row '${tableName}.${row.id}'; row ids have one lifetime`,
					);
				}
				const placeholders = columnNames.map(() => '?').join(', ');
				sqlite.run(
					`INSERT INTO ${quotedTable} (${columnNames.map(quoteIdentifier).join(', ')}) VALUES (${placeholders})`,
					columnNames.map((column) => codecFor(column).encode(row[column])),
				);
				mark(changes, row.id);
				record({
					kind: 'createRow',
					table: tableName,
					rowId: row.id,
					// Null-valued nullable cells are implicit in a fresh row; the
					// wire carries only the meaningful initial cells.
					cells: Object.fromEntries(
						columnNames
							.filter((column) => column !== 'id' && row[column] !== null)
							.map((column) => [column, row[column]]),
					) as Cells,
				});
			});
		},
		patch(id, cells) {
			const entries = Object.entries(cells);
			if (entries.length === 0) return get(id);
			if (entries.some(([column]) => column === 'id')) {
				throw new Error('patch() cannot change id');
			}
			return mutate((changes) => {
				const current = get(id);
				if (!current) return null;
				const next = { ...current, ...cells };
				assertRow(tableName, definition, next);
				const assignments = entries.map(([column]) => {
					if (!codecs[column]) {
						throw new Error(`Unknown column '${tableName}.${column}'`);
					}
					return `${quoteIdentifier(column)} = ?`;
				});
				sqlite.run(
					`UPDATE ${quotedTable} SET ${assignments.join(', ')} WHERE "id" = ?`,
					[
						...entries.map(([column, value]) => codecFor(column).encode(value)),
						id,
					],
				);
				mark(changes, id);
				record({
					kind: 'updateRow',
					table: tableName,
					rowId: id,
					cells: Object.fromEntries(entries) as Cells,
				});
				return next;
			});
		},
		remove(id) {
			mutate((changes) => {
				const existed =
					sqlite.all<SqliteRow>(
						`SELECT 1 AS "present" FROM ${quotedTable} WHERE "id" = ? LIMIT 1`,
						[id],
					).length > 0 || hasQuarantinedRow(sqlite, tableName, id);
				if (!existed) return;
				sqlite.run(`DELETE FROM ${quotedTable} WHERE "id" = ?`, [id]);
				sqlite.run(
					`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
					[tableName, id],
				);
				mark(changes, id);
				record({ kind: 'deleteRow', table: tableName, rowId: id });
			});
		},
		observe(callback) {
			return observe(callback as (ids: ReadonlySet<string>) => void);
		},
	};
}

function assertSelectStatement(query: string): void {
	const trimmed = query.trim();
	if (!/^SELECT(?:\s|$)/i.test(trimmed)) {
		throw new Error('sql() accepts only SELECT statements');
	}
	// SQLite statement separation requires a semicolon. Rejecting every semicolon
	// is intentionally conservative: query_only below owns write prevention, while
	// this check ensures adapters cannot silently ignore or execute a trailing
	// statement.
	if (trimmed.includes(';')) {
		throw new Error('sql() accepts exactly one statement');
	}
}

function initializeDatabase(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	kind: 'standalone' | 'replica',
): void {
	sqlite.transaction(() => {
		const identity = readDatabaseIdentity(sqlite, definition, kind);
		if (identity.status === 'invalid') throw new Error(identity.reason);
		if (identity.status === 'initialized') return;
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(META_TABLE)} ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL)`,
		);
		sqlite.run(
			`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(QUARANTINE_TABLE)} ("table_name" TEXT NOT NULL, "row_id" TEXT NOT NULL, "cells_json" TEXT NOT NULL, "first_seen_sequence" INTEGER NOT NULL, "reason" TEXT NOT NULL, PRIMARY KEY ("table_name", "row_id"))`,
		);

		for (const [tableName, tableDefinition] of Object.entries(
			definition.tables,
		)) {
			if (tableName.startsWith(INTERNAL_PREFIX)) {
				throw new Error(
					`Table name '${tableName}' uses the reserved internal prefix`,
				);
			}
			const columns = tableDefinition.columns as Record<string, TSchema>;
			const compiledColumns = tableDefinition.compiledColumns as Record<
				string,
				CompiledColumn
			>;
			if (!columns.id) throw new Error(`Table '${tableName}' must declare id`);
			const columnDdl = Object.entries(compiledColumns).map(
				([name, column]) => {
					const codec = createColumnCodec(column);
					if (name === 'id') {
						if (codec.storage !== 'TEXT' || codec.isNullable) {
							throw new Error(
								`Table '${tableName}' id must be a non-null TEXT field`,
							);
						}
						return `${quoteIdentifier(name)} TEXT PRIMARY KEY NOT NULL`;
					}
					return `${quoteIdentifier(name)} ${codec.storage}${codec.isNullable ? '' : ' NOT NULL'}`;
				},
			);
			sqlite.run(
				`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columnDdl.join(', ')})`,
			);
		}

		sqlite.run(
			`INSERT INTO ${quoteIdentifier(META_TABLE)} ("key", "value") VALUES ('storage_revision', ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
			[String(APPLICATION_STORAGE_REVISION)],
		);
		writeMeta(sqlite, 'workspace_id', definition.workspaceId);
		writeMeta(sqlite, 'records_descriptor', definition.recordsDescriptor);
		writeMeta(sqlite, 'schema_hash', definition.recordsSchemaHash);
		writeMeta(sqlite, 'database_kind', kind);
	});
}

/**
 * Runtime-owned physical revision of the application-table layout. App
 * definitions do not author representation migrations (ADR-0130). This
 * greenfield runtime accepts only the exact revision it creates; it does not
 * promise an in-place storage upgrade path.
 */
const APPLICATION_STORAGE_REVISION = 1;

/** Inspect one already-existing database without creating or changing storage. */
export function inspectApplicationDatabaseIdentity(
	definition: WorkspaceDefinition,
	sqlite: RecordSyncSqlite,
	kind: 'standalone' | 'replica',
): ApplicationDatabaseIdentityInspection {
	assertWorkspaceDefinition(definition);
	const identity = readDatabaseIdentity(sqlite, definition, kind);
	return identity.status === 'fresh'
		? invalidDatabaseIdentity(
				'Workspace database has no complete root identity',
			)
		: identity;
}

type DatabaseIdentityState =
	| { readonly status: 'fresh' }
	| ApplicationDatabaseIdentityInspection;

function readDatabaseIdentity(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	kind: 'standalone' | 'replica',
): DatabaseIdentityState {
	const userTables = sqlite.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
	);
	const hasMeta = userTables.some(({ name }) => name === META_TABLE);
	if (!hasMeta) {
		if (userTables.length > 0) {
			return invalidDatabaseIdentity(
				'Workspace database has no identity metadata; refusing to adopt a non-empty database',
			);
		}
		return Object.freeze({ status: 'fresh' });
	}

	const storedRevisionText = readMeta(sqlite, 'storage_revision');
	const storedWorkspaceId = readMeta(sqlite, 'workspace_id');
	const storedRecordsDescriptor = readMeta(sqlite, 'records_descriptor');
	const storedRecordsSchemaHash = readMeta(sqlite, 'schema_hash');
	const storedKind = readMeta(sqlite, 'database_kind');
	if (
		storedRevisionText === undefined ||
		storedWorkspaceId === undefined ||
		storedRecordsDescriptor === undefined ||
		storedRecordsSchemaHash === undefined ||
		storedKind === undefined
	) {
		return invalidDatabaseIdentity(
			'Workspace database metadata is incomplete; refusing to adopt an unidentified database',
		);
	}
	const storedRevision = Number(storedRevisionText);
	if (!Number.isSafeInteger(storedRevision) || storedRevision < 1) {
		return invalidDatabaseIdentity(
			`Invalid stored workspace revision '${storedRevisionText}'`,
		);
	}
	if (storedWorkspaceId !== definition.workspaceId) {
		return invalidDatabaseIdentity(
			`Workspace database belongs to '${storedWorkspaceId}', not '${definition.workspaceId}'`,
		);
	}
	if (storedKind !== kind) {
		return invalidDatabaseIdentity(
			`Workspace database is '${storedKind}', not '${kind}'; refusing the wrong lifecycle door`,
		);
	}
	if (storedRevision !== APPLICATION_STORAGE_REVISION) {
		return invalidDatabaseIdentity(
			`Workspace database revision ${storedRevision} does not match this runtime's revision ${APPLICATION_STORAGE_REVISION}`,
		);
	}
	if (storedRecordsSchemaHash !== definition.recordsSchemaHash) {
		return invalidDatabaseIdentity(
			'Workspace schema hash does not match the database; refusing typed access',
		);
	}
	if (storedRecordsDescriptor !== definition.recordsDescriptor) {
		return invalidDatabaseIdentity(
			'Workspace records descriptor does not match the database; refusing typed access',
		);
	}
	return Object.freeze({ status: 'initialized' });
}

function invalidDatabaseIdentity(
	reason: string,
): ApplicationDatabaseIdentityInspection {
	return Object.freeze({ status: 'invalid', reason });
}

function readLogicalSnapshot<TTables extends TableDefinitions>(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition<TTables>,
	tables: ApplicationTables<TTables>,
): ApplicationLogicalSnapshot {
	type SnapshotTable = {
		list(options: {
			orderBy: 'id';
		}): ({ id: string } & Record<string, unknown>)[];
	};
	const rows: SnapshotRow[] = [];
	for (const tableName of Object.keys(definition.tables).toSorted()) {
		const table = (tables as unknown as Record<string, SnapshotTable>)[
			tableName
		];
		if (!table) throw new Error(`Snapshot table '${tableName}' is unavailable`);
		for (const row of table.list({ orderBy: 'id' })) {
			const { id: rowId, ...storedCells } = row;
			const cells = Object.fromEntries(
				Object.entries(storedCells).filter(([, value]) => value !== null),
			);
			rows.push({
				table: tableName,
				rowId,
				cells: cells as Cells,
			});
		}
	}

	rows.push(
		...sqlite
			.all<{
				table: string;
				rowId: string;
				cellsJson: string;
			}>(
				`SELECT "table_name" AS "table", "row_id" AS "rowId", "cells_json" AS "cellsJson" FROM ${quoteIdentifier(QUARANTINE_TABLE)} ORDER BY "table_name", "row_id"`,
			)
			.map(({ table, rowId, cellsJson }) => ({
				table,
				rowId,
				cells: JSON.parse(cellsJson) as Cells,
			})),
	);
	rows.sort(
		(left, right) =>
			compareCodeUnits(left.table, right.table) ||
			compareCodeUnits(left.rowId, right.rowId),
	);
	return { rows };
}

function applyLogicalOperation({
	sqlite,
	definition,
	operation,
	firstSeenServerSequence,
	changes,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	operation: Operation;
	firstSeenServerSequence: number;
	changes: Changes;
}): void {
	const current = readProjectionCells(
		sqlite,
		definition,
		operation.table,
		operation.rowId,
	);
	const result = foldRow(current, operation);
	switch (result.kind) {
		case 'created':
		case 'updated':
			materializeProjectionRow({
				sqlite,
				definition,
				table: operation.table,
				rowId: operation.rowId,
				cells: result.cells,
				firstSeenServerSequence,
			});
			break;
		case 'deleted':
			deleteProjectionRow(sqlite, definition, operation.table, operation.rowId);
			break;
		case 'noop':
			return;
		case 'create-conflict':
			throw new ReplicaInvariantViolationError(
				`Accepted createRow named live row '${operation.table}.${operation.rowId}'; the replica must rebootstrap`,
			);
	}
	markProjectionChange(changes, definition, operation.table, operation.rowId);
}

function replaceLogicalRows({
	sqlite,
	definition,
	rows,
	snapshotSequence,
	changes,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	rows: readonly SnapshotRow[];
	snapshotSequence: number;
	changes: Changes;
}): void {
	markEveryProjectionRow(sqlite, definition, changes);
	const identities = new Set<string>();
	for (const row of rows) {
		const identity = JSON.stringify([row.table, row.rowId]);
		if (identities.has(identity)) {
			throw new Error(
				`Logical snapshot repeats row '${row.table}.${row.rowId}'`,
			);
		}
		identities.add(identity);
	}

	for (const table of Object.keys(definition.tables)) {
		sqlite.run(`DELETE FROM ${quoteIdentifier(table)}`);
	}
	sqlite.run(`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)}`);

	for (const row of rows) {
		materializeProjectionRow({
			sqlite,
			definition,
			table: row.table,
			rowId: row.rowId,
			cells: row.cells,
			firstSeenServerSequence: snapshotSequence,
		});
		markProjectionChange(changes, definition, row.table, row.rowId);
	}
}

function retractProjectionRows(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	rows: readonly { table: string; rowId: string }[],
	changes: Changes,
): void {
	for (const { table, rowId } of rows) {
		deleteProjectionRow(sqlite, definition, table, rowId);
		markProjectionChange(changes, definition, table, rowId);
	}
}

function readProjectionCells(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): Cells | undefined {
	const quarantined = sqlite.all<{ cellsJson: string }>(
		`SELECT "cells_json" AS "cellsJson" FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
		[table, rowId],
	)[0];
	if (quarantined) return JSON.parse(quarantined.cellsJson) as Cells;
	const tableDefinition = definition.tables[table];
	if (!tableDefinition) return undefined;
	const columns = tableDefinition.columns as Record<string, TSchema>;
	const codecs = codecsFor(tableDefinition);
	const stored = sqlite.all<SqliteRow>(
		`SELECT ${Object.keys(columns).map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table)} WHERE "id" = ?`,
		[rowId],
	)[0];
	if (!stored) return undefined;
	const { id: _id, ...storedCells } = decodeRow<
		{ id: string } & Record<string, unknown>
	>(stored, columns, codecs);
	const cells = Object.fromEntries(
		Object.entries(storedCells).filter(([, value]) => value !== null),
	);
	return cells as Cells;
}

function materializeProjectionRow({
	sqlite,
	definition,
	table,
	rowId,
	cells,
	firstSeenServerSequence,
}: {
	sqlite: RecordSyncSqlite;
	definition: WorkspaceDefinition;
	table: string;
	rowId: string;
	cells: Cells;
	firstSeenServerSequence: number;
}): void {
	deleteProjectionRow(sqlite, definition, table, rowId);

	const tableDefinition = definition.tables[table];
	if (tableDefinition) {
		const candidate: Record<string, unknown> = { id: rowId, ...cells };
		for (const [column, compiled] of Object.entries(
			tableDefinition.compiledColumns,
		)) {
			if (
				column !== 'id' &&
				compiled.isNullable &&
				!Object.hasOwn(candidate, column)
			) {
				candidate[column] = null;
			}
		}
		if (rowConforms(tableDefinition, candidate)) {
			writeTypedProjectionRow(sqlite, table, tableDefinition, candidate);
			return;
		}
	}

	sqlite.run(
		`INSERT INTO ${quoteIdentifier(QUARANTINE_TABLE)} ("table_name", "row_id", "cells_json", "first_seen_sequence", "reason") VALUES (?, ?, ?, ?, ?) ON CONFLICT ("table_name", "row_id") DO UPDATE SET "cells_json" = excluded."cells_json", "reason" = excluded."reason"`,
		[
			table,
			rowId,
			JSON.stringify(cells),
			firstSeenServerSequence,
			'row does not conform to this workspace schema',
		],
	);
}

function deleteProjectionRow(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): void {
	if (definition.tables[table]) {
		sqlite.run(`DELETE FROM ${quoteIdentifier(table)} WHERE "id" = ?`, [rowId]);
	}
	sqlite.run(
		`DELETE FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ?`,
		[table, rowId],
	);
}

function rowConforms(
	definition: TableDefinition,
	row: Record<string, unknown>,
): boolean {
	const columns = definition.compiledColumns as Record<string, CompiledColumn>;
	const expected = Object.keys(columns);
	return (
		Object.keys(row).length === expected.length &&
		expected.every(
			(column) =>
				Object.hasOwn(row, column) && columns[column]?.check(row[column]),
		)
	);
}

function codecsFor(definition: TableDefinition): Record<string, ColumnCodec> {
	return Object.fromEntries(
		Object.entries(
			definition.compiledColumns as Record<string, CompiledColumn>,
		).map(([name, column]) => [name, createColumnCodec(column)]),
	);
}

function writeTypedProjectionRow(
	sqlite: RecordSyncSqlite,
	table: string,
	definition: TableDefinition,
	row: Record<string, unknown>,
): void {
	const columns = Object.keys(definition.columns);
	const codecs = codecsFor(definition);
	sqlite.run(
		`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
		columns.map((column) =>
			codecForStoredColumn(codecs, column).encode(row[column]),
		),
	);
}

function markProjectionChange(
	changes: Changes,
	definition: WorkspaceDefinition,
	table: string,
	rowId: string,
): void {
	if (!definition.tables[table]) return;
	let ids = changes.tables.get(table);
	if (!ids) {
		ids = new Set();
		changes.tables.set(table, ids);
	}
	ids.add(rowId);
}

function markEveryProjectionRow(
	sqlite: RecordSyncSqlite,
	definition: WorkspaceDefinition,
	changes: Changes,
): void {
	for (const table of Object.keys(definition.tables)) {
		for (const { id } of sqlite.all<{ id: string }>(
			`SELECT "id" FROM ${quoteIdentifier(table)}`,
		)) {
			markProjectionChange(changes, definition, table, id);
		}
	}
	for (const { table, rowId } of sqlite.all<{
		table: string;
		rowId: string;
	}>(
		`SELECT "table_name" AS "table", "row_id" AS "rowId" FROM ${quoteIdentifier(QUARANTINE_TABLE)}`,
	)) {
		markProjectionChange(changes, definition, table, rowId);
	}
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function readMeta(sqlite: RecordSyncSqlite, key: string): string | undefined {
	return sqlite.all<{ value: string }>(
		`SELECT "value" FROM ${quoteIdentifier(META_TABLE)} WHERE "key" = ?`,
		[key],
	)[0]?.value;
}

function writeMeta(sqlite: RecordSyncSqlite, key: string, value: string): void {
	sqlite.run(
		`INSERT INTO ${quoteIdentifier(META_TABLE)} ("key", "value") VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET "value" = excluded."value"`,
		[key, value],
	);
}

function createColumnCodec(column: CompiledColumn): ColumnCodec {
	const { kind } = column;
	return {
		storage: column.storage,
		isNullable: column.isNullable,
		encode(value) {
			assertColumn(column, value, 'Column value');
			if (value === null) return null;
			switch (kind) {
				case 'boolean':
					return value ? 1 : 0;
				case 'json':
				case 'multiSelect':
				case 'tags':
					return JSON.stringify(value);
				default:
					return value as SqliteValue;
			}
		},
		decode(value) {
			if (value === null) return null;
			let decoded: unknown;
			switch (kind) {
				case 'boolean':
					if (value !== 0 && value !== 1) {
						throw new Error(
							`Stored column '${column.name}' is not a SQLite boolean`,
						);
					}
					decoded = value === 1;
					break;
				case 'json':
				case 'multiSelect':
				case 'tags':
					decoded = JSON.parse(String(value));
					break;
				default:
					decoded = value;
			}
			assertColumn(column, decoded, 'Stored column value');
			return decoded;
		},
	};
}

function decodeRow<TRow extends { id: string }>(
	stored: SqliteRow,
	columns: Record<string, TSchema>,
	codecs: Record<string, ColumnCodec>,
): TRow {
	const row = Object.fromEntries(
		Object.keys(columns).map((column) => [
			column,
			codecForStoredColumn(codecs, column).decode(stored[column] ?? null),
		]),
	);
	return row as TRow;
}

function codecForStoredColumn(
	codecs: Record<string, ColumnCodec>,
	column: string,
): ColumnCodec {
	const codec = codecs[column];
	if (!codec) throw new Error(`Stored row has unknown column '${column}'`);
	return codec;
}

function assertRow<TDefinition extends TableDefinition>(
	tableName: string,
	definition: TDefinition,
	row: unknown,
): asserts row is RowFor<TDefinition> {
	if (!isRecord(row)) throw new Error('Row must be a plain object');
	const expected = Object.keys(definition.compiledColumns);
	const actual = Object.keys(row);
	if (
		actual.length !== expected.length ||
		expected.some((column) => !Object.hasOwn(row, column))
	) {
		throw new Error('Row must contain exactly the declared columns');
	}
	for (const column of Object.values(definition.compiledColumns)) {
		assertColumn(column, row[column.name], `Row column '${column.name}'`);
	}
	const { id, ...cells } = row;
	if (typeof id !== 'string')
		throw new Error("Row column 'id' must be a string");
	if (
		!isAdmissibleSnapshotRow({
			table: tableName,
			rowId: id,
			cells: Object.fromEntries(
				Object.entries(cells).filter(([, value]) => value !== null),
			) as Cells,
		})
	) {
		throw new Error('Row exceeds record admission limits');
	}
}

function assertColumn(
	column: CompiledColumn,
	value: unknown,
	label: string,
): void {
	if (column.check(value)) return;
	throw new Error(`${label} failed schema validation`);
}

function hasQuarantinedRow(
	sqlite: RecordSyncSqlite,
	tableName: string,
	rowId: string,
): boolean {
	return (
		sqlite.all<SqliteRow>(
			`SELECT 1 AS "present" FROM ${quoteIdentifier(QUARANTINE_TABLE)} WHERE "table_name" = ? AND "row_id" = ? LIMIT 1`,
			[tableName, rowId],
		).length > 0
	);
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
