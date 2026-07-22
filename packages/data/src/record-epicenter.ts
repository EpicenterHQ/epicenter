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
import {
	createRecordSyncSupervisor,
	type RecordSyncSession,
	type RecordSyncStatus,
} from './record-sync-supervisor.js';
import type {
	BlobInspection,
	DocumentInspection,
	ReplicaAttachmentState,
	ReplicaBlobStore,
	ReplicaParkedWorkPage,
	ReplicaRecordLanes,
	ReplicaStore,
	ReplicaVisibleRecord,
	ReplicaVisibleRecordPage,
} from './store/replica/index.js';

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
	inspect(recordId: string): Promise<BlobInspection>;
};

export type RecordTableLens<
	TDefinition extends TableDefinition,
	TSource,
	TRead,
	TCreateSource = TSource,
> = {
	create(fields: CreateInputFor<TDefinition>): Promise<RowFor<TDefinition>>;
	createWithBlob(
		fields: CreateInputFor<TDefinition>,
		source: TCreateSource,
	): Promise<RowFor<TDefinition>>;
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

type BoundCollection<TDefinition, TSource, TRead, TCreateSource> =
	TDefinition extends TableDefinition
		? RecordTableLens<TDefinition, TSource, TRead, TCreateSource>
		: TDefinition extends ValuesDefinition<infer TValues>
			? { [K in keyof TValues]: RecordValueLens<TValues[K]> }
			: never;

export type BoundLens<
	TLens extends LensDefinition,
	TSource,
	TRead,
	TCreateSource = TSource,
> = {
	[K in keyof TLens['collections']]: BoundCollection<
		TLens['collections'][K],
		TSource,
		TRead,
		TCreateSource
	>;
};

export type BoundLenses<
	TLenses extends Record<string, LensDefinition>,
	TSource,
	TRead,
	TCreateSource = TSource,
> = {
	[K in keyof TLenses]: BoundLens<TLenses[K], TSource, TRead, TCreateSource>;
};

/**
 * Local capabilities used by Lens interpretation.
 *
 * This function-bearing facade is not an RPC or wire protocol. Browser and
 * desktop adapters must define separate cloneable operation protocols. A
 * local adapter may return a page-local RowDocument from openDocument.
 */
export type RecordLensAccess<TSource, TRead, TCreateSource = TSource> = {
	read(address: RecordAddress): Promise<ReplicaVisibleRecord | null>;
	readPage(
		namespace: string,
		collection: string,
		after?: string,
		limit?: number,
	): Promise<ReplicaVisibleRecordPage>;
	createRecord(
		namespace: string,
		collection: string,
		payload: Record<string, JsonValue>,
	): Promise<string>;
	createRecordWithBlob(
		namespace: string,
		collection: string,
		payload: Record<string, JsonValue>,
		source: TCreateSource,
	): Promise<string>;
	patchLive(
		address: RecordAddress,
		patch: { set: Record<string, JsonValue>; unset: string[] },
	): Promise<ReplicaVisibleRecord | null>;
	tombstoneLive(address: RecordAddress): Promise<boolean>;
	replace(address: RecordAddress, value: JsonValue): Promise<void>;
	unset(address: RecordAddress): Promise<void>;
	subscribeRecords(
		listener: (addresses: readonly RecordAddress[]) => void,
	): () => void;
	openDocument(address: RecordAddress): Promise<RowDocument>;
	putBlob(address: RecordAddress, source: TSource): Promise<string>;
	readBlob(address: RecordAddress): Promise<TRead | null>;
	inspectBlob(address: RecordAddress): Promise<BlobInspection>;
	subscribeBlobs(listener: (address: RecordAddress) => void): () => void;
};

export type CreateRecordLensRuntimeOptions = {
	log?: Logger;
};

export type CreateRecordEpicenterOptions<TSource, TRead> = {
	replica: ReplicaStore;
	blobs: ReplicaBlobStore<TSource, TRead>;
	dispose?: () => void | Promise<void>;
	log?: Logger;
};

export type RecordInspection = {
	lanes: ReplicaRecordLanes | null;
	document: DocumentInspection | null;
	blob: BlobInspection;
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

function attachmentsEqual(
	left: ReplicaAttachmentState,
	right: ReplicaAttachmentState,
): boolean {
	if (left.kind !== right.kind) return false;
	if (left.kind === 'unattached' && right.kind === 'unattached') {
		return left.requiresChoice === right.requiresChoice;
	}
	return (
		left.kind === 'attached' &&
		right.kind === 'attached' &&
		left.attachment.deploymentId === right.attachment.deploymentId &&
		left.attachment.principalId === right.attachment.principalId
	);
}

/** Create one owner's local Lens binder and subscription projection. */
export function createRecordLensRuntime<
	TSource,
	TRead,
	TCreateSource = TSource,
>(
	access: RecordLensAccess<TSource, TRead, TCreateSource>,
	{ log = createLogger('data') }: CreateRecordLensRuntimeOptions = {},
) {
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

	const stopRecordSubscription = access.subscribeRecords((addresses) => {
		const tables = new Map<
			string,
			{ namespace: string; collection: string; ids: string[] }
		>();
		for (const address of addresses) {
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
	const stopBlobSubscription = access.subscribeBlobs((address) => {
		notifyTable(address.namespace, address.collection, [address.recordKey]);
	});

	function bind<const TLenses extends Record<string, LensDefinition>>(
		lenses: TLenses,
	): BoundLenses<TLenses, TSource, TRead, TCreateSource> {
		requireOpen();
		const bound = Object.fromEntries(
			Object.entries(lenses).map(([property, authoredLens]) => {
				const parsed = parseLens(authoredLens);
				if (parsed.error !== null) throw parsed.error;
				return [property, bindLens(parsed.data)];
			}),
		);
		return Object.freeze(bound) as BoundLenses<
			TLenses,
			TSource,
			TRead,
			TCreateSource
		>;
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
	): RecordTableLens<TDefinition, TSource, TRead, TCreateSource> {
		const compiled = compileTableDefinition(definition, {
			namespace,
			collection,
		});
		const address = (recordKey: string): RecordAddress => ({
			namespace,
			collection,
			recordKey,
		});

		async function read(id: string) {
			const stored = await access.read(address(id));
			if (stored?.state !== 'live') return Ok(undefined);
			return compiled.project(id, stored.payload) as Result<
				RowFor<TDefinition>,
				NonconformingRowError
			>;
		}

		async function* entries(): AsyncIterable<RecordTableEntry<TDefinition>> {
			let after: string | undefined;
			do {
				const page = await access.readPage(
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
				return access.putBlob(address(recordId), source);
			},
			get(recordId) {
				requireOpen();
				return access.readBlob(address(recordId));
			},
			inspect(recordId) {
				requireOpen();
				return access.inspectBlob(address(recordId));
			},
		});

		return Object.freeze({
			async create(input: Record<string, unknown>) {
				requireOpen();
				const payload = compiled.validateCreate(input);
				const id = await access.createRecord(namespace, collection, payload);
				const projected = compiled.project(id, payload);
				if (projected.error !== null) throw projected.error;
				return projected.data as RowFor<TDefinition>;
			},
			async createWithBlob(
				input: Record<string, unknown>,
				source: TCreateSource,
			) {
				requireOpen();
				const payload = compiled.validateCreate(input);
				const id = await access.createRecordWithBlob(
					namespace,
					collection,
					payload,
					source,
				);
				// Native capture replay can return a record admitted before a WebView
				// reload. Read the owner's durable payload instead of projecting the
				// retried create input as though it had won again.
				const stored = await access.read(address(id));
				const projected = compiled.project(
					id,
					stored?.state === 'live' ? stored.payload : payload,
				);
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
				const before = await read(id);
				if (before.error !== null || before.data === undefined) return before;
				if (Object.keys(patch.set).length === 0 && patch.unset.length === 0) {
					return before;
				}
				const stored = await access.patchLive(address(id), patch);
				if (stored?.state !== 'live') return Ok(undefined);
				return compiled.project(id, stored.payload) as Result<
					RowFor<TDefinition>,
					NonconformingRowError
				>;
			},
			async delete(id: string) {
				requireOpen();
				return access.tombstoneLive(address(id));
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
				return access.openDocument(address(recordId));
			},
			blob,
		}) as RecordTableLens<TDefinition, TSource, TRead, TCreateSource>;
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
							const stored = await access.read(address);
							return stored?.state === 'live'
								? (compiled.project(stored.payload, address) as Result<
										ValueFor<TSchema>,
										NonconformingValueError
									>)
								: Ok(undefined);
						},
						async set(value: JsonValue) {
							requireOpen();
							await access.replace(address, compiled.validate(value));
						},
						async unset() {
							requireOpen();
							await access.unset(address);
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
		async dispose(): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			tableListeners.clear();
			valueListeners.clear();
			const failures: unknown[] = [];
			for (const release of [stopRecordSubscription, stopBlobSubscription]) {
				try {
					await release();
				} catch (cause) {
					failures.push(cause);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, 'Lens runtime cleanup failed');
			}
		},
	});
}

export type RecordLensRuntime<TSource, TRead> = ReturnType<
	typeof createRecordLensRuntime<TSource, TRead>
>;

/** Own one in-process replica, blob store, document runtime, and Lens runtime. */
export function createRecordOwner<TSource, TRead>({
	replica,
	blobs,
	dispose = () => undefined,
	log = createLogger('data'),
}: CreateRecordEpicenterOptions<TSource, TRead>) {
	const documents = createRecordDocumentRuntime(replica);
	const sync = createRecordSyncSupervisor({ replica, blobs, log });
	const attachmentListeners = new Set<
		(attachment: ReplicaAttachmentState) => void
	>();
	let lastAttachment = replica.attachment();
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Epicenter owner is disposed');
	}

	function publishAttachmentIfChanged(): void {
		const attachment = replica.attachment();
		if (attachmentsEqual(lastAttachment, attachment)) return;
		lastAttachment = attachment;
		for (const listener of attachmentListeners) {
			try {
				listener(attachment);
			} catch (cause) {
				log.error(new Error('Attachment subscriber threw', { cause }));
			}
		}
	}

	const stopDocumentRevocation = replica.subscribe((addresses) => {
		for (const address of addresses) {
			const visible = replica.visible(address);
			if (replica.record(address) === null || visible?.state === 'tombstone') {
				documents.revoke(address);
			}
		}
		publishAttachmentIfChanged();
	});

	const access: RecordLensAccess<TSource, TRead> = {
		async read(address) {
			requireOpen();
			return replica.visible(address);
		},
		async readPage(namespace, collection, after, limit) {
			requireOpen();
			return replica.visibleRecords(namespace, collection, after, limit);
		},
		async createRecord(namespace, collection, payload) {
			requireOpen();
			let recordKey = mintRecordKey();
			for (
				let attempts = 0;
				replica.record({ namespace, collection, recordKey }) !== null;
				attempts += 1
			) {
				if (attempts === 9) {
					throw new Error('Could not mint a fresh record ID');
				}
				recordKey = mintRecordKey();
			}
			replica.localWrite({
				address: { namespace, collection, recordKey },
				op: 'patch',
				set: payload,
				unset: [],
			});
			return recordKey;
		},
		async createRecordWithBlob(namespace, collection, payload, source) {
			requireOpen();
			let recordKey = mintRecordKey();
			for (
				let attempts = 0;
				replica.record({ namespace, collection, recordKey }) !== null;
				attempts += 1
			) {
				if (attempts === 9) {
					throw new Error('Could not mint a fresh record ID');
				}
				recordKey = mintRecordKey();
			}
			const address = { namespace, collection, recordKey };
			await blobs.captureNewRecord(address, source, (digest) => {
				replica.admitLocalRecordWithBlob({ address, payload, digest });
			});
			return recordKey;
		},
		async patchLive(address, patch) {
			requireOpen();
			const before = replica.visible(address);
			if (before?.state !== 'live') return before;
			replica.localWrite({ address, op: 'patch', ...patch });
			return replica.visible(address);
		},
		async tombstoneLive(address) {
			requireOpen();
			if (replica.visible(address)?.state !== 'live') return false;
			replica.localWrite({ address, op: 'tombstone' });
			return true;
		},
		async replace(address, value) {
			requireOpen();
			replica.localWrite({ address, op: 'replace', value });
		},
		async unset(address) {
			requireOpen();
			replica.localWrite({ address, op: 'unset' });
		},
		subscribeRecords(listener) {
			requireOpen();
			return replica.subscribe(listener);
		},
		openDocument(address) {
			requireOpen();
			return documents.open(address);
		},
		putBlob(address, source) {
			requireOpen();
			return blobs.capture(address, source);
		},
		readBlob(address) {
			requireOpen();
			return blobs.read(address);
		},
		async inspectBlob(address) {
			requireOpen();
			return blobs.inspect(address);
		},
		subscribeBlobs(listener) {
			requireOpen();
			return blobs.subscribe(listener);
		},
	};
	const lenses = createRecordLensRuntime(access, { log });

	return Object.freeze({
		bind: lenses.bind,
		attachSync(session: RecordSyncSession<TRead>): Promise<void> {
			requireOpen();
			const attaching = sync.attach(session);
			publishAttachmentIfChanged();
			return attaching;
		},
		get attachment(): ReplicaAttachmentState {
			requireOpen();
			return replica.attachment();
		},
		get syncStatus(): RecordSyncStatus {
			requireOpen();
			return sync.status;
		},
		subscribeAttachment(
			listener: (attachment: ReplicaAttachmentState) => void,
		) {
			requireOpen();
			attachmentListeners.add(listener);
			return () => attachmentListeners.delete(listener);
		},
		subscribeSyncStatus(listener: (status: RecordSyncStatus) => void) {
			requireOpen();
			return sync.subscribe(listener);
		},
		async parkedWork(after?: RecordAddress): Promise<ReplicaParkedWorkPage> {
			requireOpen();
			return sync.parked(after);
		},
		async inspectRecord(address: RecordAddress): Promise<RecordInspection> {
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
			attachmentListeners.clear();
			const failures: unknown[] = [];
			for (const release of [
				() => sync.dispose(),
				() => lenses.dispose(),
				stopDocumentRevocation,
				() => documents[Symbol.asyncDispose](),
				dispose,
			]) {
				try {
					await release();
				} catch (cause) {
					failures.push(cause);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, 'Epicenter owner cleanup failed');
			}
		},
	});
}

export type RecordOwner<TSource, TRead> = ReturnType<
	typeof createRecordOwner<TSource, TRead>
>;

/** Open the public in-process owner surface. */
export function createRecordEpicenter<TSource, TRead>(
	options: CreateRecordEpicenterOptions<TSource, TRead>,
) {
	return createRecordOwner(options);
}

export type RecordEpicenter<TSource, TRead> = ReturnType<
	typeof createRecordEpicenter<TSource, TRead>
>;
