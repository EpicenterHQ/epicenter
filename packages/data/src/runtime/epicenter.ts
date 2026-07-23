import type { DocumentMeasure } from '@epicenter/sync/document-v3';
import type { Static } from 'typebox';
import { Ok, type Result } from 'wellcrafted/result';

import {
	type CompiledTable,
	type CompiledValue,
	type ConstrainedUpdate,
	type CreateInputFor,
	compileLens,
	type LensDefinition,
	type NonconformingRowError,
	type NonconformingValueError,
	type RowFor,
	type TableDefinition,
	type ValuesDefinition,
} from '../lens/index.js';
import type { JsonObject, RecordAddress } from '../protocol/v1/index.js';
import type {
	ReplicaAttachment,
	ReplicaBlobStore,
	ReplicaStore,
} from '../store/replica/index.js';
import {
	type BlobAlreadyCapturedError,
	type BlobSourceReadError,
	type RecordNotLiveError,
	RuntimeError,
} from './errors.js';
import {
	type BlockedWork,
	type PublicationStatus,
	publicationStatus,
} from './publication-status.js';
import { createRowDocumentRegistry, type RowDocument } from './row-document.js';
import {
	type AuthorityCarrier,
	createRuntimeSupervisor,
	type RuntimeBackoff,
	type SyncStatus,
} from './supervisor.js';

const PAGE_SIZE = 128;

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

function terminal(lanes: ReturnType<ReplicaStore['record']>): boolean {
	return (
		lanes?.confirmed?.state === 'tombstone' ||
		lanes?.sealed?.op === 'tombstone' ||
		lanes?.pending?.op === 'tombstone'
	);
}

function randomKey(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const result: string[] = [];
	const bytes = new Uint8Array(32);
	while (result.length < 24) {
		crypto.getRandomValues(bytes);
		for (const byte of bytes) {
			if (byte >= 252) continue;
			const character = alphabet[byte % alphabet.length];
			if (character === undefined) throw new Error('record key mint failed');
			result.push(character);
			if (result.length === 24) break;
		}
	}
	return result.join('');
}

export type CaptureError =
	| RecordNotLiveError
	| BlobAlreadyCapturedError
	| BlobSourceReadError;

export type Publication = {
	get(): Promise<PublicationStatus>;
	subscribe(listener: (status: PublicationStatus) => void): () => void;
};

export type AttachOutcome =
	| { kind: 'attached' }
	| {
			kind: 'first-attachment-choice';
			proceed(choice: 'bring' | 'discard'): Promise<void>;
	  };

export type TableRecordHandle<
	TTable extends TableDefinition,
	TBlobSource,
	TBlobRead,
> = {
	get(): Promise<Result<RowFor<TTable> | undefined, NonconformingRowError>>;
	update<const TChanges extends Record<string, unknown>>(
		changes: TChanges & ConstrainedUpdate<TTable, TChanges>,
	): Promise<Result<RowFor<TTable> | undefined, NonconformingRowError>>;
	delete(): Promise<void>;
	document: {
		open(): Promise<Result<RowDocument, RecordNotLiveError>>;
	};
	blob: {
		capture(source: TBlobSource): Promise<Result<void, CaptureError>>;
		read(): Promise<TBlobRead | undefined>;
	};
	publication: Publication;
};

export type ValuesRecordHandle<TValue> = {
	get(): Promise<Result<TValue | undefined, NonconformingValueError>>;
	set(value: TValue): Promise<Result<void, RecordNotLiveError>>;
	unset(): Promise<Result<void, RecordNotLiveError>>;
	subscribe(listener: () => void): () => void;
	publication: Publication;
};

export type TableLens<
	TTable extends TableDefinition,
	TBlobSource,
	TBlobRead,
> = {
	create(fields: CreateInputFor<TTable>): Promise<RowFor<TTable>>;
	scan(): Promise<{
		rows: RowFor<TTable>[];
		nonconforming: NonconformingRowError[];
	}>;
	entries(): AsyncIterable<Result<RowFor<TTable>, NonconformingRowError>>;
	subscribe(listener: (changedIds: string[]) => void): () => void;
	record(id: string): TableRecordHandle<TTable, TBlobSource, TBlobRead>;
};

