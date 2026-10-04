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
	type ListOptions,
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
};

export type BrowserWorkerStore = {
	epicenter: Epicenter;
	replica: Replica;
	dispose(): Promise<void>;
};

type Client = {
	port: MessagePortLike;
	documents: Map<number, WorkerDocument>;
	transports: Map<
		number,
		{
			resolve(value: unknown): void;
			reject(cause: unknown): void;
		}
	>;
	credentials: Map<
		number,
		{
			hasCredentials: boolean;
			listeners: Set<() => void>;
		}
	>;
};

type WorkerDocument = {
	address: { namespace: string; table: string; rowId: string };
	document: RowDocument;
	stopUpdates(): void;
};

type UntypedTableLens = {
	create(fields: Record<string, unknown>): Promise<unknown>;
	get(rowId: string): Promise<unknown>;
	update(rowId: string, patch: Record<string, unknown>): Promise<unknown>;
	delete(rowId: string): Promise<boolean>;
	list(options?: ListOptions<TableDefinition>): Promise<unknown>;
	openDocument(rowId: string): Promise<RowDocument>;
};

type UntypedValueLens = {
	get(): Promise<unknown>;
	set(value: unknown): Promise<void>;
	unset(): Promise<void>;
};

const documentRpcOrigin = Object.freeze({ kind: 'browser-document-rpc' });

