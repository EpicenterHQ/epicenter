import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
import type { TSchema } from 'typebox';
import { createLogger, type Logger } from 'wellcrafted/logger';

import {
	defineTable,
	defineValue,
	optional,
	type TableDefinition,
	type ValueDefinition,
} from '../definitions.js';
import {
	applyRowDocumentUpdate,
	encodeRowDocumentState,
	observeRowDocumentUpdates,
	type RowDocument,
} from '../documents.js';
import {
	createEpicenter,
	type Epicenter,
	type InternalTableLens,
	readTableEntriesPage,
} from '../epicenter.js';
import type { ExchangeRequest, ExchangeResponse } from '../protocol/index.js';
import { openReplica, type Replica } from '../replica/index.js';
import type {
	BrowserExchangeResult,
	BrowserOperation,
	BrowserWorkerInbound,
	BrowserWorkerMessage,
	SerializedTableDefinition,
	SerializedValueDefinition,
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

type Client = {
	port: MessagePortLike;
	documents: Map<number, WorkerDocument>;
	disconnection: Promise<void> | undefined;
	isDisconnected: boolean;
	storeClosure:
		| { lifecycle: StoreLifecycle | undefined; drain: Promise<void> }
		| undefined;
	terminalCause: Error | undefined;
	syncTransportKey: number | undefined;
	syncAttachmentOrder: number;
	syncTransportAvailable: boolean;
	syncTransportRetirement: ReturnType<typeof setTimeout> | undefined;
	transports: Map<
		number,
		{
			transportKey: number;
			resolve(value: unknown): void;
			reject(cause: unknown): void;
		}
	>;
	credentials: Map<
		number,
		{
			hasCredentials: boolean;
		}
	>;
};

type WorkerDocument = {
	address: { key: string; rowId: string };
	document: RowDocument;
	stopUpdates(): void;
};

type StoreLifecycle = {
	token: object;
	controller: AbortController;
	ready: Promise<BrowserWorkerStore>;
	closed: Promise<void>;
	resolveClosed(): void;
	store: BrowserWorkerStore | undefined;
	disposal: Promise<unknown[]> | undefined;
	stopReplicaSubscription: (() => void) | undefined;
	stopSyncStatusSubscription: (() => void) | undefined;
};

type UntypedTableLens = {
	create(fields: Record<string, unknown>): Promise<unknown>;
	get(rowId: string): Promise<unknown>;
	update(rowId: string, patch: Record<string, unknown>): Promise<unknown>;
	delete(rowId: string): Promise<boolean>;
	[readTableEntriesPage](after?: string): Promise<unknown>;
	openDocument(rowId: string): Promise<RowDocument>;
};

type UntypedValueLens = {
	get(): Promise<unknown>;
	set(value: unknown): Promise<void>;
	unset(): Promise<void>;
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

export function createBrowserWorkerHost({
	openStore = openBrowserWorkerStore,
	hostId = crypto.randomUUID(),
	exchangeTimeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS,
	transportRetirementMs = Math.max(exchangeTimeoutMs * 2, 1_000),
	log = createLogger('data/browser-worker'),
}: {
	openStore?: (options: {
		onStolen(): void;
		signal: AbortSignal;
	}) => Promise<BrowserWorkerStore>;
	hostId?: string;
	exchangeTimeoutMs?: number;
	transportRetirementMs?: number;
	log?: Logger;
} = {}) {
	const clients = new Set<Client>();
	const documentClosures = new Set<Promise<void>>();
	const syncCredentialListeners = new Set<() => void>();
	let storeLifecycle: StoreLifecycle | undefined;
	let requestTail = Promise.resolve();
	let nextDocumentId = 0;
	let nextTransportId = 0;
	let nextInvalidationId = 0;
	let nextSyncAttachmentOrder = 0;
	let isStolen = false;

	function logCleanupFailures(message: string, failures: unknown[]): void {
		if (failures.length === 0) return;
		log.error(new AggregateError(failures, message));
	}

	function closePort(port: MessagePortLike): void {
		try {
			port.close?.();
		} catch (cause) {
			log.error(new Error('Browser client port cleanup failed', { cause }));
		}
	}

	function sendToClient(
		client: Client,
		message: BrowserWorkerMessage,
		{ afterDisconnect = false }: { afterDisconnect?: boolean } = {},
	): boolean {
		if (client.isDisconnected && !afterDisconnect) return false;
		try {
			client.port.postMessage(message);
			return true;
		} catch (cause) {
			const failure = new Error('Browser Epicenter client port failed', {
				cause,
			});
			if (client.disconnection === undefined) {
				scheduleTerminalReclamation(client, failure, false);
			}
			closePort(client.port);
			return false;
		}
	}

	function scheduleTerminalReclamation(
		client: Client,
		cause: Error,
		notifyPage: boolean,
	): void {
		if (client.isDisconnected) return;
		if (notifyPage) {
			try {
				client.port.postMessage({
					type: 'client-revoked',
					name: cause.name,
					message: cause.message,
				});
			} catch {
				// Cleanup below owns an unreachable port.
			}
		}
		markClientTerminal(client, cause);
		setTimeout(() => closePort(client.port), 0);
		void (async () => {
			try {
				await performDisconnect(client);
			} catch (cause) {
				log.error(
					new Error('Browser client terminal cleanup failed', { cause }),
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

	function syncClients(): Client[] {
		return [...clients]
			.filter((client) => client.syncTransportKey !== undefined)
			.sort(
				(left, right) =>
					Number(right.syncTransportAvailable) -
						Number(left.syncTransportAvailable) ||
					right.syncAttachmentOrder - left.syncAttachmentOrder,
			);
	}

	function notifySyncCredentials(): void {
		for (const listener of syncCredentialListeners) listener();
	}

	function cancelTransportRetirement(client: Client): void {
		if (client.syncTransportRetirement === undefined) return;
		clearTimeout(client.syncTransportRetirement);
		client.syncTransportRetirement = undefined;
	}

	function cancelExchange(
		client: Client,
		transportId: number,
		transportKey: number,
	): void {
		sendToClient(
			client,
			{
				type: 'exchange-cancel',
				transportId,
				transportKey,
			},
			{ afterDisconnect: true },
		);
	}

	function retireTransportCapability(
		client: Client,
		transportKey: number,
	): void {
		if (client.syncTransportKey === transportKey) {
			cancelTransportRetirement(client);
			client.syncTransportKey = undefined;
			client.syncAttachmentOrder = 0;
			client.syncTransportAvailable = false;
		}
		for (const [transportId, pending] of client.transports) {
			if (pending.transportKey !== transportKey) continue;
			client.transports.delete(transportId);
			cancelExchange(client, transportId, transportKey);
			pending.reject(new Error('Browser sync transport was retired'));
		}
		client.credentials.delete(transportKey);
		sendToClient(client, { type: 'exchange-retire', transportKey });
		notifySyncCredentials();
	}

	function retireSyncTransport(client: Client, transportKey: number): void {
		if (
			client.syncTransportKey !== transportKey ||
			client.syncTransportAvailable
		)
			return;
		retireTransportCapability(client, transportKey);
	}

	function quarantineSyncTransport(client: Client, transportKey: number): void {
		if (client.syncTransportKey !== transportKey) return;
		client.syncTransportAvailable = false;
		client.syncAttachmentOrder = 0;
		// MessagePort has no remote-close event. Retire only the sync capability:
		// the same page may still have a healthy local-data RPC connection.
		client.syncTransportRetirement ??= setTimeout(
			() => retireSyncTransport(client, transportKey),
			transportRetirementMs,
		);
	}

	function markSyncTransportLive(client: Client, transportKey: number): void {
		if (client.syncTransportKey !== transportKey) return;
		cancelTransportRetirement(client);
		client.syncTransportAvailable = true;
		client.syncAttachmentOrder = ++nextSyncAttachmentOrder;
	}

	const syncCredentials = {
		get(): string | undefined {
			return syncClients().some((client) => {
				const key = client.syncTransportKey;
				return key !== undefined && client.credentials.get(key)?.hasCredentials;
			})
				? 'page-owned-credential'
				: undefined;
		},
		subscribe(listener: () => void): () => void {
			syncCredentialListeners.add(listener);
			return () => syncCredentialListeners.delete(listener);
		},
	};

	async function exchangeThroughLiveClient(
		request: ExchangeRequest,
	): Promise<ExchangeResponse> {
		let lastFailure: unknown;
		for (const client of syncClients()) {
			const transportKey = client.syncTransportKey;
			if (transportKey === undefined) continue;
			if (!client.credentials.get(transportKey)?.hasCredentials) continue;
			try {
				const response = await exchange(client, transportKey, request);
				markSyncTransportLive(client, transportKey);
				return response;
			} catch (cause) {
				if (client.syncTransportKey === transportKey) {
					client.syncAttachmentOrder = 0;
				}
				lastFailure = cause;
			}
		}
		throw new Error('No live browser sync transport completed the exchange', {
			cause: lastFailure,
		});
	}

	async function openedStore(client: Client): Promise<BrowserWorkerStore> {
		requireConnected(client);
		if (isStolen) throw storageMovedError();
		const current = storeLifecycle;
		if (current !== undefined) {
			if (!current.controller.signal.aborted) return current.ready;
			await current.closed;
			requireConnected(client);
			return openedStore(client);
		}

		const token = {};
		const controller = new AbortController();
		const closed = Promise.withResolvers<void>();
		const ready = Promise.resolve()
			.then(() =>
				openStore({
					onStolen() {
						markStolen();
					},
					signal: controller.signal,
				}),
			)
			.then(async (store) => {
				if (
					controller.signal.aborted ||
					storeLifecycle?.token !== token ||
					isStolen
				) {
					try {
						await store.dispose();
					} catch (cause) {
						log.error(
							new Error('Late browser store disposal failed', { cause }),
						);
					}
					if (isStolen) throw storageMovedError();
					throw storeClosingError(controller.signal.reason);
				}
				const lifecycle = storeLifecycle;
				if (lifecycle?.token !== token) {
					throw new Error('Browser store lifecycle was replaced while opening');
				}
				let stopReplica: (() => void) | undefined;
				let stopStatus: (() => void) | undefined;
				try {
					stopReplica = store.replica.subscribe((changes) => {
						for (const change of changes) {
							if (change.kind === 'row') {
								emitInvalidation({
									kind: 'table',
									key: change.key,
									rowIds: [change.rowId],
								});
								const row = store.replica.readRow(change.key, change.rowId);
								if (row.error === null && row.data === undefined) {
									void revokeDocuments(change.key, change.rowId);
								}
								continue;
							}
							emitInvalidation({ kind: 'value', key: change.key });
						}
					});
					stopStatus = store.epicenter.subscribeSyncStatus((status) => {
						for (const client of clients) {
							sendToClient(client, {
								type: 'sync-status',
								state: status.state,
								...(status.lastError === undefined
									? {}
									: { lastError: status.lastError.message }),
							});
						}
					});
					if (controller.signal.aborted || storeLifecycle?.token !== token) {
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
		const lifecycle: StoreLifecycle = {
			token,
			controller,
			ready,
			closed: closed.promise,
			resolveClosed: closed.resolve,
			store: undefined,
			disposal: undefined,
			stopReplicaSubscription: undefined,
			stopSyncStatusSubscription: undefined,
		};
		storeLifecycle = lifecycle;
		void ready
			.then(
				() => undefined,
				() => undefined,
			)
			.then(() => {
				if (!controller.signal.aborted && lifecycle.store !== undefined) return;
				if (storeLifecycle?.token === token) storeLifecycle = undefined;
				closed.resolve();
			});
		return ready;
	}

	function emitInvalidation(
		change:
			| { kind: 'table'; key: string; rowIds: string[] }
			| { kind: 'value'; key: string },
	): void {
		const token = `${hostId}:${++nextInvalidationId}`;
		let broadcaster: Client | undefined;
		for (const client of clients) {
			const delivered = sendToClient(client, {
				type: 'invalidation',
				token,
				change,
				broadcast: broadcaster === undefined,
			});
			if (delivered) broadcaster ??= client;
		}
	}

	async function revokeDocuments(key: string, rowId: string): Promise<void> {
		const message = `Row document was revoked because '${key}.${rowId}' is no longer live`;
		const closures: Promise<void>[] = [];
		for (const client of clients) {
			for (const [documentId, entry] of client.documents) {
				if (entry.address.key !== key || entry.address.rowId !== rowId)
					continue;
				sendToClient(client, {
					type: 'document-revoked',
					documentId,
					message,
				});
				closures.push(closeDocument(client, documentId));
			}
		}
		const failures: unknown[] = [];
		for (const result of await Promise.allSettled(closures)) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		logCleanupFailures('Browser document revocation cleanup', failures);
	}

	function markStolen(): void {
		if (isStolen) return;
		isStolen = true;
		const cause = storageMovedError();
		const connected = [...clients];
		if (connected.length === 0) {
			void disposeStore(storeLifecycle).then((failures) => {
				if (failures.length > 0)
					logCleanupFailures('Browser store cleanup', failures);
			});
			return;
		}
		for (const client of connected) {
			scheduleTerminalReclamation(client, cause, true);
		}
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

	function closeDocument(client: Client, documentId: number): Promise<void> {
		const entry = client.documents.get(documentId);
		if (entry === undefined) return Promise.resolve();
		client.documents.delete(documentId);
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
		client: Client,
		cause = new Error('Browser Epicenter client disconnected'),
	): Promise<void> {
		markClientTerminal(client, cause);
		return performDisconnect(client);
	}

	function markClientTerminal(client: Client, cause: Error): void {
		if (client.isDisconnected) return;
		client.isDisconnected = true;
		client.terminalCause = cause;
		cancelTransportRetirement(client);
		for (const [transportId, pending] of client.transports) {
			cancelExchange(client, transportId, pending.transportKey);
			pending.reject(cause);
		}
		client.transports.clear();
		client.credentials.clear();
		client.syncTransportKey = undefined;
		client.syncAttachmentOrder = 0;
		client.syncTransportAvailable = false;
		for (const documentId of [...client.documents.keys()]) {
			void closeDocument(client, documentId);
		}
		clients.delete(client);
		if (clients.size === 0) {
			const lifecycle = storeLifecycle;
			client.storeClosure = {
				lifecycle,
				drain: lifecycle?.store === undefined ? Promise.resolve() : requestTail,
			};
			lifecycle?.controller.abort(storeClosingError());
		}
		notifySyncCredentials();
	}

	function performDisconnect(client: Client): Promise<void> {
		client.disconnection ??= finishDisconnect(client);
		return client.disconnection;
	}

	function requireConnected(client: Client): void {
		if (!client.isDisconnected) return;
		throw (
			client.terminalCause ?? new Error('Browser Epicenter client disconnected')
		);
	}

	async function finishDisconnect(client: Client): Promise<void> {
		const failures = await settleDocumentClosures();
		if (client.storeClosure !== undefined) {
			// Store acquisition owns an AbortSignal and is safe to terminate outside
			// the local queue. Once opened, SQLite and document operations must finish
			// before their shared store is disposed.
			await client.storeClosure.drain;
			failures.push(...(await disposeStore(client.storeClosure.lifecycle)));
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Browser client cleanup failed');
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
		} finally {
			if (storeLifecycle?.token === lifecycle.token) {
				storeLifecycle = undefined;
			}
			lifecycle.resolveClosed();
		}
		return failures;
	}

	async function executeLocal(
		client: Client,
		operation: BrowserOperation,
	): Promise<unknown> {
		if (operation.kind === 'disconnect') {
			await disconnect(client);
			return undefined;
		}
		requireConnected(client);
		if (operation.kind === 'attach-sync') {
			throw new Error('Sync attachment cannot run as a local RPC');
		}
		const store = await openedStore(client);
		requireConnected(client);
		switch (operation.kind) {
			case 'open':
				return undefined;
			case 'table-create':
				return tableLens(store.epicenter, operation.definition).create(
					operation.fields,
				);
			case 'table-get':
				return tableLens(store.epicenter, operation.definition).get(
					operation.rowId,
				);
			case 'table-update':
				return tableLens(store.epicenter, operation.definition).update(
					operation.rowId,
					operation.patch,
				);
			case 'table-delete':
				return tableLens(store.epicenter, operation.definition).delete(
					operation.rowId,
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
				return openDocument(client, store.epicenter, operation);
			case 'document-update': {
				const entry = client.documents.get(operation.documentId);
				if (entry === undefined) throw new Error('Row document is not open');
				applyRowDocumentUpdate(
					entry.document,
					operation.update,
					documentRpcOrigin,
				);
				return undefined;
			}
			case 'document-close':
				await closeDocument(client, operation.documentId);
				return undefined;
			case 'sync-credentials': {
				const credential = client.credentials.get(operation.transportKey);
				if (credential === undefined) return undefined;
				credential.hasCredentials = operation.hasCredentials;
				client.syncTransportAvailable = true;
				cancelTransportRetirement(client);
				if (operation.hasCredentials) {
					client.syncAttachmentOrder = ++nextSyncAttachmentOrder;
				}
				notifySyncCredentials();
				return undefined;
			}
			default:
				return operation satisfies never;
		}
	}

	async function attachSync(
		client: Client,
		operation: Extract<BrowserOperation, { kind: 'attach-sync' }>,
	): Promise<Awaited<ReturnType<Epicenter['attachSync']>>> {
		const store = await serializeLocal(async () => {
			requireConnected(client);
			const opened = await openedStore(client);
			requireConnected(client);
			const accepted = opened.replica.attach({
				deploymentId: operation.deploymentId,
				principalId: operation.principalId,
			});
			if (accepted.error !== null) return { accepted, opened };
			const previousTransportKey = client.syncTransportKey;
			client.credentials.set(operation.transportKey, {
				hasCredentials: operation.hasCredentials,
			});
			client.syncTransportKey = operation.transportKey;
			client.syncAttachmentOrder = ++nextSyncAttachmentOrder;
			client.syncTransportAvailable = true;
			cancelTransportRetirement(client);
			if (previousTransportKey !== undefined) {
				retireTransportCapability(client, previousTransportKey);
			}
			return { accepted, opened };
		});
		if (store.accepted.error !== null) return store.accepted;
		try {
			const attached = await store.opened.epicenter.attachSync({
				deploymentId: operation.deploymentId,
				principalId: operation.principalId,
				exchange: exchangeThroughLiveClient,
				credentials: syncCredentials,
			});
			if (client.isDisconnected) {
				throw new Error('Browser Epicenter client disconnected');
			}
			if (attached.error !== null) {
				retireTransportCapability(client, operation.transportKey);
			}
			return attached;
		} catch (cause) {
			retireTransportCapability(client, operation.transportKey);
			throw cause;
		}
	}

	async function openDocument(
		client: Client,
		epicenter: Epicenter,
		operation: Extract<BrowserOperation, { kind: 'document-open' }>,
	): Promise<{ documentId: number; update: Uint8Array }> {
		const lens = tableLens(epicenter, operation.definition);
		const document = await lens.openDocument(operation.rowId);
		if (client.isDisconnected) {
			try {
				await trackDocumentClosure(document);
			} catch (cause) {
				log.error(new Error('Late browser document cleanup failed', { cause }));
				throw cause;
			}
			requireConnected(client);
		}
		const documentId = ++nextDocumentId;
		let stopUpdates: (() => void) | undefined;
		try {
			stopUpdates = observeRowDocumentUpdates(document, (update) => {
				sendToClient(client, {
					type: 'document-update',
					documentId,
					update: new Uint8Array(update),
				});
			});
			const update = encodeRowDocumentState(document);
			client.documents.set(documentId, {
				address: { key: operation.definition.key, rowId: operation.rowId },
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

	function exchange(
		client: Client,
		transportKey: number,
		request: ExchangeRequest,
	): Promise<ExchangeResponse> {
		const transportId = ++nextTransportId;
		return new Promise<ExchangeResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (!client.transports.delete(transportId)) return;
				cancelExchange(client, transportId, transportKey);
				quarantineSyncTransport(client, transportKey);
				reject(new Error('Browser sync transport timed out'));
			}, exchangeTimeoutMs);
			client.transports.set(transportId, {
				transportKey,
				resolve(value) {
					clearTimeout(timeout);
					resolve(value as ExchangeResponse);
				},
				reject(cause) {
					clearTimeout(timeout);
					reject(cause);
				},
			});
			if (
				!sendToClient(client, {
					type: 'exchange-request',
					transportId,
					transportKey,
					request,
				})
			) {
				clearTimeout(timeout);
				client.transports.delete(transportId);
				quarantineSyncTransport(client, transportKey);
				reject(new Error('Browser Epicenter client port failed'));
			}
		});
	}

	function handleExchangeResult(
		client: Client,
		message: BrowserExchangeResult,
	): void {
		const pending = client.transports.get(message.transportId);
		if (pending === undefined) return;
		if (pending.transportKey !== message.transportKey) return;
		client.transports.delete(message.transportId);
		if (message.type === 'exchange-result') {
			markSyncTransportLive(client, message.transportKey);
			pending.resolve(message.response);
		} else {
			const cause = new Error(message.message);
			cause.name = message.name;
			pending.reject(cause);
		}
	}

	function connect(port: MessagePortLike): void {
		if (isStolen) {
			const cause = storageMovedError();
			try {
				port.postMessage({
					type: 'client-revoked',
					name: cause.name,
					message: cause.message,
				});
			} catch {
				// The refused page is already unreachable.
			} finally {
				setTimeout(() => closePort(port), 0);
			}
			return;
		}
		const client: Client = {
			port,
			documents: new Map(),
			disconnection: undefined,
			isDisconnected: false,
			storeClosure: undefined,
			terminalCause: undefined,
			syncTransportKey: undefined,
			syncAttachmentOrder: 0,
			syncTransportAvailable: false,
			syncTransportRetirement: undefined,
			transports: new Map(),
			credentials: new Map(),
		};
		clients.add(client);
		port.addEventListener('message', ({ data: message }) => {
			if (client.isDisconnected) return;
			if (
				message.type === 'exchange-result' ||
				message.type === 'exchange-error'
			) {
				handleExchangeResult(client, message);
				return;
			}
			const respond = async (): Promise<void> => {
				try {
					const value =
						message.operation.kind === 'attach-sync'
							? await attachSync(client, message.operation)
							: await executeLocal(client, message.operation);
					if (
						!client.isDisconnected ||
						message.operation.kind === 'disconnect'
					) {
						sendToClient(
							client,
							{ type: 'result', id: message.id, value },
							{ afterDisconnect: message.operation.kind === 'disconnect' },
						);
					}
				} catch (cause) {
					if (
						!client.isDisconnected ||
						message.operation.kind === 'disconnect'
					) {
						const delivered = sendToClient(
							client,
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
								new Error('Browser disconnect result was unreachable', {
									cause,
								}),
							);
						}
					}
				}
			};
			if (
				message.operation.kind === 'attach-sync' ||
				message.operation.kind === 'disconnect'
			) {
				void respond();
				return;
			}
			void serializeLocal(respond);
		});
		port.start?.();
	}

	return Object.freeze({ connect });
}

function deserializeTable(
	definition: SerializedTableDefinition,
): TableDefinition {
	const fields: Record<string, TSchema> = {};
	const optionalFields = new Set(definition.optionalFields);
	for (const [name, schema] of Object.entries(definition.fields)) {
		const typedSchema = schema as TSchema;
		fields[name] = optionalFields.has(name)
			? optional(typedSchema)
			: typedSchema;
	}
	return defineTable({ key: definition.key, fields });
}

function tableLens(
	epicenter: Epicenter,
	definition: SerializedTableDefinition,
): UntypedTableLens {
	return epicenter.bind({
		tables: { target: deserializeTable(definition) },
		values: {},
	}).tables.target as InternalTableLens<TableDefinition>;
}

function valueLens(
	epicenter: Epicenter,
	definition: SerializedValueDefinition,
): UntypedValueLens {
	const valueDefinition = defineValue({
		key: definition.key,
		value: definition.value as TSchema,
	}) as ValueDefinition;
	return epicenter.bind({
		tables: {},
		values: { target: valueDefinition },
	}).values.target as UntypedValueLens;
}

function storageMovedError(): Error {
	const cause = new Error('Browser Epicenter storage moved to a newer owner');
	cause.name = 'EpicenterStorageMovedError';
	return cause;
}

function storeClosingError(cause?: unknown): Error {
	return new Error('Browser Epicenter store opening was aborted', { cause });
}

let sqliteModule: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let sahPool: SAHPoolUtil | undefined;

async function openBrowserWorkerStore({
	onStolen,
	signal,
}: {
	onStolen(): void;
	signal: AbortSignal;
}): Promise<BrowserWorkerStore> {
	let lease: BrowserStorageLease | undefined;
	let rawDatabase: Database | undefined;
	let pool: SAHPoolUtil | undefined;
	try {
		signal.throwIfAborted();
		lease = await acquireBrowserStorageLease(
			navigator.locks as unknown as LockManagerPort,
			{ onStolen, signal },
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