export type ValuesLens<TValues extends ValuesDefinition> = {
	record<TKey extends keyof TValues['values'] & string>(
		key: TKey,
	): ValuesRecordHandle<Static<TValues['values'][TKey]>>;
};

export type BoundLens<TLens extends LensDefinition, TBlobSource, TBlobRead> = {
	[TKey in keyof TLens['collections']]: TLens['collections'][TKey] extends TableDefinition
		? TableLens<TLens['collections'][TKey], TBlobSource, TBlobRead>
		: TLens['collections'][TKey] extends ValuesDefinition
			? ValuesLens<TLens['collections'][TKey]>
			: never;
};

export type CreateEpicenterRuntimeOptions<TBlobSource, TBlobRead> = {
	store: ReplicaStore;
	blobs: ReplicaBlobStore<TBlobSource, TBlobRead> | null;
	carrier?: AuthorityCarrier<TBlobRead> | null;
	intervalMs?: number;
	backoff?: RuntimeBackoff;
	disposeOwned?: () => void | Promise<void>;
};

export function createEpicenterRuntime<TBlobSource, TBlobRead>({
	store,
	blobs,
	carrier = null,
	intervalMs,
	backoff,
	disposeOwned,
}: CreateEpicenterRuntimeOptions<TBlobSource, TBlobRead>) {
	let disposed = false;
	let syncStatus!: SyncStatus;
	const addressListeners = new Map<string, Set<() => void>>();
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
	const syncListeners = new Set<(status: SyncStatus) => void>();

	function requireOpen(): void {
		if (disposed) throw new Error('Epicenter is disposed');
	}
	function subscribeAddress(address: RecordAddress, listener: () => void) {
		requireOpen();
		const key = addressKey(address);
		const listeners = addressListeners.get(key) ?? new Set();
		listeners.add(listener);
		addressListeners.set(key, listeners);
		return () => {
			listeners.delete(listener);
			if (listeners.size === 0) addressListeners.delete(key);
		};
	}
	function notify(addresses: readonly RecordAddress[]): void {
		if (disposed) return;
		const byTable = new Map<string, string[]>();
		for (const address of addresses) {
			documents.invalidate(address);
			for (const listener of addressListeners.get(addressKey(address)) ?? []) {
				listener();
			}
			const tableKey = JSON.stringify([address.namespace, address.collection]);
			const ids = byTable.get(tableKey) ?? [];
			ids.push(address.recordKey);
			byTable.set(tableKey, ids);
		}
		for (const [key, ids] of byTable) {
			for (const listener of tableListeners.get(key) ?? []) listener(ids);
		}
	}

	const documents = createRowDocumentRegistry({
		store,
		onLocalUpdate(address) {
			notify([address]);
			supervisor.nudge();
		},
	});
	const supervisor = createRuntimeSupervisor({
		store,
		blobs,
		carrier,
		onInvalidate: notify,
		onAuthorityReplacement: documents.revokeAll,
		onStatus(status) {
			syncStatus = status;
			if (!disposed) {
				for (const listener of syncListeners) listener(structuredClone(status));
			}
		},
		...(intervalMs === undefined ? {} : { intervalMs }),
		...(backoff === undefined ? {} : { backoff }),
	});
	syncStatus = supervisor.status();

	function afterWrite(address: RecordAddress): void {
		notify([address]);
		supervisor.nudge();
	}
	function publication(address: RecordAddress): Publication {
		return Object.freeze({
			async get() {
				requireOpen();
				return publicationStatus(store, blobs, address);
			},
			subscribe(listener: (status: PublicationStatus) => void) {
				return subscribeAddress(address, () =>
					listener(publicationStatus(store, blobs, address)),
				);
			},
		});
	}
	function notLive(address: RecordAddress) {
		return RuntimeError.RecordNotLive({ address: addressKey(address) });
	}

	function tableRecord<TTable extends TableDefinition>(
		address: RecordAddress,
		compiled: CompiledTable<TTable>,
	): TableRecordHandle<TTable, TBlobSource, TBlobRead> {
		return Object.freeze({
			async get() {
				requireOpen();
				const visible = store.visibleRecord(address);
				if (visible.state === 'absent') return Ok(undefined);
				return compiled.project(
					address.recordKey,
					visible.payload as JsonObject,
				);
			},
			async update(changes) {
				requireOpen();
				if (!store.isVisiblyLive(address)) return Ok(undefined);
				const normalized = compiled.normalizeUpdate(changes);
				store.localWrite({ address, op: 'patch', ...normalized });
				afterWrite(address);
				const visible = store.visibleRecord(address);
				if (visible.state === 'absent') return Ok(undefined);
				return compiled.project(
					address.recordKey,
					visible.payload as JsonObject,
				);
			},
			async delete() {
				requireOpen();
				if (terminal(store.record(address))) return;
				store.localWrite({ address, op: 'tombstone' });
				afterWrite(address);
			},
			document: Object.freeze({
				async open() {
					requireOpen();
					if (!store.isVisiblyLive(address)) return notLive(address);
					return Ok(documents.open(address));
				},
			}),
			blob: Object.freeze({
				async capture(source: TBlobSource) {
					requireOpen();
					if (blobs === null) throw new Error('Blob storage is unavailable');
					if (!store.isVisiblyLive(address)) return notLive(address);
					const outcome = await blobs.capture(address, source);
					switch (outcome.kind) {
						case 'captured':
							afterWrite(address);
							return Ok(undefined);
						case 'record-not-live':
							return notLive(address);
						case 'blob-conflict':
							return RuntimeError.BlobAlreadyCaptured({
								address: addressKey(address),
							});
						case 'source-read-failed':
							return RuntimeError.BlobSourceRead({
								address: addressKey(address),
								cause: outcome.cause,
							});
						default:
							return outcome satisfies never;
					}
				},
				async read() {
					requireOpen();
					if (blobs === null || !store.isVisiblyLive(address)) return undefined;
					return (await blobs.read(address)) ?? undefined;
				},
			}),
			publication: publication(address),
		});
	}

	function valuesRecord(
		address: RecordAddress,
		compiled: CompiledValue,
	): ValuesRecordHandle<unknown> {
		return Object.freeze({
			async get() {
				requireOpen();
				const visible = store.visibleRecord(address);
				return visible.state === 'absent'
					? Ok(undefined)
					: compiled.project(visible.payload);
			},
			async set(value: unknown) {
				requireOpen();
				if (terminal(store.record(address))) return notLive(address);
				store.localWrite({
					address,
					op: 'replace',
					value: compiled.validate(value),
				});
				afterWrite(address);
				return Ok(undefined);
			},
			async unset() {
				requireOpen();
				if (terminal(store.record(address))) return notLive(address);
				store.localWrite({ address, op: 'unset' });
				afterWrite(address);
				return Ok(undefined);
			},
			subscribe(listener: () => void) {
				return subscribeAddress(address, listener);
			},
			publication: publication(address),
		});
	}

	function bind<const TLens extends LensDefinition>(
		lens: TLens,
	): BoundLens<TLens, TBlobSource, TBlobRead> {
		requireOpen();
		const compiled = compileLens(lens);
		const bound: Record<string, unknown> = {};
		for (const [collectionKey, definition] of Object.entries(
			lens.collections,
		)) {
			const tableKey = JSON.stringify([lens.namespace, collectionKey]);
			if (definition.kind === 'table') {
				const table = compiled[collectionKey] as CompiledTable;
				const entries = async function* () {
					requireOpen();
					let after: string | null = null;
					while (true) {
						const page = store.visibleRecordsPage(
							lens.namespace,
							collectionKey,
							after,
							PAGE_SIZE,
						);
						for (const record of page.records) {
							yield table.project(
								record.recordKey,
								record.payload as JsonObject,
							);
							after = record.recordKey;
						}
						if (!page.hasMore) return;
					}
				};
				bound[collectionKey] = Object.freeze({
					async create(fields: Record<string, unknown>) {
						requireOpen();
						const payload = table.validateCreate(fields);
						const id = randomKey();
						const address = {
							namespace: lens.namespace,
							collection: collectionKey,
							recordKey: id,
						};
						store.localWrite({ address, op: 'patch', set: payload, unset: [] });
						afterWrite(address);
						const visible = store.visibleRecord(address);
						if (visible.state !== 'live') {
							throw new Error('Created row is not visibly live');
						}
						const projected = table.project(id, visible.payload as JsonObject);
						if (projected.error !== null) throw projected.error;
						return projected.data;
					},
					async scan() {
						const rows: unknown[] = [];
						const nonconforming: NonconformingRowError[] = [];
						for await (const result of entries()) {
							if (result.error === null) rows.push(result.data);
							else nonconforming.push(result.error);
						}
						return { rows, nonconforming };
					},
					entries,
					subscribe(listener: (changedIds: string[]) => void) {
						requireOpen();
						const listeners = tableListeners.get(tableKey) ?? new Set();
						listeners.add(listener);
						tableListeners.set(tableKey, listeners);
						return () => {
							listeners.delete(listener);
							if (listeners.size === 0) tableListeners.delete(tableKey);
						};
					},
					record(id: string) {
						requireOpen();
						return tableRecord(
							{
								namespace: lens.namespace,
								collection: collectionKey,
								recordKey: id,
							},
							table,
						);
					},
				});
			} else {
				const values = compiled[collectionKey] as Record<string, CompiledValue>;
				bound[collectionKey] = Object.freeze({
					record(key: string) {
						requireOpen();
						const validator = values[key];
						if (validator === undefined) {
							throw new TypeError(`Unknown value key '${key}'`);
						}
						return valuesRecord(
							{
								namespace: lens.namespace,
								collection: collectionKey,
								recordKey: key,
							},
							validator,
						);
					},
				});
			}
		}
		return Object.freeze(bound) as BoundLens<TLens, TBlobSource, TBlobRead>;
	}

	const epicenter = {
		bind,
		sync: Object.freeze({
			get status(): SyncStatus {
				return structuredClone(syncStatus);
			},
			subscribe(listener: (status: SyncStatus) => void) {
				requireOpen();
				syncListeners.add(listener);
				return () => syncListeners.delete(listener);
			},
		}),
		async attach(
			pair: ReplicaAttachment,
			choice?: 'bring' | 'discard',
		): Promise<AttachOutcome> {
			requireOpen();
			const outcome = supervisor.attach(pair, choice);
			return outcome.kind === 'attached'
				? outcome
				: {
						kind: 'first-attachment-choice',
						async proceed(selectedChoice) {
							outcome.proceed(selectedChoice);
						},
					};
		},
		signOut(): void {
			requireOpen();
			supervisor.setCarrier(null);
		},
		async blockedRecords(): Promise<
			{ address: RecordAddress; blocked: [BlockedWork, ...BlockedWork[]] }[]
		> {
			requireOpen();
			// Enumerate durable blocked evidence from the store itself: a fresh
			// process must see blocked records it has never otherwise observed.
			const result = [];
			let after: RecordAddress | null = null;
			for (;;) {
				const page = store.blockedRecordsPage(after, 64);
				for (const address of page) {
					const status = publicationStatus(store, blobs, address);
					if (status.state === 'blocked') {
						result.push({ address, blocked: status.blocked });
					}
				}
				if (page.length < 64) break;
				after = page.at(-1) ?? null;
			}
			return result;
		},
		async [Symbol.asyncDispose](): Promise<void> {
			if (disposed) return;
			disposed = true;
			addressListeners.clear();
			tableListeners.clear();
			syncListeners.clear();
			documents.dispose();
			await supervisor.dispose();
			await disposeOwned?.();
		},
	};
	return epicenter;
}

export type EpicenterRuntime<
	TBlobSource = unknown,
	TBlobRead = unknown,
> = ReturnType<typeof createEpicenterRuntime<TBlobSource, TBlobRead>>;

export type { DocumentMeasure };
