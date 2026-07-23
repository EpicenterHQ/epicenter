import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok } from 'wellcrafted/result';

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
import {
	type JsonObject,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
	type ValidatedLimits,
} from '../protocol/v1/index.js';
import type {
	BrowserReplicaCandidateInbound,
	BrowserReplicaCandidateOutbound,
	BrowserReplicaCandidateStart,
} from '../store/replica/browser-candidate-protocol.js';
import type {
	BrowserReplicaCandidateOperation,
	BrowserReplicaCandidateResult,
} from '../store/replica/browser-owner-protocol.js';
import type {
	BlobCaptureOutcome,
	ReplicaOwner,
	VisibleRecordState,
	VisibleRecordsPage,
} from '../store/replica/index.js';
import type {
	BrowserAuthorityRequest,
	BrowserAuthorityResult,
} from './browser-protocol.js';
import { createBrowserRowDocumentRegistry } from './browser-row-document.js';
import type {
	BoundLens,
	CaptureError,
	EpicenterRuntime,
	Publication,
	TableRecordHandle,
	ValuesRecordHandle,
} from './epicenter.js';
import { RuntimeError } from './errors.js';
import type { BlockedWork, PublicationStatus } from './publication-status.js';
import type { AuthorityCarrier, SyncStatus } from './supervisor.js';

const PAGE_SIZE = 128;

type PendingRequest = {
	resolve(value: BrowserReplicaCandidateResult): void;
	reject(cause: unknown): void;
};

export type BrowserRuntimeWorker = {
	postMessage(message: BrowserReplicaCandidateInbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserReplicaCandidateOutbound }) => void,
	): void;
	addEventListener(
		type: 'error',
		listener: (event: { message?: string }) => void,
	): void;
	terminate(): void;
};

export type OpenBrowserEpicenterOptions = {
	/**
	 * The immutable identity of the replica to open: `null` opens this
	 * origin's unclaimed replica. Every physical name (SQLite pool, database,
	 * blob directory, Web Lock, worker coordination channel) derives from this
	 * identity, so the unclaimed replica and account replicas coexist
	 * (ADR-0178).
	 */
	owner: ReplicaOwner | null;
	carrier?: AuthorityCarrier<Blob> | null;
	limits?: ValidatedLimits;
	replicaId?: string;
	authorityLifetime?: string;
	coordinationId?: string;
	storage?: {
		databaseFilename: string;
		poolDirectory: string;
		poolName: string;
		lockName?: string;
		blobDirectory?: string;
	};
	createWorker?(): BrowserRuntimeWorker;
	log?: Logger;
};

/**
 * The stable storage slot for one replica identity on this origin:
 * `unclaimed`, or a digest of the owning deployment and principal.
 */
function replicaSlot(owner: ReplicaOwner | null): string {
	if (owner === null) return 'unclaimed';
	const identity = `${owner.deploymentId}\n${owner.principalId}`;
	return bytesToHex(sha256(new TextEncoder().encode(identity))).slice(0, 16);
}

function defaultStorage(slot: string) {
	return {
		databaseFilename: '/epicenter-data-v1.sqlite3',
		poolDirectory: `.epicenter-data-v1-${slot}-sahpool`,
		poolName: `epicenter-data-v1-${slot}`,
		lockName: `epicenter-data-v1-${slot}`,
		blobDirectory: `epicenter-data-v1-${slot}-blobs`,
	};
}

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

function tableKey(address: Pick<RecordAddress, 'namespace' | 'collection'>) {
	return JSON.stringify([address.namespace, address.collection]);
}