export function createBrowserWorkerHost({
	openStore = openBrowserWorkerStore,
	hostId = crypto.randomUUID(),
}: {
	openStore?: (options: { onStolen(): void }) => Promise<BrowserWorkerStore>;
	hostId?: string;
} = {}) {
	const clients = new Set<Client>();
	let storePromise: Promise<BrowserWorkerStore> | undefined;
	let stopReplicaSubscription: (() => void) | undefined;
	let stopSyncStatusSubscription: (() => void) | undefined;
	let requestTail = Promise.resolve();
	let nextDocumentId = 0;
	let nextTransportId = 0;
	let nextInvalidationId = 0;
	let isStolen = false;

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
							namespace: change.namespace,
							table: change.table,
							rowIds: [change.rowId],
						});
						const row = store.replica.readRow(change);
						if (row.error === null && row.data === undefined) {
							void revokeDocuments(change);
						}
						continue;
					}
					emitInvalidation({
						kind: 'value',
						namespace: change.namespace,
						value: change.value,
					});
				}
			});
			stopSyncStatusSubscription = store.epicenter.subscribeSyncStatus(
				(status) => {
					for (const client of clients) {
						client.port.postMessage({
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
			| {
					kind: 'table';
					namespace: string;
					table: string;
					rowIds: string[];
			  }
			| { kind: 'value'; namespace: string; value: string },
	): void {
		const token = `${hostId}:${++nextInvalidationId}`;
		let broadcaster: Client | undefined;
		for (const client of clients) {
			client.port.postMessage({
				type: 'invalidation',
				token,
				change,
				broadcast: broadcaster === undefined,
			});
			broadcaster ??= client;
		}
	}

	async function revokeDocuments({
		namespace,
		table,
		rowId,
	}: {
		namespace: string;
		table: string;
		rowId: string;
	}): Promise<void> {
		const message = `Row document was revoked because '${namespace}/${table}/${rowId}' is no longer live`;
		for (const client of clients) {
			for (const [documentId, entry] of client.documents) {
				if (
					entry.address.namespace !== namespace ||
					entry.address.table !== table ||
					entry.address.rowId !== rowId
				)
					continue;
				client.port.postMessage({
					type: 'document-revoked',
					documentId,
					message,
				});
				await closeDocument(client, documentId);
			}
		}
	}

	function markStolen(): void {
		if (isStolen) return;
		isStolen = true;
		const cause = storageMovedError();
		for (const client of clients) {
			for (const pending of client.transports.values()) pending.reject(cause);
			client.transports.clear();
		}
		requestTail = requestTail.then(() => disposeStore());
	}

	async function closeDocument(
		client: Client,
		documentId: number,
	): Promise<void> {
		const entry = client.documents.get(documentId);
		if (entry === undefined) return;
		client.documents.delete(documentId);
		entry.stopUpdates();
		await entry.document[Symbol.asyncDispose]();
	}

	async function disconnect(client: Client): Promise<void> {
		for (const documentId of [...client.documents.keys()]) {
			await closeDocument(client, documentId);
		}
		const cause = new Error('Browser Epicenter client disconnected');
		for (const pending of client.transports.values()) pending.reject(cause);
		client.transports.clear();
		client.credentials.clear();
		clients.delete(client);
		if (clients.size === 0) await disposeStore();
	}

	async function disposeStore(): Promise<void> {
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

	async function execute(
		client: Client,
		operation: BrowserOperation,
	): Promise<unknown> {
		if (operation.kind === 'disconnect') {
			await disconnect(client);
			return undefined;
		}
		const store = await openedStore();
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
			case 'table-list':
				return tableLens(store.epicenter, operation.definition).list(
					operation.options as ListOptions<TableDefinition>,
				);
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
			case 'attach-sync':
				client.credentials.set(operation.transportKey, {
					hasCredentials: operation.hasCredentials,
					listeners: new Set(),
				});
				return store.epicenter.attachSync({
					deploymentId: operation.deploymentId,
					principalId: operation.principalId,
					exchange: (request) =>
						exchange(client, operation.transportKey, request),
					credentials: {
						get: () =>
							client.credentials.get(operation.transportKey)?.hasCredentials
								? 'page-owned-credential'
								: undefined,
						subscribe(listener) {
							const credential = client.credentials.get(operation.transportKey);
							if (credential === undefined) return () => undefined;
							credential.listeners.add(listener);
							return () => credential.listeners.delete(listener);
						},
					},
				});
			case 'sync-credentials': {
				const credential = client.credentials.get(operation.transportKey);
				if (credential === undefined) return undefined;
				credential.hasCredentials = operation.hasCredentials;
				for (const listener of credential.listeners) listener();
				return undefined;
			}
			default:
				return operation satisfies never;
		}
	}

	async function openDocument(
		client: Client,
		epicenter: Epicenter,
		operation: Extract<BrowserOperation, { kind: 'document-open' }>,
	): Promise<{ documentId: number; update: Uint8Array }> {
		const lens = tableLens(epicenter, operation.definition);
		const document = await lens.openDocument(operation.rowId);
		const documentId = ++nextDocumentId;
		const stopUpdates = observeRowDocumentUpdates(document, (update) => {
			client.port.postMessage({
				type: 'document-update',
				documentId,
				update: new Uint8Array(update),
			});
		});
		client.documents.set(documentId, {
			address: {
				namespace: operation.definition.namespace,
				table: operation.definition.table,
				rowId: operation.rowId,
			},
			document,
			stopUpdates,
		});
		return { documentId, update: encodeRowDocumentState(document) };
	}

	function exchange(
		client: Client,
		transportKey: number,
		request: ExchangeRequest,
	): Promise<ExchangeResponse> {
		const transportId = ++nextTransportId;
		return new Promise<ExchangeResponse>((resolve, reject) => {
			client.transports.set(transportId, { resolve, reject });
			client.port.postMessage({
				type: 'exchange-request',
				transportId,
				transportKey,
				request,
			});
		});
	}

	function handleExchangeResult(
		client: Client,
		message: BrowserExchangeResult,
	): void {
		const pending = client.transports.get(message.transportId);
		if (pending === undefined) return;
		client.transports.delete(message.transportId);
		if (message.type === 'exchange-result') pending.resolve(message.response);
		else {
			const cause = new Error(message.message);
			cause.name = message.name;
			pending.reject(cause);
		}
	}

	function connect(port: MessagePortLike): void {
		const client: Client = {
			port,
			documents: new Map(),
			transports: new Map(),
			credentials: new Map(),
		};
		clients.add(client);
		port.addEventListener('message', ({ data: message }) => {
			if (
				message.type === 'exchange-result' ||
				message.type === 'exchange-error'
			) {
				handleExchangeResult(client, message);
				return;
			}
			requestTail = requestTail.then(async () => {
				try {
					const value = await execute(client, message.operation);
					port.postMessage({ type: 'result', id: message.id, value });
				} catch (cause) {
					port.postMessage({
						type: 'error',
						id: message.id,
						name: cause instanceof Error ? cause.name : 'Error',
						message: cause instanceof Error ? cause.message : String(cause),
					});
				}
			});
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
	return defineTable({
		namespace: definition.namespace,
		table: definition.table,
		fields,
	});
}

function tableLens(
	epicenter: Epicenter,
	definition: SerializedTableDefinition,
): UntypedTableLens {
	return epicenter.bind({
		tables: { target: deserializeTable(definition) },
		values: {},
	}).tables.target as UntypedTableLens;
}

function valueLens(
	epicenter: Epicenter,
	definition: SerializedValueDefinition,
): UntypedValueLens {
	const valueDefinition = defineValue({
		namespace: definition.namespace,
		value: definition.value,
		schema: definition.schema as TSchema,
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
