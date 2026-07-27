import type { SqliteDatabase } from '@epicenter/sqlite';
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
	type Lens,
	type NonconformingRowError,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import {
	createDocumentRuntime,
	type PullDocument,
	type RowDocument,
} from './documents.js';
import {
	canonicalJson,
	type RowAddress,
	type ValueAddress,
} from './protocol/index.js';
import type { ReplicaV1, ReplicaV1Error } from './replica/v1-replica.js';
import { readVisibleRowPage } from './replica/v1-store.js';
import {
	createSyncSupervisorV1,
	type SyncSchedule,
	type SyncStatus,
	type SyncSupervisorSession,
} from './v1-sync-supervisor.js';

const mintRowId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);
const ENTRIES_PAGE_SIZE = 100;

type ReadError = DataReadError | ReplicaV1Error;

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

export type EpicenterSyncSession = SyncSupervisorSession & {
	deploymentId: string;
	principalId: string;
	/**
	 * The session's inbound HTTP carrier for explicit document pulls. Owned
	 * here rather than by the supervisor: the supervisor drives outbound
	 * drains, while pulls are application-driven through open handles. When
	 * absent, `document.pull()` reports that no attached session can pull.
	 */
	pullDocument?: PullDocument;
};

export type CreateEpicenterOptions = {
	replica: ReplicaV1;
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

/**
 * Internal map keys for the per-table and per-value listener registries.
 *
 * These never leave memory. One Epicenter can bind several Lenses, so a
 * listener registry keyed by local name alone would cross namespaces.
 */
function tableListenerKey(namespace: string, tableName: string): string {
	return canonicalJson({ namespace, tableName });
}

function valueListenerKey(namespace: string, valueName: string): string {
	return canonicalJson({ namespace, valueName });
}

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
	let activeSession: EpicenterSyncSession | undefined;
	const documents = createDocumentRuntime({
		database,
		replica,
		getPullTransport: () => {
			const transport = activeSession?.pullDocument;
			if (transport === undefined) return undefined;
			return async (request) => {
				const response = await transport(request);
				// A pull that finds the row dead converges through the scalar
				// row-liveness owner: the next exchange installs the deletion
				// and revokes the document.
				if (response.kind === 'not-live') void sync.requestFacts();
				return response;
			};
		},
	});
	const sync = createSyncSupervisorV1({
		replica,
		// Documents drain under the supervisor's one scheduler, retry policy,
		// and status surface: after the scalar exchange in a full cycle, and
		// alone in a coalesced document-only wake.
		drainDocuments: (session) => {
			const publish = session.publishDocument;
			if (publish === undefined) return Promise.resolve(Ok(undefined));
			return documents.drainPublications(async (request) => {
				const outcome = await publish(request);
				// A dead row converges through the scalar row-liveness owner; ask
				// for the exchange that installs the deletion promptly instead of
				// waiting for the periodic cycle.
				if (outcome === 'not-live') void sync.requestFacts();
				return outcome;
			});
		},
		...(syncIntervalMs === undefined
			? {}
			: { factsIntervalMs: syncIntervalMs }),
		...(scheduleSync === undefined ? {} : { schedule: scheduleSync }),
		log,
	});
	// A committed local document append wakes the coalesced document drain;
	// a later runtime resumes unfinished work from SQLite without waiting for
	// this signal.
	const stopPublicationWake = documents.subscribePublicationDirty(() => {
		sync.requestDocumentDrain();
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
		for (const address of changes) {
			if (address.kind === 'value') {
				changedValues.add(
					valueListenerKey(address.namespace, address.valueName),
				);
				continue;
			}
			const key = tableListenerKey(address.namespace, address.tableName);
			const ids = changedRows.get(key) ?? [];
			if (!ids.includes(address.rowId)) ids.push(address.rowId);
			changedRows.set(key, ids);
			const current = replica.readRow(address);
			if (current.error !== null) {
				// Liveness is unknowable this pass, so the open document keeps
				// running rather than being revoked on a guess. Reported because
				// this read is what a pull's `RowNotLive` is waiting on: left
				// silent, a document the authority already called dead would stay
				// open with nothing to say why.
				log.error(current.error);
			} else if (current.data === undefined) {
				documents.revoke(address);
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

	/**
	 * Bind one Lens over this runtime's replica.
	 *
	 * Each `tables` and `values` property name becomes the durable local key of
	 * the address it reads and writes, under the Lens's single declared
	 * namespace.
	 */
	function bind<
		const TTables extends TableDefinitions,
		const TValues extends ValueDefinitions,
	>(lens: Lens<TTables, TValues>): BoundData<TTables, TValues> {
		requireOpen();
		const boundTables = Object.fromEntries(
			Object.entries(lens.tables).map(([tableName, definition]) => [
				tableName,
				createTableLens(lens.namespace, tableName, definition),
			]),
		);
		const boundValues = Object.fromEntries(
			Object.entries(lens.values).map(([valueName, definition]) => [
				valueName,
				createValueLens(lens.namespace, valueName, definition),
			]),
		);
		return Object.freeze({
			tables: Object.freeze(boundTables),
			values: Object.freeze(boundValues),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		tableName: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const compiled = compileTableDefinition(definition);
		const listenerKey = tableListenerKey(namespace, tableName);
		const addressOf = (rowId: string): RowAddress => ({
			kind: 'row',
			namespace,
			tableName,
			rowId,
		});
		const readEntriesPage = async (after?: string) => {
			requireOpen();
			return readEntriesPageFromDatabase(
				namespace,
				tableName,
				compiled,
				after,
			) as TableEntriesPage<TDefinition>;
		};

		const tableLens = {
			async create(input: Record<string, unknown>) {
				requireOpen();
				const fields = compiled.validateCreate(input);
				const address = addressOf(mintRowId());
				const written = replica.write({
					address,
					presence: 'present',
					set: fields,
					unset: [],
				});
				if (written.error !== null) throw written.error;
				if (!written.data.applied) {
					// A freshly minted row id has no fact, so a refused patch means the
					// address is already occupied or already a tombstone. Either way the
					// mint collided, which a 24-character random id should never do.
					throw new Error(
						`Minted row '${namespace}/${tableName}/${address.rowId}' is already taken`,
					);
				}
				const projected = compiled.project(address, fields);
				if (projected.error !== null) throw projected.error;
				return projected.data;
			},
			async get(id: string) {
				requireOpen();
				const address = addressOf(id);
				const stored = replica.readRow(address);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(address, stored.data);
			},
			async update(id: string, input: Record<string, unknown>) {
				requireOpen();
				const patch = compiled.normalizeUpdate(input);
				const address = addressOf(id);
				const before = replica.readRow(address);
				if (before.error !== null) return before;
				if (before.data === undefined) return Ok(undefined);
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return compiled.project(address, before.data);
				}
				const written = replica.write({
					address,
					presence: 'present',
					set: patch.set,
					unset: patch.unset,
				});
				if (written.error !== null) return written;
				const current = replica.readRow(address);
				if (current.error !== null) return current;
				return current.data === undefined
					? Ok(undefined)
					: compiled.project(address, current.data);
			},
			async delete(id: string) {
				requireOpen();
				const address = addressOf(id);
				const before = replica.readRow(address);
				if (before.error !== null) throw before.error;
				if (before.data === undefined) return false;
				const written = replica.write({ address, presence: 'absent' });
				if (written.error !== null) throw written.error;
				return written.data.applied;
			},
			...createTableReadMethods(readEntriesPage),
			[readTableEntriesPage]: readEntriesPage,
			subscribe(listener: (changedIds: string[]) => void) {
				requireOpen();
				const listeners = tableListeners.get(listenerKey) ?? new Set();
				listeners.add(listener);
				tableListeners.set(listenerKey, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) tableListeners.delete(listenerKey);
				};
			},
			openDocument(rowId: string) {
				requireOpen();
				return documents.open(addressOf(rowId));
			},
		};
		return Object.freeze(tableLens) as InternalTableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const compiled = compileValueDefinition(definition);
		const listenerKey = valueListenerKey(namespace, valueName);
		const address: ValueAddress = { kind: 'value', namespace, valueName };
		return Object.freeze({
			async get() {
				requireOpen();
				const stored = replica.readValue(address);
				if (stored.error !== null) return stored;
				return stored.data === undefined
					? Ok(undefined)
					: compiled.project(address, stored.data);
			},
			async set(content: unknown) {
				requireOpen();
				const written = replica.write({
					address,
					presence: 'present',
					content: compiled.validate(content),
				});
				if (written.error !== null) throw written.error;
			},
			async unset() {
				requireOpen();
				const written = replica.write({ address, presence: 'absent' });
				if (written.error !== null) throw written.error;
			},
			subscribe(listener: () => void) {
				requireOpen();
				const listeners = valueListeners.get(listenerKey) ?? new Set();
				listeners.add(listener);
				valueListeners.set(listenerKey, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) valueListeners.delete(listenerKey);
				};
			},
		}) as ValueLens<TDefinition>;
	}

	async function attachSync(
		session: EpicenterSyncSession,
	): Promise<Result<void, ReplicaV1Error>> {
		requireOpen();
		const attached = replica.attach(session);
		if (attached.error !== null) return attached;
		activeSession = session;
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
			activeSession = undefined;
			stopReplicaSubscription();
			stopPublicationWake();
			sync.dispose();
			tableListeners.clear();
			valueListeners.clear();
			await documents[Symbol.asyncDispose]();
			await dispose();
		},
	});

	function readEntriesPageFromDatabase(
		namespace: string,
		tableName: string,
		compiled: ReturnType<typeof compileTableDefinition>,
		after?: string,
	): TableEntriesPage<TableDefinition> {
		const page = readVisibleRowPage(
			database,
			namespace,
			tableName,
			ENTRIES_PAGE_SIZE,
			after,
		);
		const hasNext = page.hasNext;
		const pageRows = page.rows;
		const entries: TableEntry<TableDefinition>[] = [];
		for (const row of pageRows) {
			const payload = row.fields;
			const address: RowAddress = {
				kind: 'row',
				namespace,
				tableName,
				rowId: row.rowId,
			};
			entries.push(
				compiled.project(address, payload) as TableEntry<TableDefinition>,
			);
		}
		const last = pageRows.at(-1);
		return {
			entries,
			...(hasNext && last !== undefined ? { nextAfter: last.rowId } : {}),
		};
	}
}

export type Epicenter = ReturnType<typeof createEpicenter>;
