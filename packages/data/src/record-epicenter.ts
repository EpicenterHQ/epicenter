import { customAlphabet } from 'nanoid';
import type { TSchema } from 'typebox';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import type { RowDocument } from './documents.js';
import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type LensDefinition,
	type NonconformingRowError,
	type NonconformingValueError,
	parseLens,
	type RowFor,
	type TableDefinition,
	type ValueFor,
	type ValuesDefinition,
} from './lens.js';
import type { JsonValue, RecordAddress } from './protocol/v1/index.js';
import { createRecordDocumentRuntime } from './record-documents.js';
import type { ReplicaBlobStore, ReplicaStore } from './store/replica/index.js';

const mintRecordKey = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const ENTRIES_PAGE_SIZE = 100;

export type RecordTableScan<TDefinition extends TableDefinition> = {
	rows: RowFor<TDefinition>[];
	nonconforming: NonconformingRowError[];
};

export type RecordTableEntry<TDefinition extends TableDefinition> = Result<
	RowFor<TDefinition>,
	NonconformingRowError
>;

export type RecordBlobLens<TSource, TRead> = {
	put(recordId: string, source: TSource): Promise<string>;
	get(recordId: string): Promise<TRead | null>;
	inspect(
		recordId: string,
	): ReturnType<ReplicaBlobStore<TSource, TRead>['inspect']>;
};

export type RecordTableLens<
	TDefinition extends TableDefinition,
	TSource,
	TRead,
> = {
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	get(
		id: string,
	): Promise<Result<RowFor<TDefinition> | undefined, NonconformingRowError>>;
	update<const TChanges extends Record<string, unknown>>(
		id: string,
		patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
	): Promise<Result<RowFor<TDefinition> | undefined, NonconformingRowError>>;
	delete(id: string): Promise<boolean>;
	scan(): Promise<RecordTableScan<TDefinition>>;
	entries(): AsyncIterable<RecordTableEntry<TDefinition>>;
	subscribe(listener: (changedIds: string[]) => void): () => void;
	openDocument(recordId: string): Promise<RowDocument>;
	blob: RecordBlobLens<TSource, TRead>;
};

export type RecordValueLens<TSchemaValue extends TSchema> = {
	get(): Promise<
		Result<ValueFor<TSchemaValue> | undefined, NonconformingValueError>
	>;
	set(value: ValueFor<TSchemaValue>): Promise<void>;
	unset(): Promise<void>;
	subscribe(listener: () => void): () => void;
};

type BoundCollection<TDefinition, TSource, TRead> =
	TDefinition extends TableDefinition
		? RecordTableLens<TDefinition, TSource, TRead>
		: TDefinition extends ValuesDefinition<infer TValues>
			? { [K in keyof TValues]: RecordValueLens<TValues[K]> }
			: never;

export type BoundLens<TLens extends LensDefinition, TSource, TRead> = {
	[K in keyof TLens['collections']]: BoundCollection<
		TLens['collections'][K],
		TSource,
		TRead
	>;
};

export type BoundLenses<
	TLenses extends Record<string, LensDefinition>,
	TSource,
	TRead,
> = {
	[K in keyof TLenses]: BoundLens<TLenses[K], TSource, TRead>;
};

export type CreateRecordEpicenterOptions<TSource, TRead> = {
	replica: ReplicaStore;
	blobs: ReplicaBlobStore<TSource, TRead>;
	dispose?: () => void | Promise<void>;
	log?: Logger;
};

function collectionKey(namespace: string, collection: string): string {
	return JSON.stringify([namespace, collection]);
}

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

