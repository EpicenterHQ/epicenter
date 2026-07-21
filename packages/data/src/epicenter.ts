import type { SqliteDatabase, SqliteRow } from '@epicenter/sqlite';
import { customAlphabet } from 'nanoid';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type DataReadError,
	type NonconformingRowError,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import { createDocumentRuntime, type RowDocument } from './documents.js';
import type { JsonObject } from './protocol/index.js';
import type { Exchange, Replica, ReplicaError } from './replica/index.js';
import {
	createSyncSupervisor,
	type SyncCredentialProvider,
	type SyncSchedule,
	type SyncStatus,
} from './sync-supervisor.js';

const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const ENTRIES_PAGE_SIZE = 100;

type ReadError = DataReadError | ReplicaError;

export type TableScan<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
};

export type TableEntry<TDefinition extends TableDefinition> = Result<
	RowFor<TDefinition>,
	NonconformingRowError
>;

export type TableLens<TDefinition extends TableDefinition> = {
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	get(id: string): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, ReadError>>;
	delete(id: string): Promise<boolean>;
	/**
	 * Consume the classified traversal to completion and group its results.
	 *
	 * Use this when the traversal belongs in memory, such as a local UI cache.
	 * Use {@link entries} for repair, export, or another workflow that should
	 * keep memory bounded while it visits every live row. Like `entries()`, this
	 * observes live state rather than a point-in-time snapshot.
	 * Storage or transport failure rejects the returned Promise; only row Lens
	 * projection failures are grouped under `nonconforming`.
	 *
	 * @example
	 * ```ts
	 * const { rows, nonconforming } = await notes.scan();
	 * ```
	 */
	scan(): Promise<TableScan<TDefinition>>;
	/**
	 * Stream every live row in stable row-ID order without materializing the
	 * table. The runtime fetches bounded internal batches and keeps continuation
	 * state private; callers may stop iteration early.
	 *
	 * Entries are ordinary Results: conforming rows are `Ok`, while rows that the
	 * current Lens cannot interpret are `Err(NonconformingRow)` with raw JSON.
	 * The traversal observes live state rather than a database snapshot.
	 * Storage or transport failure throws from iteration instead of becoming an
	 * `Err` entry.
	 *
	 * @example
	 * ```ts
	 * for await (const entry of notes.entries()) {
	 *   if (entry.error !== null) report(entry.error);
	 * }
	 * ```
	 */
	entries(): AsyncIterable<TableEntry<TDefinition>>;
	subscribe(listener: (changedIds: string[]) => void): () => void;
	openDocument(rowId: string): Promise<RowDocument>;
};