function createReplicaId(): string {
	// The store admits exactly 24 lowercase [a-z0-9] characters.
	return randomKey();
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

/**
 * Open the W4 page runtime over this origin's elected dedicated-worker owner.
 *
 * The page owns typed projections, subscriptions, and live Y.Docs. The worker
 * elected under the origin Web Lock owns SQLite, OPFS blobs, and the sole
 * automatic publication supervisor.
 */
export async function openBrowserEpicenter({
	owner,
	carrier = null,
	limits = SCALAR_SYNC_V1_LIMITS,
	replicaId = createReplicaId(),
	authorityLifetime,
	coordinationId,
	storage,
	createWorker = defaultWorker,
	log = createLogger('data/runtime/browser'),
}: OpenBrowserEpicenterOptions): Promise<EpicenterRuntime<Blob, Blob>> {
	if (carrier !== null && owner === null) {
		throw new TypeError(
			'an unclaimed replica never synchronizes; open with an owner to supply a carrier',
		);
	}
	const slot = replicaSlot(owner);
	const worker = createWorker();
	const pending = new Map<number, PendingRequest>();
	const activeRequests = new Set<Promise<void>>();
	const authorityTasks = new Set<Promise<void>>();
	const addressListeners = new Map<string, Set<() => void>>();
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
	const syncListeners = new Set<(status: SyncStatus) => void>();
	let nextRequestId = 0;
	let syncStatus: SyncStatus | undefined;
	let isReady = false;
	let isDisposing = false;
	let isDisposed = false;
	let workerFailure: Error | undefined;
	let closeResolve: (() => void) | undefined;
	let closeReject: ((cause: unknown) => void) | undefined;
	let readyResolve: (() => void) | undefined;
	let readyReject: ((cause: unknown) => void) | undefined;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});

	function requireOpen(): void {
		if (isDisposing || isDisposed)
			throw new Error('Browser Epicenter is disposed');
		if (workerFailure !== undefined) throw workerFailure;
	}

	function failWorker(cause: Error): void {
		if (workerFailure !== undefined) return;
		workerFailure = cause;
		readyReject?.(cause);
		closeReject?.(cause);
		for (const request of pending.values()) request.reject(cause);
		pending.clear();
		documents.revokeAll(cause);
	}

	function sendRequest<TResult>(
		operation: BrowserReplicaCandidateOperation,
	): Promise<TResult> {
		const id = nextRequestId++;
		const result = new Promise<TResult>((resolve, reject) => {
			pending.set(id, {
				resolve(value) {
					pending.delete(id);
					resolve(value as TResult);
				},
				reject(cause) {
					pending.delete(id);
					reject(cause);
				},
			});
			try {
				worker.postMessage({ type: 'request', id, operation });
			} catch (cause) {
				pending.get(id)?.reject(cause);
			}
		});
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		activeRequests.add(settled);
		void settled.finally(() => activeRequests.delete(settled));
		return result;
	}

	function request<TResult>(
		operation: BrowserReplicaCandidateOperation,
	): Promise<TResult> {
		requireOpen();
		return sendRequest(operation);
	}

	function notify(addresses: readonly RecordAddress[], all = false): void {
		if (isDisposing || isDisposed) return;
		if (all) {
			void documents.invalidateAll().catch((cause: unknown) => {
				if (!isDisposing && !isDisposed) {
					log.error(new Error('Browser document refresh failed', { cause }));
				}
			});
			for (const listeners of addressListeners.values()) {
				for (const listener of listeners) {
					try {
						listener();
					} catch (cause) {
						log.error(new Error('Data subscriber threw', { cause }));
					}
				}
			}
			for (const listeners of tableListeners.values()) {
				for (const listener of listeners) {
					try {
						listener([]);
					} catch (cause) {
						log.error(new Error('Data subscriber threw', { cause }));
					}
				}
			}
			return;
		}
		const byTable = new Map<string, string[]>();
		for (const address of addresses) {
			void documents.invalidate(address).catch((cause: unknown) => {
				if (!isDisposing && !isDisposed) {
					log.error(
						new Error('Browser document invalidation failed', { cause }),
					);
				}
			});
			for (const listener of addressListeners.get(addressKey(address)) ?? []) {
				try {
					listener();
				} catch (cause) {
					log.error(new Error('Data subscriber threw', { cause }));
				}
			}
			const key = tableKey(address);
			const ids = byTable.get(key) ?? [];
			ids.push(address.recordKey);
			byTable.set(key, ids);
		}
		for (const [key, ids] of byTable) {
			for (const listener of tableListeners.get(key) ?? []) {
				try {
					listener(ids);
				} catch (cause) {
					log.error(new Error('Data subscriber threw', { cause }));
				}
			}
		}
	}

	async function answerAuthority(
		id: number,
		authorityRequest: BrowserAuthorityRequest,
	): Promise<void> {
		try {
			if (carrier === null) throw new Error('Authority carrier is unavailable');
			let value: BrowserAuthorityResult;
			switch (authorityRequest.kind) {
				case 'facts':
					value = await carrier.fetchFacts(authorityRequest.request);
					break;
				case 'submission':
					value = await carrier.submit(authorityRequest.bytes);
					break;
				case 'document':
					value = await carrier.publishDocument(
						authorityRequest.address,
						authorityRequest.publication,
					);
					break;
				case 'blob':
					value = await carrier.publishBlob(
						authorityRequest.address,
						authorityRequest.publication,
						authorityRequest.bytes,
					);
					break;
			}
			worker.postMessage({ type: 'authority-result', id, value });
		} catch (cause) {
			worker.postMessage({
				type: 'authority-error',
				id,
				name: cause instanceof Error ? cause.name : 'Error',
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}

	const documents = createBrowserRowDocumentRegistry({ request });

	worker.addEventListener('message', ({ data: message }) => {
		switch (message.type) {
			case 'status':
				if (
					!isReady &&
					message.role !== 'waiting' &&
					message.ownerSession !== null
				) {
					isReady = true;
					readyResolve?.();
				}
				return;
			case 'result':
				pending.get(message.id)?.resolve(message.value);
				return;
			case 'error': {
				const cause = new Error(message.message);
				cause.name = message.name;
				pending.get(message.id)?.reject(cause);
				return;
			}
			case 'invalidation':
				notify(message.addresses, message.all);
				return;
			case 'runtime-sync-status':
				syncStatus = structuredClone(message.status);
				for (const listener of syncListeners) {
					listener(structuredClone(message.status));
				}
				return;
			case 'runtime-authority-replacement':
				documents.revokeAll();
				return;
			case 'authority-request':
				{
					const task = answerAuthority(message.id, message.request);
					authorityTasks.add(task);
					void task.then(
						() => authorityTasks.delete(task),
						() => authorityTasks.delete(task),
					);
				}
				return;
			case 'closed':
				closeResolve?.();
				return;
			case 'fatal': {
				const cause = new Error(message.message);
				cause.name = message.name;
				failWorker(cause);
				return;
			}
		}
	});
	worker.addEventListener('error', ({ message }) => {
		failWorker(new Error(message || 'Browser Epicenter worker failed'));
	});

	const start: BrowserReplicaCandidateStart = {
		type: 'start',
		limits,
		owner,
		initialize: {
			replicaId,
			...(authorityLifetime === undefined ? {} : { authorityLifetime }),
		},
		hasCarrier: carrier !== null,
		coordinationId:
			coordinationId ?? `epicenter-data-replica-owner-v3-${slot}`,
		storage: storage ?? defaultStorage(slot),
	};
	worker.postMessage(start);
	try {
		await ready;
		syncStatus = await request<SyncStatus>({ kind: 'runtime-status' });
	} catch (cause) {
		worker.terminate();
		throw cause;
	}

	const onlineListener = () => {
		if (isDisposing || isDisposed || workerFailure !== undefined) return;
		void request<void>({ kind: 'runtime-nudge' }).catch((cause: unknown) => {
			if (!isDisposing && !isDisposed) {
				log.error(
					new Error('Browser runtime reconnect nudge failed', { cause }),
				);
			}
		});
	};
	globalThis.addEventListener?.('online', onlineListener);

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

	async function readPublicationStatus(
		address: RecordAddress,
	): Promise<PublicationStatus> {
		return request<PublicationStatus>({ kind: 'publication-status', address });
	}

	function publication(address: RecordAddress): Publication {
		return Object.freeze({
			async get() {
				requireOpen();
				return readPublicationStatus(address);
			},
			subscribe(listener: (status: PublicationStatus) => void) {
				return subscribeAddress(address, () => {
					void readPublicationStatus(address)
						.then(listener)
						.catch((cause: unknown) => {
							if (!isDisposing && !isDisposed) {
								log.error(
									new Error('Publication subscription failed', { cause }),
								);
							}
						});
				});
			},
		});
	}

	function notLive(address: RecordAddress) {
		return RuntimeError.RecordNotLive({ address: addressKey(address) });
	}

	function tableRecord<TTable extends TableDefinition>(
		address: RecordAddress,
		compiled: CompiledTable<TTable>,
	): TableRecordHandle<TTable, Blob, Blob> {
		return Object.freeze({
			async get() {
				requireOpen();
				const visible = await request<VisibleRecordState>({
					kind: 'visible-record',
					address,
				});
				if (visible.state === 'absent') return Ok(undefined);
				return compiled.project(
					address.recordKey,
					visible.payload as JsonObject,
				);
			},
			async update(changes) {
				requireOpen();
				const normalized = compiled.normalizeUpdate(changes);
				const outcome = await request<
					| { kind: 'record-not-live' }
					| { kind: 'written'; visible: VisibleRecordState }
				>({
					kind: 'runtime-table-update',
					intent: { address, op: 'patch', ...normalized },
				});
				if (
					outcome.kind === 'record-not-live' ||
					outcome.visible.state === 'absent'
				) {
					return Ok(undefined);
				}
				return compiled.project(
					address.recordKey,
					outcome.visible.payload as JsonObject,
				);
			},
			async delete() {
				requireOpen();
				await request<void>({
					kind: 'runtime-delete-record',
					address,
				});
			},
			document: Object.freeze({
				async open() {
					requireOpen();
					const document = await documents.open(address);
					return document === null ? notLive(address) : Ok(document);
				},
			}),
			blob: Object.freeze({
				async capture(source: Blob) {
					requireOpen();
					const outcome = await request<BlobCaptureOutcome>({
						kind: 'capture-blob',
						address,
						bytes: source,
					});
					switch (outcome.kind) {
						case 'captured':
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
					return (
						(await request<Blob | null>({
							kind: 'runtime-read-blob',
							address,
						})) ?? undefined
					);
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
				const visible = await request<VisibleRecordState>({
					kind: 'visible-record',
					address,
				});
				return visible.state === 'absent'
					? Ok(undefined)
					: compiled.project(visible.payload);
			},
			async set(value: unknown) {
				requireOpen();
				const outcome = await request<{
					kind: 'written' | 'record-not-live';
				}>({
					kind: 'runtime-value-write',
					intent: {
						address,
						op: 'replace',
						value: compiled.validate(value),
					},
				});
				return outcome.kind === 'written' ? Ok(undefined) : notLive(address);
			},
			async unset() {
				requireOpen();
				const outcome = await request<{
					kind: 'written' | 'record-not-live';
				}>({
					kind: 'runtime-value-write',
					intent: { address, op: 'unset' },
				});
				return outcome.kind === 'written' ? Ok(undefined) : notLive(address);
			},
			subscribe(listener: () => void) {
				return subscribeAddress(address, listener);
			},
			publication: publication(address),
		});
	}

	function bind<const TLens extends LensDefinition>(
		lens: TLens,
	): BoundLens<TLens, Blob, Blob> {
		requireOpen();
		const compiled = compileLens(lens);
		const bound: Record<string, unknown> = {};
		for (const [collectionKey, definition] of Object.entries(
			lens.collections,
		)) {
			const collectionTableKey = JSON.stringify([
				lens.namespace,
				collectionKey,
			]);
			if (definition.kind === 'table') {
				const table = compiled[collectionKey] as CompiledTable;
				const entries = async function* () {
					requireOpen();
					let after: string | null = null;
					for (;;) {
						const page: VisibleRecordsPage = await request<VisibleRecordsPage>({
							kind: 'visible-records-page',
							namespace: lens.namespace,
							collection: collectionKey,
							afterRecordKey: after,
							limit: PAGE_SIZE,
						});
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
						await request<void>({
							kind: 'local-write',
							intent: { address, op: 'patch', set: payload, unset: [] },
						});
						const visible = await request<VisibleRecordState>({
							kind: 'visible-record',
							address,
						});
						if (visible.state !== 'live') {
							throw new Error('Created row is not visibly live');
						}
						const projected = table.project(id, visible.payload as JsonObject);
						if (projected.error !== null) throw projected.error;
						return projected.data;
					},
					async put(id: string, fields: Record<string, unknown>) {
						requireOpen();
						const payload = table.validateCreate(fields);
						const address = {
							namespace: lens.namespace,
							collection: collectionKey,
							recordKey: id,
						};
						const outcome = await request<
							| { kind: 'record-not-live' }
							| { kind: 'written'; visible: VisibleRecordState }
						>({
							kind: 'runtime-put-record',
							intent: { address, op: 'patch', set: payload, unset: [] },
						});
						if (
							outcome.kind === 'record-not-live' ||
							outcome.visible.state === 'absent'
						) {
							return Ok(undefined);
						}
						return table.project(id, outcome.visible.payload as JsonObject);
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
						const listeners =
							tableListeners.get(collectionTableKey) ?? new Set();
						listeners.add(listener);
						tableListeners.set(collectionTableKey, listeners);
						return () => {
							listeners.delete(listener);
							if (listeners.size === 0) {
								tableListeners.delete(collectionTableKey);
							}
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
		return Object.freeze(bound) as BoundLens<TLens, Blob, Blob>;
	}

	async function blockedRecords(): Promise<
		{ address: RecordAddress; blocked: [BlockedWork, ...BlockedWork[]] }[]
	> {
		requireOpen();
		const result = [];
		let after: RecordAddress | null = null;
		for (;;) {
			const page: RecordAddress[] = await request<RecordAddress[]>({
				kind: 'blocked-records-page',
				after,
				limit: 64,
			});
			for (const address of page) {
				const status = await readPublicationStatus(address);
				if (status.state === 'blocked') {
					result.push({ address, blocked: status.blocked });
				}
			}
			if (page.length < 64) break;
			after = page.at(-1) ?? null;
		}
		return result;
	}

	async function dispose(): Promise<void> {
		if (isDisposed || isDisposing) return;
		isDisposing = true;
		globalThis.removeEventListener?.('online', onlineListener);
		addressListeners.clear();
		tableListeners.clear();
		syncListeners.clear();
		const failures: unknown[] = [];
		try {
			await documents.dispose();
		} catch (cause) {
			failures.push(cause);
		}
		await Promise.all([...activeRequests]);
		if (workerFailure === undefined) {
			try {
				await new Promise<void>((resolve, reject) => {
					closeResolve = resolve;
					closeReject = reject;
					worker.postMessage({ type: 'close' });
				});
			} catch (cause) {
				failures.push(cause);
			}
		}
		try {
			await Promise.all([...authorityTasks]);
		} catch (cause) {
			failures.push(cause);
		}
		try {
			worker.terminate();
		} finally {
			isDisposed = true;
			isDisposing = false;
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Browser Epicenter disposal failed');
		}
	}

	return Object.freeze({
		bind,
		sync: Object.freeze({
			get status(): SyncStatus {
				return structuredClone(syncStatus ?? { state: 'local-only' });
			},
			subscribe(listener: (status: SyncStatus) => void) {
				requireOpen();
				syncListeners.add(listener);
				return () => syncListeners.delete(listener);
			},
		}),
		blockedRecords,
		[Symbol.asyncDispose]: dispose,
	}) as EpicenterRuntime<Blob, Blob>;
}

export type BrowserEpicenter = Awaited<ReturnType<typeof openBrowserEpicenter>>;

function defaultWorker(): BrowserRuntimeWorker {
	return new Worker(
		new URL('../browser-replica-candidate-worker.ts', import.meta.url),
		{ type: 'module', name: 'epicenter-data-runtime' },
	);
}

export type {
	CaptureError,
	ConstrainedUpdate,
	CreateInputFor,
	NonconformingValueError,
	RowFor,
	TableDefinition,
	ValuesDefinition,
};
