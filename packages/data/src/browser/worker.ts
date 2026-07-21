import {
	type BrowserSqliteDatabase,
	createBrowserSqliteAdapter,
} from '@epicenter/sqlite/browser';
import sqlite3InitModule, {
	type Database,
	type SAHPoolUtil,
} from '@sqlite.org/sqlite-wasm';
import type { TSchema } from 'typebox';

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
	terminalCause: Error | undefined;
	livenessSequence: number;
	livenessProbe: ReturnType<typeof setTimeout> | undefined;
	livenessTimeout: ReturnType<typeof setTimeout> | undefined;
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
// MessagePort does not report when its remote page vanishes. A worker-driven
// probe bounds leaked client state without relying on throttled page timers.
// A page whose JavaScript cannot service messages for the entire timeout is
// indistinguishable from a vanished page, so the production grace is generous.
export type BrowserClientLivenessPolicy = {
	probeIntervalMs: number;
	responseTimeoutMs: number;
};

// This fail-closed policy is provisional engineering scaffolding, not an
// accepted browser suspension budget. Physical Safari/mobile evidence and
// product approval must settle the production values before browser rollout.
const PROVISIONAL_CLIENT_LIVENESS_POLICY: BrowserClientLivenessPolicy = {
	probeIntervalMs: 60_000,
	responseTimeoutMs: 5 * 60_000,
};
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createBrowserWorkerHost({
	openStore = openBrowserWorkerStore,
	hostId = crypto.randomUUID(),
	exchangeTimeoutMs = DEFAULT_EXCHANGE_TIMEOUT_MS,
	transportRetirementMs = Math.max(exchangeTimeoutMs * 2, 1_000),
	clientLivenessPolicy = PROVISIONAL_CLIENT_LIVENESS_POLICY,
}: {
	openStore?: (options: { onStolen(): void }) => Promise<BrowserWorkerStore>;
	hostId?: string;
	exchangeTimeoutMs?: number;
	transportRetirementMs?: number;
	clientLivenessPolicy?: BrowserClientLivenessPolicy;
} = {}) {
	const {
		probeIntervalMs: clientLivenessIntervalMs,
		responseTimeoutMs: clientLivenessTimeoutMs,
	} = clientLivenessPolicy;
	if (
		!Number.isSafeInteger(clientLivenessIntervalMs) ||
		clientLivenessIntervalMs < 1 ||
		clientLivenessIntervalMs > MAX_TIMER_DELAY_MS ||
		!Number.isSafeInteger(clientLivenessTimeoutMs) ||
		clientLivenessTimeoutMs < 1 ||
		clientLivenessTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new Error(
			'Browser client liveness intervals must be positive supported timer values',
		);
	}
	const clients = new Set<Client>();
	const documentClosures = new Set<Promise<void>>();
	const syncCredentialListeners = new Set<() => void>();
	let storePromise: Promise<BrowserWorkerStore> | undefined;
	let stopReplicaSubscription: (() => void) | undefined;
	let stopSyncStatusSubscription: (() => void) | undefined;
	let requestTail = Promise.resolve();
	let nextDocumentId = 0;
	let nextTransportId = 0;
	let nextInvalidationId = 0;
	let nextSyncAttachmentOrder = 0;
	let isStolen = false;

	function clearClientLiveness(client: Client): void {
		if (client.livenessProbe !== undefined) {
			clearTimeout(client.livenessProbe);
			client.livenessProbe = undefined;
		}
		if (client.livenessTimeout !== undefined) {
			clearTimeout(client.livenessTimeout);
			client.livenessTimeout = undefined;
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
			client.port.close?.();
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
		setTimeout(() => client.port.close?.(), 0);
		void serializeLocal(async () => {
			try {
				await performDisconnect(client);
			} catch {
				// Page-visible capability cleanup is already complete.
			}
		}).catch(() => undefined);
	}

	function scheduleClientLivenessProbe(client: Client): void {
		clearClientLiveness(client);
		if (client.isDisconnected) return;
		client.livenessProbe = setTimeout(() => {
			client.livenessProbe = undefined;
			const sequence = ++client.livenessSequence;
			if (!sendToClient(client, { type: 'liveness-probe', sequence })) return;
			client.livenessTimeout = setTimeout(() => {
				client.livenessTimeout = undefined;
				reclaimVanishedClient(client, sequence);
			}, clientLivenessTimeoutMs);
		}, clientLivenessIntervalMs);
	}

	function markClientLive(client: Client): void {
		if (client.isDisconnected) return;
		client.livenessSequence += 1;
		scheduleClientLivenessProbe(client);
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

	function openedStore(): Promise<BrowserWorkerStore> {
		if (isStolen) throw storageMovedError();
		storePromise ??= openStore({
			onStolen() {
				markStolen();
			},
		}).then(async (store) => {
			if (isStolen) {
				await store.dispose();
				throw storageMovedError();
			}
			stopReplicaSubscription = store.replica.subscribe((changes) => {
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
			stopSyncStatusSubscription = store.epicenter.subscribeSyncStatus(
				(status) => {
					for (const client of clients) {
						sendToClient(client, {
							type: 'sync-status',
							state: status.state,
							...(status.lastError === undefined
								? {}
								: { lastError: status.lastError.message }),
						});
					}
				},
			);
			return store;
		});
		return storePromise;
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
		await Promise.allSettled(closures);
	}

	function markStolen(): void {
		if (isStolen) return;
		isStolen = true;
		const cause = storageMovedError();
		const connected = [...clients];
		if (connected.length === 0) {
			void serializeLocal(disposeStore).catch(() => undefined);
			return;
		}
		for (const client of connected) {
			scheduleTerminalReclamation(client, cause, true);
		}
	}

	function trackDocumentClosure(document: RowDocument): Promise<void> {
		const closure = Promise.resolve().then(() =>
			document[Symbol.asyncDispose](),
		);
		documentClosures.add(closure);
		void closure.then(
			() => documentClosures.delete(closure),
			() => documentClosures.delete(closure),
		);
		return closure;
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
		entry.stopUpdates();
		const closure = trackDocumentClosure(entry.document);
		client.documents.delete(documentId);
		return closure;
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
		clearClientLiveness(client);
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
		notifySyncCredentials();
	}

	function reclaimVanishedClient(
		client: Client,
		unansweredSequence: number,
	): void {
		if (client.isDisconnected || client.livenessSequence !== unansweredSequence)
			return;
		const cause = new Error('Browser Epicenter client stopped responding');
		cause.name = 'BrowserClientReclaimedError';
		scheduleTerminalReclamation(client, cause, true);
	}

	function performDisconnect(client: Client): Promise<void> {
		client.disconnection ??= finishDisconnect();
		return client.disconnection;
	}

	function requireConnected(client: Client): void {
		if (!client.isDisconnected) return;
		throw (
			client.terminalCause ?? new Error('Browser Epicenter client disconnected')
		);
	}

	async function finishDisconnect(): Promise<void> {
		const documentFailures = await settleDocumentClosures();
		// An in-flight SQLite/openStore operation cannot be preempted safely. Store
		// and lease disposal completes after that serialized operation settles; all
		// page-visible capabilities and membership are already terminal above.
		if (clients.size === 0) await disposeStore();
		if (documentFailures.length > 0) throw documentFailures[0];
	}

	async function disposeStore(): Promise<void> {
		await settleDocumentClosures();
		const opening = storePromise;
		storePromise = undefined;
		if (opening === undefined) return;
		const store = await opening.catch(() => undefined);
		stopReplicaSubscription?.();
		stopReplicaSubscription = undefined;
		stopSyncStatusSubscription?.();
		stopSyncStatusSubscription = undefined;
		await store?.dispose();
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
		const store = await openedStore();
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
			const opened = await openedStore();
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
			await trackDocumentClosure(document);
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
				setTimeout(() => port.close?.(), 0);
			}
			return;
		}
		const client: Client = {
			port,
			documents: new Map(),
			disconnection: undefined,
			isDisconnected: false,
			terminalCause: undefined,
			livenessSequence: 0,
			livenessProbe: undefined,
			livenessTimeout: undefined,
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
			if (message.type === 'worker-health-probe') {
				markClientLive(client);
				sendToClient(client, {
					type: 'worker-health-ack',
					sequence: message.sequence,
				});
				return;
			}
			if (message.type === 'liveness-ack') {
				if (message.sequence === client.livenessSequence)
					markClientLive(client);
				return;
			}
			markClientLive(client);
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
					if (!client.isDisconnected) {
						sendToClient(client, {
							type: 'error',
							id: message.id,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					}
				}
			};
			if (message.operation.kind === 'attach-sync') {
				void respond();
				return;
			}
			void serializeLocal(respond);
		});
		port.start?.();
		scheduleClientLivenessProbe(client);
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

let sqliteModule: Awaited<ReturnType<typeof sqlite3InitModule>> | undefined;
let sahPool: SAHPoolUtil | undefined;

async function openBrowserWorkerStore({
	onStolen,
}: {
	onStolen(): void;
}): Promise<BrowserWorkerStore> {
	let lease: BrowserStorageLease | undefined;
	let rawDatabase: Database | undefined;
	try {
		lease = await acquireBrowserStorageLease(
			navigator.locks as unknown as LockManagerPort,
			{ onStolen },
		);
		sqliteModule ??= await sqlite3InitModule();
		const pool = await acquireSahPool(sqliteModule);
		rawDatabase = new pool.OpfsSAHPoolDb('/epicenter-data.sqlite3');
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
		const epicenter = createEpicenter({
			replica: opened.data,
			database,
			dispose: () => rawDatabase?.close(),
		});
		return {
			epicenter,
			replica: opened.data,
			async dispose() {
				try {
					await epicenter[Symbol.asyncDispose]();
				} finally {
					try {
						pool.pauseVfs();
					} finally {
						await lease?.release();
					}
				}
			},
		};
	} catch (cause) {
		try {
			rawDatabase?.close();
		} finally {
			await lease?.release();
		}
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