export type ValueLens<TDefinition extends ValueDefinition> = {
	get(): Promise<Result<ValueFor<TDefinition> | undefined, ReadError>>;
	set(value: ValueFor<TDefinition>): Promise<void>;
	unset(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

export type BoundData<
	TTables extends TableDefinitions,
	TValues extends ValueDefinitions,
> = {
	tables: { [K in keyof TTables]: TableLens<TTables[K]> };
	values: { [K in keyof TValues]: ValueLens<TValues[K]> };
};

export type EpicenterSyncSession = {
	deploymentId: string;
	principalId: string;
	exchange: Exchange;
	credentials?: SyncCredentialProvider;
};

export type CreateEpicenterOptions = {
	replica: Replica;
	database: SqliteDatabase;
	dispose?: () => void | Promise<void>;
	log?: Logger;
	syncIntervalMs?: number;
	scheduleSync?: SyncSchedule;
};

const DataRuntimeError = defineErrors({
	SubscriberThrew: ({ cause }: { cause: unknown }) => ({
		message: `Data subscriber threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

type StoredStateRow = SqliteRow & {
	row_id: string;
	json_payload: string;
};

export type TableEntriesPage<TDefinition extends TableDefinition> = {
	entries: TableEntry<TDefinition>[];
	nextAfter?: string;
};

export const readTableEntriesPage: unique symbol = Symbol(
	'epicenter.readTableEntriesPage',
);

export type InternalTableLens<TDefinition extends TableDefinition> =
	TableLens<TDefinition> & {
		[readTableEntriesPage](
			after?: string,
		): Promise<TableEntriesPage<TDefinition>>;
	};

export function createTableReadMethods<TDefinition extends TableDefinition>(
	readPage: (after?: string) => Promise<TableEntriesPage<TDefinition>>,
): Pick<TableLens<TDefinition>, 'scan' | 'entries'> {
	async function* entries(): AsyncIterable<TableEntry<TDefinition>> {
		let after: string | undefined;
		do {
			const page = await readPage(after);
			yield* page.entries;
			after = page.nextAfter;
		} while (after !== undefined);
	}

	return {
		async scan() {
			const rows: RowFor<TDefinition>[] = [];
			const nonconforming: NonconformingRowError[] = [];
			for await (const entry of entries()) {
				if (entry.error === null) rows.push(entry.data);
				else nonconforming.push(entry.error);
			}
			return { rows, nonconforming };
		},
		entries,
	};
}

/** Create the adapter-agnostic Data runtime over one already-open replica. */
export function createEpicenter({
	replica,
	database,
	dispose = () => undefined,
	log = createLogger('data'),
	syncIntervalMs,
	scheduleSync,
}: CreateEpicenterOptions) {
	const documents = createDocumentRuntime({ database, replica });
	const sync = createSyncSupervisor({
		replica,
		...(syncIntervalMs === undefined
			? {}
			: { exchangeIntervalMs: syncIntervalMs }),
		...(scheduleSync === undefined ? {} : { schedule: scheduleSync }),
		log,
	});
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
	const valueListeners = new Map<string, Set<() => void>>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter is disposed');
	}

	const stopReplicaSubscription = replica.subscribe((changes) => {
		const changedRows = new Map<string, string[]>();
		const changedValues = new Set<string>();
		for (const change of changes) {
			if (change.kind === 'value') {
				changedValues.add(change.key);
				continue;
			}
			const ids = changedRows.get(change.key) ?? [];
			if (!ids.includes(change.rowId)) ids.push(change.rowId);
			changedRows.set(change.key, ids);
			const current = replica.readRow(change.key, change.rowId);
			if (current.error === null && current.data === undefined) {
				documents.revoke({ key: change.key, rowId: change.rowId });
			}
		}
		for (const [key, ids] of changedRows) {
			for (const listener of tableListeners.get(key) ?? []) {
				try {
					listener([...ids]);
				} catch (cause) {
					log.error(DataRuntimeError.SubscriberThrew({ cause }));
				}
			}
		}
		for (const key of changedValues) {
			for (const listener of valueListeners.get(key) ?? []) {
				try {
					listener();
				} catch (cause) {
					log.error(DataRuntimeError.SubscriberThrew({ cause }));
				}
			}
		}
	});

	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>({
		tables,
		values,
	}: {
		tables: TTables;
		values: TValues;
	}): BoundData<TTables, TValues> {
		requireOpen();
		assertDefinitionGroup(tables, values);
		const boundTables = Object.fromEntries(
			Object.entries(tables).map(([propertyName, definition]) => [
				propertyName,
				createTableLens(definition),
			]),
		);
		const boundValues = Object.fromEntries(
			Object.entries(values).map(([propertyName, definition]) => [
				propertyName,
				createValueLens(definition),
			]),
		);
		return Object.freeze({
			tables: Object.freeze(boundTables),
			values: Object.freeze(boundValues),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		definition: TDefinition,
	): TableLens<TDefinition> {
		const compiled = compileTableDefinition(definition);
		const readEntriesPage = async (after?: string) => {
			requireOpen();
			return readEntriesPageFromDatabase(definition, compiled, after);
		};

		const lens = {
			async create(input: Record<string, unknown>) {
				requireOpen();
				const fields = compiled.validateCreate(input);
				const id = mintRowId();
				const written = replica.write({
					kind: 'create',
					key: definition.key,
					rowId: id,
					fields,
				});
				if (written.error !== null) throw written.error;
				if (!written.data.applied) {
					throw new Error(
						`Minted row '${definition.key}.${id}' already exists`,
					);
				}
				const projected = compiled.project(id, fields);
				if (projected.error !== null) throw projected.error;
				return projected.data;
			},
			async get(id: string) {
				requireOpen();
				const stored = replica.readRow(definition.key, id);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(id, stored.data);
			},
			async update(id: string, input: Record<string, unknown>) {
				requireOpen();
				const patch = compiled.normalizeUpdate(input);
				const before = replica.readRow(definition.key, id);
				if (before.error !== null) return before;
				if (before.data === undefined) return Ok(undefined);
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return compiled.project(id, before.data);
				}
				const written = replica.write({
					kind: 'update',
					key: definition.key,
					rowId: id,
					fields: patch,
				});
				if (written.error !== null) return written;
				const current = replica.readRow(definition.key, id);
				if (current.error !== null) return current;
				return current.data === undefined
					? Ok(undefined)
					: compiled.project(id, current.data);
			},
			async delete(id: string) {
				requireOpen();
				const before = replica.readRow(definition.key, id);
				if (before.error !== null) throw before.error;
				if (before.data === undefined) return false;
				const written = replica.write({
					kind: 'delete',
					key: definition.key,
					rowId: id,
				});
				if (written.error !== null) throw written.error;
				return written.data.applied;
			},
			...createTableReadMethods(readEntriesPage),
			[readTableEntriesPage]: readEntriesPage,
			subscribe(listener: (changedIds: string[]) => void) {
				requireOpen();
				const listeners = tableListeners.get(definition.key) ?? new Set();
				listeners.add(listener);
				tableListeners.set(definition.key, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) tableListeners.delete(definition.key);
				};
			},
			openDocument(rowId: string) {
				requireOpen();
				return documents.open({ key: definition.key, rowId });
			},
		};
		return Object.freeze(lens) as InternalTableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const compiled = compileValueDefinition(definition);
		return Object.freeze({
			async get() {
				requireOpen();
				const stored = replica.readValue(definition.key);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(stored.data);
			},
			async set(value: unknown) {
				requireOpen();
				const written = replica.write({
					kind: 'set',
					key: definition.key,
					value: compiled.validate(value),
				});
				if (written.error !== null) throw written.error;
			},
			async unset() {
				requireOpen();
				const written = replica.write({
					kind: 'unset',
					key: definition.key,
				});
				if (written.error !== null) throw written.error;
			},
			subscribe(listener: () => void) {
				requireOpen();
				const listeners = valueListeners.get(definition.key) ?? new Set();
				listeners.add(listener);
				valueListeners.set(definition.key, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) valueListeners.delete(definition.key);
				};
			},
		}) as ValueLens<TDefinition>;
	}

	async function attachSync(
		session: EpicenterSyncSession,
	): Promise<Result<void, ReplicaError>> {
		requireOpen();
		const attached = replica.attach(session);
		if (attached.error !== null) return attached;
		return sync.attach(session);
	}

	return Object.freeze({
		bind,
		attachSync,
		get syncStatus(): SyncStatus {
			return sync.status;
		},
		subscribeSyncStatus(listener: (status: SyncStatus) => void) {
			requireOpen();
			return sync.subscribe(listener);
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			stopReplicaSubscription();
			sync.dispose();
			tableListeners.clear();
			valueListeners.clear();
			await documents[Symbol.asyncDispose]();
			await dispose();
		},
	});

	function readEntriesPageFromDatabase<TDefinition extends TableDefinition>(
		definition: TDefinition,
		compiled: ReturnType<typeof compileTableDefinition>,
		after?: string,
	): TableEntriesPage<TDefinition> {
		const where = [
			"address_kind = 'row'",
			'qualified_key = ?',
			"status = 'live'",
		];
		const parameters: (string | number)[] = [definition.key];
		if (after !== undefined) {
			where.push('row_id > ?');
			parameters.push(after);
		}
		parameters.push(ENTRIES_PAGE_SIZE + 1);
		const stored = database.all<StoredStateRow>(
			`SELECT row_id, json_payload
			 FROM state
			 WHERE ${where.join(' AND ')}
			 ORDER BY row_id ASC
			 LIMIT ?`,
			parameters,
		);
		const hasNext = stored.length > ENTRIES_PAGE_SIZE;
		const pageRows = hasNext ? stored.slice(0, ENTRIES_PAGE_SIZE) : stored;
		const entries: TableEntry<TDefinition>[] = [];
		for (const row of pageRows) {
			const payload = JSON.parse(row.json_payload) as JsonObject;
			const projected = compiled.project(row.row_id, payload);
			entries.push(projected as TableEntry<TDefinition>);
		}
		const last = pageRows.at(-1);
		return {
			entries,
			...(hasNext && last !== undefined ? { nextAfter: last.row_id } : {}),
		};
	}
}

export type Epicenter = ReturnType<typeof createEpicenter>;

function assertDefinitionGroup(
	tables: TableDefinitions,
	values: ValueDefinitions,
): void {
	const keys = new Map<string, string>();
	for (const [propertyName, definition] of Object.entries(tables)) {
		compileTableDefinition(definition);
		rememberDefinition(keys, definition.key, `tables.${propertyName}`);
	}
	for (const [propertyName, definition] of Object.entries(values)) {
		compileValueDefinition(definition);
		rememberDefinition(keys, definition.key, `values.${propertyName}`);
	}
}

function rememberDefinition(
	keys: Map<string, string>,
	key: string,
	propertyName: string,
): void {
	const existing = keys.get(key);
	if (existing !== undefined) {
		throw new Error(
			`Duplicate qualified key '${key}' is bound by '${existing}' and '${propertyName}'`,
		);
	}
	keys.set(key, propertyName);
}
