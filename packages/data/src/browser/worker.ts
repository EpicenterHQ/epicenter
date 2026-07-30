import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	applyRowDocumentUpdate,
	encodeRowDocumentState,
	observeRowDocumentUpdates,
	type RowDocument,
} from '../documents.js';
import {
	createEpicenter,
	type Epicenter,
	readTableEntriesPage,
} from '../epicenter.js';
import {
	type Address,
	addressesEqual,
	type ExchangeRequest,
	type ExchangeResponse,
	type RowAddress,
} from '../protocol/index.js';
import { openReplica, type Replica } from '../replica/index.js';
import { tableLens, valueLens } from '../serialized-lens.js';
import type {
	BrowserOperation,
	BrowserTransportResult,
	BrowserWorkerInbound,
	BrowserWorkerMessage,
	SessionTransportRequest,
	SessionTransportResponse,
} from './protocol.js';
import {
	acquireBrowserStorageLease,
	type BrowserStorageLease,
	type LockManagerPort,
} from './storage-lease.js';

type MessagePortLike = {
	postMessage(message: BrowserWorkerMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserWorkerInbound }) => void,
	): void;
	start?(): void;
	close?(): void;
};

export type BrowserWorkerStore = {
	epicenter: Epicenter;
	replica: Replica;
	dispose(): Promise<void>;
};

type WorkerDocument = {
	address: RowAddress;
	document: RowDocument;
	stopUpdates(): void;
};

/**
 * The page's current sync attachment.
 *
 * `transportKey` is a generation, not a route. One page re-attaches whenever
 * the account changes (sign-in, sign-out, switching principal), and a network
 * call issued under the previous attachment must never resolve into the new
 * one. Everything keyed by it exists to fence those stale results, never to
 * choose between simultaneous transports: there is only ever one page.
 */
type SyncAttachment = {
	transportKey: number;
	hasCredentials: boolean;
	canPublishDocuments: boolean;
	canPullDocuments: boolean;
};

type StoreLifecycle = {
	controller: AbortController;
	ready: Promise<BrowserWorkerStore>;
	store: BrowserWorkerStore | undefined;
	disposal: Promise<unknown[]> | undefined;
	stopReplicaSubscription: (() => void) | undefined;
	stopSyncStatusSubscription: (() => void) | undefined;
};

const documentRpcOrigin = Object.freeze({ kind: 'browser-document-rpc' });
const DEFAULT_EXCHANGE_TIMEOUT_MS = 30_000;