/** Bind pure JSON Lenses to one V1 record replica and blob owner. */
export function createRecordEpicenter<TSource, TRead>({
	replica,
	blobs,
	dispose = () => undefined,
	log = createLogger('data'),
}: CreateRecordEpicenterOptions<TSource, TRead>) {
	const documents = createRecordDocumentRuntime(replica);
	const tableListeners = new Map<string, Set<(ids: string[]) => void>>();
	const valueListeners = new Map<string, Set<() => void>>();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter is disposed');
	}

	function notifyTable(
		namespace: string,
		collection: string,
		ids: string[],
	): void {
		if (ids.length === 0) return;
		for (const listener of tableListeners.get(
			collectionKey(namespace, collection),
		) ?? []) {
			try {
				listener([...ids]);
			} catch (cause) {
				log.error(new Error('Data subscriber threw', { cause }));
			}
		}
	}

	const stopReplicaSubscription = replica.subscribe((addresses) => {
		const tables = new Map<
			string,
			{ namespace: string; collection: string; ids: string[] }
		>();
		for (const address of addresses) {
			if (replica.visible(address)?.state !== 'live') documents.revoke(address);
			const key = collectionKey(address.namespace, address.collection);
			const table = tables.get(key) ?? {
				namespace: address.namespace,
				collection: address.collection,
				ids: [],
			};
			if (!table.ids.includes(address.recordKey)) {
				table.ids.push(address.recordKey);
			}
			tables.set(key, table);
			for (const listener of valueListeners.get(addressKey(address)) ?? []) {
				try {
					listener();
				} catch (cause) {
					log.error(new Error('Data subscriber threw', { cause }));
				}
			}
		}
		for (const table of tables.values()) {
			notifyTable(table.namespace, table.collection, table.ids);
		}
	});

	function bind<const TLenses extends Record<string, LensDefinition>>(
		lenses: TLenses,
	): BoundLenses<TLenses, TSource, TRead> {
		requireOpen();
		const bound = Object.fromEntries(
			Object.entries(lenses).map(([property, authoredLens]) => {
				const parsed = parseLens(authoredLens);
				if (parsed.error !== null) throw parsed.error;
				return [property, bindLens(parsed.data)];
			}),
		);
		return Object.freeze(bound) as BoundLenses<TLenses, TSource, TRead>;
	}

	function bindLens(lens: LensDefinition): Record<string, unknown> {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(lens.collections).map(([collection, definition]) => [
					collection,
					definition.kind === 'table'
						? createTableLens(lens.namespace, collection, definition)
						: createValuesLens(lens.namespace, collection, definition),
				]),
			),
		);
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		collection: string,
		definition: TDefinition,
	): RecordTableLens<TDefinition, TSource, TRead> {
		const compiled = compileTableDefinition(definition, {
			namespace,
			collection,
		});
		const address = (recordKey: string): RecordAddress => ({
			namespace,
			collection,
			recordKey,
		});

		function read(id: string) {
			const stored = replica.visible(address(id));
			if (stored?.state !== 'live') return Ok(undefined);
			return compiled.project(id, stored.payload) as Result<
				RowFor<TDefinition>,
				NonconformingRowError
			>;
		}

		async function* entries(): AsyncIterable<RecordTableEntry<TDefinition>> {
			let after: string | undefined;
			do {
				const page = replica.visibleRecords(
					namespace,
					collection,
					after,
					ENTRIES_PAGE_SIZE,
				);
				for (const entry of page.entries) {
					if (entry.record.state !== 'live') continue;
					yield compiled.project(
						entry.address.recordKey,
						entry.record.payload,
					) as RecordTableEntry<TDefinition>;
				}
				after = page.nextAfter;
			} while (after !== undefined);
		}

		const blob: RecordBlobLens<TSource, TRead> = Object.freeze({
			async put(recordId, source) {
				requireOpen();
				const digest = await blobs.capture(address(recordId), source);
				notifyTable(namespace, collection, [recordId]);
				return digest;
			},
			get(recordId) {
				requireOpen();
				return blobs.read(address(recordId));
			},
			inspect(recordId) {
				requireOpen();
				return blobs.inspect(address(recordId));
			},
		});

		return Object.freeze({
			async create(input: Record<string, unknown>) {
				requireOpen();
				const payload = compiled.validateCreate(input);
				let id = mintRecordKey();
				for (
					let attempts = 0;
					replica.record(address(id)) !== null;
					attempts += 1
				) {
					if (attempts === 9)
						throw new Error('Could not mint a fresh record ID');
					id = mintRecordKey();
				}
				replica.localWrite({
					address: address(id),
					op: 'patch',
					set: payload,
					unset: [],
				});
				const projected = compiled.project(id, payload);
				if (projected.error !== null) throw projected.error;
				return projected.data as RowFor<TDefinition>;
			},
			async get(id: string) {
				requireOpen();
				return read(id);
			},
			async update(id: string, input: Record<string, unknown>) {
				requireOpen();
				const patch = compiled.normalizeUpdate(input);
				const before = read(id);
				if (before.error !== null || before.data === undefined) return before;
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return before;
				}
				replica.localWrite({ address: address(id), op: 'patch', ...patch });
				return read(id);
			},
			async delete(id: string) {
				requireOpen();
				if (replica.visible(address(id))?.state !== 'live') return false;
				replica.localWrite({ address: address(id), op: 'tombstone' });
				return true;
			},
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
			subscribe(listener: (changedIds: string[]) => void) {
				requireOpen();
				const key = collectionKey(namespace, collection);
				const listeners = tableListeners.get(key) ?? new Set();
				listeners.add(listener);
				tableListeners.set(key, listeners);
				return () => {
					listeners.delete(listener);
					if (listeners.size === 0) tableListeners.delete(key);
				};
			},
			openDocument(recordId: string) {
				requireOpen();
				return documents.open(address(recordId));
			},
			blob,
		}) as RecordTableLens<TDefinition, TSource, TRead>;
	}

	function createValuesLens(
		namespace: string,
		collection: string,
		definition: ValuesDefinition,
	): Record<string, RecordValueLens<TSchema>> {
		return Object.freeze(
			Object.fromEntries(
				Object.entries(definition.values).map(([recordKey, schema]) => {
					const compiled = compileValueDefinition(schema);
					const address = { namespace, collection, recordKey };
					const lens: RecordValueLens<TSchema> = Object.freeze({
						async get() {
							requireOpen();
							const stored = replica.visible(address);
							return stored?.state === 'live'
								? (compiled.project(stored.payload, address) as Result<
										ValueFor<TSchema>,
										NonconformingValueError
									>)
								: Ok(undefined);
						},
						async set(value: JsonValue) {
							requireOpen();
							replica.localWrite({
								address,
								op: 'replace',
								value: compiled.validate(value),
							});
						},
						async unset() {
							requireOpen();
							replica.localWrite({ address, op: 'unset' });
						},
						subscribe(listener: () => void) {
							requireOpen();
							const key = addressKey(address);
							const listeners = valueListeners.get(key) ?? new Set();
							listeners.add(listener);
							valueListeners.set(key, listeners);
							return () => {
								listeners.delete(listener);
								if (listeners.size === 0) valueListeners.delete(key);
							};
						},
					});
					return [recordKey, lens];
				}),
			),
		);
	}

	return Object.freeze({
		bind,
		get attachment() {
			return replica.attachment();
		},
		inspectRecord(address: RecordAddress) {
			requireOpen();
			return {
				lanes: replica.record(address),
				document: replica.inspectDocument(address),
				blob: blobs.inspect(address),
			};
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			stopReplicaSubscription();
			tableListeners.clear();
			valueListeners.clear();
			await documents[Symbol.asyncDispose]();
			await dispose();
		},
	});
}

export type RecordEpicenter<TSource, TRead> = ReturnType<
	typeof createRecordEpicenter<TSource, TRead>
>;