export async function settleBrowserCleanup({
	initialFailures = [],
	stages,
	message,
}: {
	initialFailures?: unknown[];
	stages: (() => unknown | Promise<unknown>)[];
	message: string;
}): Promise<void> {
	const failures = [...initialFailures];
	for (const stage of stages) {
		try {
			await stage();
		} catch (cause) {
			failures.push(cause);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, message);
}

/**
 * Serve one page from this worker.
 *
 * One browser page owns one dedicated worker, which owns one Epicenter replica
 * and one OPFS SQLite database. A competing same-origin owner is refused by the
 * Web Lock in {@link acquireBrowserStorageLease} rather than admitted here, so
 * this host models exactly one connection for its whole life: no client
 * registry, no routing, no election between transports, no failover, and no
 * last-connected bookkeeping. Ownership passes to a new page only after this
 * one disposes and releases the lock.
 *
 * The page is the network: it holds the credentials and performs every
 * authenticated call on the worker's behalf. When a call fails, it fails, and
 * the sync supervisor that owns durability decides whether to retry. This host
 * never retries an exchange itself, because there is nowhere else to send it.
 */
export function serveBrowserEpicenter(
	port: MessagePortLike,
	{
		openStore = openBrowserWorkerStore,
		exchangeTimeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS,
		log = createLogger('data/browser-worker'),
	}: {
		openStore?: (options: {
			signal: AbortSignal;
		}) => Promise<BrowserWorkerStore>;
		exchangeTimeoutMs?: number;
		log?: Logger;
	} = {},
): void {
	const documents = new Map<number, WorkerDocument>();
	const documentClosures = new Set<Promise<void>>();
	const syncCredentialListeners = new Set<() => void>();
	// Correlates one in-flight page request with its response. Concurrent calls
	// share the port, so the id is how a result finds its caller.
	const transports = new Map<
		number,
		{
			transportKey: number;
			resolve(value: SessionTransportResponse): void;
			reject(cause: unknown): void;
		}
	>();
	let syncAttachment: SyncAttachment | undefined;
	let storeLifecycle: StoreLifecycle | undefined;
	let storeClosure:
		| { lifecycle: StoreLifecycle | undefined; drain: Promise<void> }
		| undefined;
	let disconnection: Promise<void> | undefined;
	let terminalCause: Error | undefined;
	let isDisconnected = false;
	let isPortClosed = false;
	let requestTail = Promise.resolve();
	let nextDocumentId = 0;
	let nextTransportId = 0;

	function logCleanupFailures(message: string, failures: unknown[]): void {
		if (failures.length === 0) return;
		log.error(new AggregateError(failures, message));
	}

	function closePort(): void {
		if (isPortClosed) return;
		isPortClosed = true;
		try {
			port.close?.();
		} catch (cause) {
			log.error(new Error('Browser page port cleanup failed', { cause }));
		}
	}

	function send(
		message: BrowserWorkerMessage,
		{ afterDisconnect = false }: { afterDisconnect?: boolean } = {},
	): boolean {
		if (isDisconnected && !afterDisconnect) return false;
		try {
			port.postMessage(message);
			return true;
		} catch (cause) {
			const failure = new Error('Browser Epicenter page port failed', {
				cause,
			});
			if (disconnection === undefined) failOwner(failure);
			closePort();
			return false;
		}
	}

	/**
	 * Tear down after the page became unreachable. Nothing is notified: the only
	 * party that could receive a message is the page whose port just failed.
	 */
	function failOwner(cause: Error): void {
		if (isDisconnected) return;
		markTerminal(cause);
		setTimeout(() => closePort(), 0);
		void (async () => {
			try {
				await performDisconnect();
			} catch (cleanupCause) {
				log.error(
					new Error('Browser page terminal cleanup failed', {
						cause: cleanupCause,
					}),
				);
			}
		})();
	}

	function serializeLocal<TResult>(
		operation: () => Promise<TResult>,
	): Promise<TResult> {
		const result = requestTail.then(operation);
		requestTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function notifySyncCredentials(): void {
		for (const listener of syncCredentialListeners) listener();
	}

	function cancelTransport(transportId: number, transportKey: number): void {
		send(
			{ type: 'transport-cancel', transportId, transportKey },
			{ afterDisconnect: true },
		);
	}

	/**
	 * Retire one attachment generation: fail everything still in flight under it
	 * and cancel those exact page callbacks. Called when a newer attachment
	 * supersedes this one and when an attachment fails, so a superseded
	 * credential can never satisfy a later request.
	 */
	function retireAttachment(transportKey: number): void {
		if (syncAttachment?.transportKey === transportKey) {
			syncAttachment = undefined;
		}
		for (const [transportId, pending] of transports) {
			if (pending.transportKey !== transportKey) continue;
			transports.delete(transportId);
			cancelTransport(transportId, transportKey);
			pending.reject(new Error('Browser sync transport was retired'));
		}
		notifySyncCredentials();
	}

	const syncCredentials = {
		get(): string | undefined {
			return syncAttachment?.hasCredentials === true
				? 'page-owned-credential'
				: undefined;
		},
		subscribe(listener: () => void): () => void {
			syncCredentialListeners.add(listener);
			return () => syncCredentialListeners.delete(listener);
		},
	};

	async function callSyncTransport(
		request: SessionTransportRequest,
	): Promise<SessionTransportResponse> {
		const attachment = syncAttachment;
		if (attachment === undefined || !attachment.hasCredentials) {
			throw new Error('No browser sync transport is attached');
		}
		if (
			request.kind === 'document-publish' &&
			!attachment.canPublishDocuments
		) {
			throw new Error('Browser sync transport cannot publish documents');
		}
		if (request.kind === 'document-pull' && !attachment.canPullDocuments) {
			throw new Error('Browser sync transport cannot pull documents');
		}
		const response = await callTransport(attachment.transportKey, request);
		if (response.kind !== request.kind) {
			throw new Error('Browser sync transport answered the wrong request');
		}
		return response;
	}

	async function exchangeThroughPage(
		request: ExchangeRequest,
	): Promise<ExchangeResponse> {
		const response = await callSyncTransport({ kind: 'exchange', request });
		if (response.kind !== 'exchange') {
			throw new Error('Browser sync transport answered the wrong request');
		}
		return response.response;
	}

	async function openedStore(): Promise<BrowserWorkerStore> {
		requireConnected();
		if (storeLifecycle !== undefined) return storeLifecycle.ready;
		const controller = new AbortController();
		let lifecycle: StoreLifecycle;
		const ready = Promise.resolve()
			.then(() => openStore({ signal: controller.signal }))
			.then(async (store) => {
				if (controller.signal.aborted) {
					try {
						await store.dispose();
					} catch (cause) {
						log.error(
							new Error('Late browser store disposal failed', { cause }),
						);
					}
					throw storeClosingError(controller.signal.reason);
				}
				let stopReplica: (() => void) | undefined;
				let stopStatus: (() => void) | undefined;
				try {
					stopReplica = store.replica.subscribe((changes) => {
						for (const change of changes) {
							if (change.kind !== 'row') continue;
							const row = store.replica.readRow(change);
							if (row.error !== null) {
								// Liveness is unknowable this pass, so open documents
								// keep running rather than being revoked on a guess.
								// Reported because this read is what a pull's
								// `RowNotLive` is waiting on.
								log.error(row.error);
							} else if (row.data === undefined) {
								void revokeDocuments(change);
							}
						}
						// One frame for the whole commit. The page groups it; the
						// worker never decides which handles exist.
						emitInvalidation(changes);
					});
					stopStatus = store.epicenter.subscribeSyncStatus((status) => {
						send({
							type: 'sync-status',
							state: status.state,
							...(status.lastError === undefined
								? {}
								: { lastError: status.lastError.message }),
						});
					});
					if (controller.signal.aborted) {
						throw storeClosingError(controller.signal.reason);
					}
					lifecycle.stopReplicaSubscription = stopReplica;
					lifecycle.stopSyncStatusSubscription = stopStatus;
					lifecycle.store = store;
					return store;
				} catch (cause) {
					const failures = [cause];
					try {
						stopReplica?.();
					} catch (cleanupCause) {
						failures.push(cleanupCause);
					}
					try {
						stopStatus?.();
					} catch (cleanupCause) {
						failures.push(cleanupCause);
					}
					try {
						await store.dispose();
					} catch (cleanupCause) {
						failures.push(cleanupCause);
					}
					if (failures.length === 1) throw cause;
					throw new AggregateError(
						failures,
						'Browser store setup and cleanup failed',
					);
				}
			});
		lifecycle = {
			controller,
			ready,
			store: undefined,
			disposal: undefined,
			stopReplicaSubscription: undefined,
			stopSyncStatusSubscription: undefined,
		};
		storeLifecycle = lifecycle;
		return ready;
	}

	function emitInvalidation(changes: readonly Address[]): void {
		if (changes.length === 0) return;
		send({ type: 'invalidation', changes });
	}

	async function revokeDocuments(address: RowAddress): Promise<void> {
		const message = `Row document was revoked because '${address.namespace}/${address.tableName}/${address.rowId}' is no longer live`;
		const closures: Promise<void>[] = [];
		for (const [documentId, entry] of documents) {
			if (!addressesEqual(entry.address, address)) continue;
			send({ type: 'document-revoked', documentId, message });
			closures.push(closeDocument(documentId));
		}
		const failures: unknown[] = [];
		for (const result of await Promise.allSettled(closures)) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		logCleanupFailures('Browser document revocation cleanup', failures);
	}

	function trackClosure(cleanup: () => Promise<void>): Promise<void> {
		const closure = Promise.resolve().then(cleanup);
		documentClosures.add(closure);
		void closure.then(
			() => documentClosures.delete(closure),
			() => documentClosures.delete(closure),
		);
		return closure;
	}

	function trackDocumentClosure(document: RowDocument): Promise<void> {
		return trackClosure(() => document[Symbol.asyncDispose]());
	}

	async function settleDocumentClosures(): Promise<unknown[]> {
		const failures: unknown[] = [];
		while (documentClosures.size > 0) {
			const settled = await Promise.allSettled([...documentClosures]);
			for (const result of settled) {
				if (result.status === 'rejected') failures.push(result.reason);
			}
		}
		return failures;
	}

	function closeDocument(documentId: number): Promise<void> {
		const entry = documents.get(documentId);
		if (entry === undefined) return Promise.resolve();
		documents.delete(documentId);
		const failures: unknown[] = [];
		try {
			entry.stopUpdates();
		} catch (cause) {
			failures.push(cause);
		}
		return trackClosure(async () => {
			try {
				await entry.document[Symbol.asyncDispose]();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(failures, 'Browser document cleanup failed');
			}
		});
	}

	function disconnect(
		cause = new Error('Browser Epicenter page disconnected'),
	): Promise<void> {
		markTerminal(cause);
		return performDisconnect();
	}

	/**
	 * Enter the terminal state. The page leaving IS the store closing: there is
	 * no other connection whose presence could keep SQLite open, so ownership is
	 * always released here and the Web Lock is free for the next page.
	 */
	function markTerminal(cause: Error): void {
		if (isDisconnected) return;
		isDisconnected = true;
		terminalCause = cause;
		for (const [transportId, pending] of transports) {
			cancelTransport(transportId, pending.transportKey);
			pending.reject(cause);
		}
		transports.clear();
		syncAttachment = undefined;
		for (const documentId of [...documents.keys()])
			void closeDocument(documentId);
		const lifecycle = storeLifecycle;
		storeClosure = {
			lifecycle,
			drain: lifecycle?.store === undefined ? Promise.resolve() : requestTail,
		};
		lifecycle?.controller.abort(storeClosingError());
		notifySyncCredentials();
	}

	function performDisconnect(): Promise<void> {
		disconnection ??= finishDisconnect();
		return disconnection;
	}

	function requireConnected(): void {
		if (!isDisconnected) return;
		throw terminalCause ?? new Error('Browser Epicenter page disconnected');
	}

	async function finishDisconnect(): Promise<void> {
		const failures = await settleDocumentClosures();
		if (storeClosure !== undefined) {
			// Store acquisition owns an AbortSignal and is safe to terminate outside
			// the local queue. Once opened, SQLite and document operations must finish
			// before their store is disposed.
			await storeClosure.drain;
			failures.push(...(await disposeStore(storeClosure.lifecycle)));
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Browser page cleanup failed');
		}
	}

	async function disposeStore(
		lifecycle: StoreLifecycle | undefined,
	): Promise<unknown[]> {
		const failures = await settleDocumentClosures();
		if (lifecycle === undefined) return failures;
		lifecycle.disposal ??= disposeStoreLifecycle(lifecycle);
		failures.push(...(await lifecycle.disposal));
		return failures;
	}

	async function disposeStoreLifecycle(
		lifecycle: StoreLifecycle,
	): Promise<unknown[]> {
		const failures: unknown[] = [];
		lifecycle.controller.abort(storeClosingError());
		// The page terminates its dedicated worker as soon as disconnect returns.
		// Let the abort-aware opener finish releasing any partially acquired
		// lease or database before acknowledging that terminal request.
		if (lifecycle.store === undefined) {
			try {
				await lifecycle.ready;
			} catch {
				// Opening failure is returned to its original RPC. This cleanup
				// path only owns resources the opener managed to publish.
			}
		}
		const store = lifecycle.store;
		if (store === undefined) return failures;
		const stopReplica = lifecycle.stopReplicaSubscription;
		lifecycle.stopReplicaSubscription = undefined;
		const stopStatus = lifecycle.stopSyncStatusSubscription;
		lifecycle.stopSyncStatusSubscription = undefined;
		try {
			stopReplica?.();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			stopStatus?.();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			await store.dispose();
		} catch (cause) {
			failures.push(cause);
		}
		return failures;
	}

	async function executeLocal(operation: BrowserOperation): Promise<unknown> {
		if (operation.kind === 'disconnect') {
			await disconnect();
			return undefined;
		}
		requireConnected();
		if (operation.kind === 'attach-sync') {
			throw new Error('Sync attachment cannot run as a local RPC');
		}
		const store = await openedStore();
		requireConnected();
		switch (operation.kind) {
			case 'open':
				return undefined;
			case 'table-create':
				return tableLens(store.epicenter, operation.definition).create(
					operation.fields,
				);
			case 'table-get':
				return tableLens(store.epicenter, operation.definition).get(
					operation.address.rowId,
				);
			case 'table-update':
				return tableLens(store.epicenter, operation.definition).update(
					operation.address.rowId,
					operation.patch,
				);
			case 'table-delete':
				return tableLens(store.epicenter, operation.definition).delete(
					operation.address.rowId,
				);
			case 'table-entries-page':
				return tableLens(store.epicenter, operation.definition)[
					readTableEntriesPage
				](operation.after);
			case 'value-get':
				return valueLens(store.epicenter, operation.definition).get();
			case 'value-set':
				return valueLens(store.epicenter, operation.definition).set(
					operation.value,
				);
			case 'value-unset':
				return valueLens(store.epicenter, operation.definition).unset();
			case 'document-open':
				return openDocument(store.epicenter, operation);
			case 'document-update': {
				const entry = documents.get(operation.documentId);
				if (entry === undefined) throw new Error('Row document is not open');
				applyRowDocumentUpdate(
					entry.document,
					operation.update,
					documentRpcOrigin,
				);
				return undefined;
			}
			case 'document-pull': {
				const entry = documents.get(operation.documentId);
				if (entry === undefined) throw new Error('Row document is not open');
				return entry.document.pull();
			}
			case 'document-issue': {
				const entry = documents.get(operation.documentId);
				if (entry === undefined) throw new Error('Row document is not open');
				return entry.document.syncIssue();
			}
			case 'document-close':
				await closeDocument(operation.documentId);
				return undefined;
			case 'sync-credentials': {
				if (syncAttachment?.transportKey !== operation.transportKey) {
					return undefined;
				}
				syncAttachment.hasCredentials = operation.hasCredentials;
				notifySyncCredentials();
				return undefined;
			}
			default:
				return operation satisfies never;
		}
	}

	async function attachSync(
		operation: Extract<BrowserOperation, { kind: 'attach-sync' }>,
	): Promise<Awaited<ReturnType<Epicenter['attachSync']>>> {
		const store = await serializeLocal(async () => {
			requireConnected();
			const opened = await openedStore();
			requireConnected();
			const accepted = opened.replica.attach({
				deploymentId: operation.deploymentId,
				principalId: operation.principalId,
			});
			if (accepted.error !== null) return { accepted, opened };
			const previousTransportKey = syncAttachment?.transportKey;
			syncAttachment = {
				transportKey: operation.transportKey,
				hasCredentials: operation.hasCredentials,
				canPublishDocuments: operation.canPublishDocuments,
				canPullDocuments: operation.canPullDocuments,
			};
			if (previousTransportKey !== undefined) {
				retireAttachment(previousTransportKey);
			}
			return { accepted, opened };
		});
		if (store.accepted.error !== null) return store.accepted;
		try {
			const attached = await store.opened.epicenter.attachSync({
				deploymentId: operation.deploymentId,
				principalId: operation.principalId,
				exchange: exchangeThroughPage,
				publishDocument: async ({ address, update }) => {
					const response = await callSyncTransport({
						kind: 'document-publish',
						address,
						update: new Uint8Array(update),
					});
					if (response.kind !== 'document-publish') {
						throw new Error(
							'Browser sync transport answered the wrong request',
						);
					}
					return response.outcome;
				},
				pullDocument: async ({ address, sinceVersion }) => {
					const response = await callSyncTransport({
						kind: 'document-pull',
						address,
						sinceVersion,
					});
					if (response.kind !== 'document-pull') {
						throw new Error(
							'Browser sync transport answered the wrong request',
						);
					}
					return response.response;
				},
				credentials: syncCredentials,
			});
			if (isDisconnected) {
				throw new Error('Browser Epicenter page disconnected');
			}
			if (attached.error !== null) {
				retireAttachment(operation.transportKey);
			}
			return attached;
		} catch (cause) {
			retireAttachment(operation.transportKey);
			throw cause;
		}
	}

	async function openDocument(
		epicenter: Epicenter,
		operation: Extract<BrowserOperation, { kind: 'document-open' }>,
	): Promise<{ documentId: number; update: Uint8Array }> {
		const lens = tableLens(epicenter, operation.definition);
		const document = await lens.openDocument(operation.address.rowId);
		if (isDisconnected) {
			try {
				await trackDocumentClosure(document);
			} catch (cause) {
				log.error(new Error('Late browser document cleanup failed', { cause }));
				throw cause;
			}
			requireConnected();
		}
		const documentId = ++nextDocumentId;
		let stopUpdates: (() => void) | undefined;
		try {
			stopUpdates = observeRowDocumentUpdates(document, (update) => {
				send({
					type: 'document-update',
					documentId,
					update: new Uint8Array(update),
				});
			});
			const update = encodeRowDocumentState(document);
			documents.set(documentId, {
				address: operation.address,
				document,
				stopUpdates,
			});
			return { documentId, update };
		} catch (cause) {
			stopUpdates?.();
			await trackDocumentClosure(document);
			throw cause;
		}
	}

	function callTransport(
		transportKey: number,
		request: SessionTransportRequest,
	): Promise<SessionTransportResponse> {
		const transportId = ++nextTransportId;
		return new Promise<SessionTransportResponse>((resolve, reject) => {
			// A page-owned fetch can hang forever. Fail the exchange and let the
			// sync supervisor decide about retrying; there is no second transport
			// to fall back to, so failing fast is the whole policy.
			const timeout = setTimeout(() => {
				if (!transports.delete(transportId)) return;
				cancelTransport(transportId, transportKey);
				reject(new Error('Browser sync transport timed out'));
			}, exchangeTimeoutMs);
			transports.set(transportId, {
				transportKey,
				resolve(value) {
					clearTimeout(timeout);
					resolve(value);
				},
				reject(cause) {
					clearTimeout(timeout);
					reject(cause);
				},
			});
			if (
				!send({ type: 'transport-request', transportId, transportKey, request })
			) {
				clearTimeout(timeout);
				transports.delete(transportId);
				reject(new Error('Browser Epicenter page port failed'));
			}
		});
	}

	function handleTransportResult(message: BrowserTransportResult): void {
		const pending = transports.get(message.transportId);
		if (pending === undefined) return;
		// A result minted under a superseded attachment is not an answer to the
		// current one.
		if (pending.transportKey !== message.transportKey) return;
		transports.delete(message.transportId);
		if (message.type === 'transport-result') {
			pending.resolve(message.response);
			return;
		}
		const cause = new Error(message.message);
		cause.name = message.name;
		pending.reject(cause);
	}

	port.addEventListener('message', ({ data: message }) => {
		if (isDisconnected) return;
		if (
			message.type === 'transport-result' ||
			message.type === 'transport-error'
		) {
			handleTransportResult(message);
			return;
		}
		const respond = async (): Promise<void> => {
			try {
				const value =
					message.operation.kind === 'attach-sync'
						? await attachSync(message.operation)
						: await executeLocal(message.operation);
				if (!isDisconnected || message.operation.kind === 'disconnect') {
					send(
						{ type: 'result', id: message.id, value },
						{ afterDisconnect: message.operation.kind === 'disconnect' },
					);
				}
			} catch (cause) {
				if (!isDisconnected || message.operation.kind === 'disconnect') {
					const delivered = send(
						{
							type: 'error',
							id: message.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						},
						{ afterDisconnect: message.operation.kind === 'disconnect' },
					);
					if (!delivered && message.operation.kind === 'disconnect') {
						log.error(
							new Error('Browser disconnect result was unreachable', { cause }),
						);
					}
				}
			}
		};
		if (
			message.operation.kind === 'attach-sync' ||
			message.operation.kind === 'disconnect' ||
			// A pull awaits the network through the page transport; running it on
			// the local queue would stall every SQLite RPC behind it. The document
			// runtime owns pull overlap and disposal safety.
			message.operation.kind === 'document-pull'
		) {
			void respond();
			return;
		}
		void serializeLocal(respond);
	});
	port.start?.();
}

function storeClosingError(cause?: unknown): Error {
	return new Error('Browser Epicenter store opening was aborted', { cause });
}

let sqliteModule: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let sahPool: SAHPoolUtil | undefined;

async function openBrowserWorkerStore({
	signal,
}: {
	signal: AbortSignal;
}): Promise<BrowserWorkerStore> {
	let lease: BrowserStorageLease | undefined;
	let rawDatabase: Database | undefined;
	let pool: SAHPoolUtil | undefined;
	try {
		signal.throwIfAborted();
		lease = await acquireBrowserStorageLease(
			navigator.locks as unknown as LockManagerPort,
			{ signal },
		);
		signal.throwIfAborted();
		sqliteModule ??= await sqlite3InitModule();
		signal.throwIfAborted();
		const openedPool = await acquireSahPool(sqliteModule);
		pool = openedPool;
		signal.throwIfAborted();
		rawDatabase = new openedPool.OpfsSAHPoolDb('/epicenter-data.sqlite3');
		rawDatabase.exec(`
			PRAGMA busy_timeout = 5000;
			PRAGMA journal_mode = DELETE;
			PRAGMA synchronous = EXTRA;
			PRAGMA temp_store = MEMORY;
		`);
		const database = createBrowserSqliteAdapter(
			rawDatabase as unknown as BrowserSqliteDatabase,
		);
		const opened = openReplica({ database });
		if (opened.error !== null) throw opened.error;
		signal.throwIfAborted();
		const epicenter = createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase?.close(),
		});
		return {
			epicenter,
			replica: opened.data,
			async dispose() {
				await settleBrowserCleanup({
					stages: [
						() => epicenter[Symbol.asyncDispose](),
						() => openedPool.pauseVfs(),
						() => lease?.release(),
					],
					message: 'Browser store cleanup failed',
				});
			},
		};
	} catch (cause) {
		await settleBrowserCleanup({
			initialFailures: [cause],
			stages: [
				() => rawDatabase?.close(),
				() => pool?.pauseVfs(),
				() => lease?.release(),
			],
			message: 'Browser store opening and cleanup failed',
		});
		throw cause;
	}
}

async function acquireSahPool(
	module: Awaited<ReturnType<typeof sqlite3InitModule>>,
): Promise<SAHPoolUtil> {
	if (sahPool !== undefined) {
		return sahPool.isPaused() ? sahPool.unpauseVfs() : sahPool;
	}
	let lastFailure: unknown;
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			sahPool = await module.installOpfsSAHPoolVfs({
				name: 'epicenter-data',
				directory: '.epicenter-data-sahpool',
			});
			return sahPool;
		} catch (cause) {
			lastFailure = cause;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(
		`Browser Epicenter storage is unavailable: ${
			lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
		}`,
		{ cause: lastFailure },
	);
}

export type { MessagePortLike };
