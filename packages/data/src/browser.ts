import * as Y from '@y/y';
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type {
	BrowserInvalidationSignal,
	BrowserOperation,
	BrowserWorkerInbound,
	BrowserWorkerMessage,
	SerializedTableDefinition,
	SerializedValueDefinition,
} from './browser/protocol.js';
import {
	type ConstrainedUpdate,
	type CreateInputFor,
	compileTableDefinition,
	compileValueDefinition,
	type RowFor,
	type TableDefinition,
	type TableDefinitions,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from './definitions.js';
import { openDesktopEpicenter } from './desktop.js';
import {
	type RowDocument,
	registerRowDocumentConnectionTarget,
} from './documents.js';
import {
	type BoundData,
	createTableReadMethods,
	type Epicenter,
	type EpicenterSyncSession,
	type TableEntriesPage,
	type TableLens,
	type ValueLens,
} from './epicenter.js';
import type { JsonValue } from './protocol/index.js';
import type { SyncStatus } from './sync-supervisor.js';

type PendingRequest = {
	resolve(value: unknown): void;
	reject(cause: unknown): void;
};

type ClientMessagePort = {
	postMessage(message: BrowserWorkerInbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserWorkerMessage }) => void,
	): void;
	start?(): void;
	close?(): void;
};

type RuntimeBroadcastChannel = {
	onmessage: ((event: { data: unknown }) => void) | null;
	postMessage(message: unknown): void;
	close(): void;
};

type PageDocument = {
	apply(update: Uint8Array): void;
	revoke(message: string): void;
	dispose(): Promise<void>;
};

type PageExchange = {
	transportKey: number;
	isCanceled: boolean;
};

export type OpenBrowserEpicenterOptions = {
	createSharedWorker?(): {
		port: ClientMessagePort;
		addEventListener?(
			type: 'error',
			listener: (event: { message?: string }) => void,
		): void;
	};
	createBroadcastChannel?(name: string): RuntimeBroadcastChannel | undefined;
	log?: Logger;
};

const remoteDocumentOrigin = Object.freeze({ kind: 'browser-document-remote' });
const INVALIDATION_CHANNEL = 'epicenter-data-invalidation-v1';

/** Open the page-side proxy for this origin's worker-owned Epicenter replica. */
export async function openBrowserEpicenter({
	createSharedWorker = defaultSharedWorker,
	createBroadcastChannel = defaultBroadcastChannel,
	log = createLogger('data/browser'),
}: OpenBrowserEpicenterOptions = {}): Promise<Epicenter> {
	if (isEpicenterDesktopSurface()) return openDesktopEpicenter();
	const worker = createSharedWorker();
	const port = worker.port;
	const pending = new Map<number, PendingRequest>();
	const tableListeners = new Map<string, Set<(changedIds: string[]) => void>>();
	const valueListeners = new Map<string, Set<() => void>>();
	const documents = new Map<number, PageDocument>();
	const seenInvalidations = new Set<string>();
	const seenOrder: string[] = [];
	const invalidationChannel = createBroadcastChannel(INVALIDATION_CHANNEL);
	const exchanges = new Map<number, EpicenterSyncSession['exchange']>();
	const exchangeTails = new Map<number, Promise<void>>();
	const pendingExchanges = new Map<number, PageExchange>();
	const syncStatusListeners = new Set<(status: SyncStatus) => void>();
	let syncStatus: SyncStatus = { state: 'local', lastError: undefined };
	let stopCredentials: (() => void) | undefined;
	let activeTransportKey: number | undefined;
	let requestId = 0;
	let transportKey = 0;
	let disposalPromise: Promise<void> | undefined;
	const disposalFailures: unknown[] = [];
	let isPortClosed = false;
	let isDisposing = false;
	let isDisposed = false;
	let workerFailure: Error | undefined;

	function closePort(): void {
		if (isPortClosed) return;
		isPortClosed = true;
		port.close?.();
	}

	function requireOpen(): void {
		if (isDisposing || isDisposed)
			throw new Error('Browser Epicenter is disposed');
		if (workerFailure !== undefined) throw workerFailure;
	}

	function sendRequest<TResult>(operation: BrowserOperation): Promise<TResult> {
		const id = ++requestId;
		return new Promise<TResult>((resolve, reject) => {
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
				port.postMessage({ type: 'request', id, operation });
			} catch (cause) {
				const failure = new Error('Browser Epicenter worker port failed', {
					cause,
				});
				pending.get(id)?.reject(failure);
				failWorker(failure);
			}
		});
	}

	function failWorker(cause: Error): void {
		if (workerFailure !== undefined) return;
		workerFailure = cause;
		try {
			stopCredentials?.();
		} catch (cleanupCause) {
			log.error(
				new Error('Browser sync credential cleanup failed', {
					cause: cleanupCause,
				}),
			);
		}
		stopCredentials = undefined;
		activeTransportKey = undefined;
		for (const exchange of pendingExchanges.values())
			exchange.isCanceled = true;
		exchanges.clear();
		for (const request of [...pending.values()]) request.reject(cause);
		for (const document of documents.values()) document.revoke(cause.message);
		try {
			closePort();
		} catch (cleanupCause) {
			log.error(
				new Error('Browser worker port cleanup failed', {
					cause: cleanupCause,
				}),
			);
		}
	}

	function request<TResult>(operation: BrowserOperation): Promise<TResult> {
		requireOpen();
		return sendRequest(operation);
	}

	function rememberInvalidation(token: string): boolean {
		if (seenInvalidations.has(token)) return false;
		seenInvalidations.add(token);
		seenOrder.push(token);
		const expired = seenOrder.length > 1_024 ? seenOrder.shift() : undefined;
		if (expired !== undefined) seenInvalidations.delete(expired);
		return true;
	}

	function notifyInvalidation(signal: BrowserInvalidationSignal): void {
		if (!rememberInvalidation(signal.token)) return;
		if (signal.change.kind === 'table') {
			for (const listener of tableListeners.get(signal.change.key) ?? []) {
				try {
					listener([...signal.change.rowIds]);
				} catch (cause) {
					log.error(
						new Error(`Data subscriber threw: ${extractErrorMessage(cause)}`, {
							cause,
						}),
					);
				}
			}
			return;
		}
		for (const listener of valueListeners.get(signal.change.key) ?? []) {
			try {
				listener();
			} catch (cause) {
				log.error(
					new Error(`Data subscriber threw: ${extractErrorMessage(cause)}`, {
						cause,
					}),
				);
			}
		}
	}

	function proxyExchange(
		message: Extract<BrowserWorkerMessage, { type: 'exchange-request' }>,
	): void {
		if (workerFailure !== undefined) return;
		if (isDisposing) {
			port.postMessage({
				type: 'exchange-error',
				transportId: message.transportId,
				transportKey: message.transportKey,
				name: 'BrowserDisposedError',
				message: 'Browser Epicenter is disposing',
			});
			return;
		}
		if (isDisposed) return;
		const pendingExchange: PageExchange = {
			transportKey: message.transportKey,
			isCanceled: false,
		};
		pendingExchanges.set(message.transportId, pendingExchange);
		const previous =
			exchangeTails.get(message.transportKey) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				if (pendingExchange.isCanceled || isDisposing || isDisposed) return;
				try {
					const exchange = exchanges.get(message.transportKey);
					if (exchange === undefined)
						throw new Error('Sync exchange is not attached');
					const response = await exchange(message.request);
					if (!pendingExchange.isCanceled && !isDisposing && !isDisposed) {
						port.postMessage({
							type: 'exchange-result',
							transportId: message.transportId,
							transportKey: message.transportKey,
							response,
						});
					}
				} catch (cause) {
					if (!pendingExchange.isCanceled && !isDisposing && !isDisposed) {
						port.postMessage({
							type: 'exchange-error',
							transportId: message.transportId,
							transportKey: message.transportKey,
							name: cause instanceof Error ? cause.name : 'Error',
							message: cause instanceof Error ? cause.message : String(cause),
						});
					}
				}
			})
			.finally(() => {
				pendingExchanges.delete(message.transportId);
				if (exchangeTails.get(message.transportKey) === current) {
					exchangeTails.delete(message.transportKey);
				}
			});
		exchangeTails.set(message.transportKey, current);
	}

	port.addEventListener('message', ({ data: message }) => {
		switch (message.type) {
			case 'client-revoked': {
				const cause = new Error(message.message);
				cause.name = message.name;
				failWorker(cause);
				return;
			}
			case 'result':
				pending.get(message.id)?.resolve(message.value);
				return;
			case 'error': {
				const cause = new Error(message.message);
				cause.name = message.name;
				pending.get(message.id)?.reject(cause);
				return;
			}
			case 'invalidation': {
				const signal: BrowserInvalidationSignal = {
					type: 'invalidation',
					token: message.token,
					change: message.change,
				};
				notifyInvalidation(signal);
				if (message.broadcast) invalidationChannel?.postMessage(signal);
				return;
			}
			case 'document-update':
				documents.get(message.documentId)?.apply(message.update);
				return;
			case 'document-revoked':
				documents.get(message.documentId)?.revoke(message.message);
				return;
			case 'sync-status':
				syncStatus = {
					state: message.state,
					lastError:
						message.lastError === undefined
							? undefined
							: new Error(message.lastError),
				};
				for (const listener of syncStatusListeners) listener(syncStatus);
				return;
			case 'exchange-request':
				proxyExchange(message);
				return;
			case 'exchange-cancel':
				{
					const pendingExchange = pendingExchanges.get(message.transportId);
					if (pendingExchange?.transportKey === message.transportKey) {
						pendingExchange.isCanceled = true;
					}
				}
				return;
			case 'exchange-retire':
				for (const [transportId, pendingExchange] of pendingExchanges) {
					if (pendingExchange.transportKey !== message.transportKey) continue;
					pendingExchange.isCanceled = true;
					pendingExchanges.delete(transportId);
				}
				exchangeTails.delete(message.transportKey);
				exchanges.delete(message.transportKey);
				if (activeTransportKey === message.transportKey) {
					activeTransportKey = undefined;
					stopCredentials?.();
					stopCredentials = undefined;
				}
				return;
			default:
				message satisfies never;
		}
	});
	worker.addEventListener?.('error', ({ message }) => {
		const cause = new Error(message || 'Browser Epicenter SharedWorker failed');
		failWorker(cause);
	});
	port.start?.();

	if (invalidationChannel !== undefined) {
		invalidationChannel.onmessage = ({ data }) => {
			if (isInvalidationSignal(data)) notifyInvalidation(data);
		};
	}

	try {
		await request<void>({ kind: 'open' });
	} catch (cause) {
		disposalFailures.push(cause);
		await dispose();
		throw cause;
	}

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
		const serialized = serializeTableDefinition(definition);
		const readEntriesPage = (after?: string) =>
			request<TableEntriesPage<TDefinition>>({
				kind: 'table-entries-page',
				definition: serialized,
				...(after === undefined ? {} : { after }),
			});
		const lens = {
			create(fields: CreateInputFor<TDefinition>) {
				return request<RowFor<TDefinition>>({
					kind: 'table-create',
					definition: serialized,
					fields,
				});
			},
			get(rowId: string) {
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					rowId,
				});
			},
			update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				return request<Awaited<ReturnType<TableLens<TDefinition>['update']>>>({
					kind: 'table-update',
					definition: serialized,
					rowId,
					patch,
				});
			},
			delete(rowId: string) {
				return request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					rowId,
				});
			},
			...createTableReadMethods(readEntriesPage),
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
				return createPageDocument(serialized, rowId);
			},
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const serialized = serializeValueDefinition(definition);
		return Object.freeze({
			get() {
				return request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
				});
			},
			set(value: ValueFor<TDefinition>) {
				return request<void>({
					kind: 'value-set',
					definition: serialized,
					value: value as JsonValue,
				});
			},
			unset() {
				return request<void>({ kind: 'value-unset', definition: serialized });
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
		});
	}

	async function createPageDocument(
		definition: SerializedTableDefinition,
		rowId: string,
	): Promise<RowDocument> {
		const opened = await request<{ documentId: number; update: Uint8Array }>({
			kind: 'document-open',
			definition,
			rowId,
		});
		requireOpen();
		const document = new Y.Doc({ gc: true });
		let isHandleDisposed = false;
		let revoked: Error | undefined;
		const revocationListeners = new Set<(error: Error) => void>();
		let persistenceTail = Promise.resolve();

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (revoked !== undefined) throw revoked;
		}

		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin) return;
			const copied = new Uint8Array(update);
			persistenceTail = persistenceTail.then(() =>
				request<void>({
					kind: 'document-update',
					documentId: opened.documentId,
					update: copied,
				}),
			);
		};
		document.on('updateV2', persist);
		Y.applyUpdateV2(document, opened.update, remoteDocumentOrigin);

		const handle: RowDocument = {
			get: ((...args: Parameters<Y.Doc['get']>) => {
				requireUsable();
				return document.get(...args);
			}) as Y.Doc['get'],
			transact<TValue>(
				callback: (transaction: Y.Transaction) => TValue,
				origin?: unknown,
			): TValue {
				requireUsable();
				return document.transact(callback, origin);
			},
			async whenDurable(): Promise<void> {
				requireUsable();
				await persistenceTail;
				requireUsable();
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				documents.delete(opened.documentId);
				document.off('updateV2', persist);
				const failures: unknown[] = [];
				try {
					await persistenceTail;
				} catch (cause) {
					failures.push(cause);
				}
				try {
					if (!isDisposed && workerFailure === undefined) {
						await sendRequest<void>({
							kind: 'document-close',
							documentId: opened.documentId,
						});
					}
				} catch (cause) {
					failures.push(cause);
				} finally {
					document.destroy();
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) {
					throw new AggregateError(failures, 'Browser document cleanup failed');
				}
			},
		};
		registerRowDocumentConnectionTarget(handle, {
			address: { key: definition.key, rowId },
			applyUpdate(update, origin) {
				requireUsable();
				Y.applyUpdateV2(document, new Uint8Array(update), origin);
			},
			encodeStateVector() {
				requireUsable();
				return new Uint8Array(Y.encodeStateVector(document));
			},
			encodeStateAsUpdate(stateVector) {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(document, stateVector));
			},
			observe(listener) {
				requireUsable();
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
			},
			subscribeRevocation(listener) {
				if (revoked !== undefined) {
					listener(revoked);
					return () => undefined;
				}
				revocationListeners.add(listener);
				return () => revocationListeners.delete(listener);
			},
		});

		// Keep registration and publication in one synchronous turn. If a terminal
		// worker message follows the result task, failWorker() must see and revoke
		// this handle before any later task can use it again.
		documents.set(opened.documentId, {
			apply(update) {
				if (isHandleDisposed || revoked !== undefined) return;
				Y.applyUpdateV2(document, new Uint8Array(update), remoteDocumentOrigin);
			},
			revoke(message) {
				if (revoked !== undefined) return;
				revoked = new Error(message);
				document.off('updateV2', persist);
				for (const listener of revocationListeners) listener(revoked);
				revocationListeners.clear();
			},
			dispose: handle[Symbol.asyncDispose],
		});
		return handle;
	}

	async function attachSync(
		session: EpicenterSyncSession,
	): Promise<Awaited<ReturnType<Epicenter['attachSync']>>> {
		requireOpen();
		const key = ++transportKey;
		exchanges.set(key, session.exchange);
		const stopNextCredentials = session.credentials?.subscribe?.(() => {
			void request<void>({
				kind: 'sync-credentials',
				transportKey: key,
				hasCredentials: session.credentials?.get() !== undefined,
			});
		});
		try {
			const result = await request<
				Awaited<ReturnType<Epicenter['attachSync']>>
			>({
				kind: 'attach-sync',
				transportKey: key,
				deploymentId: session.deploymentId,
				principalId: session.principalId,
				hasCredentials:
					session.credentials === undefined ||
					session.credentials.get() !== undefined,
			});
			if (isDisposing || isDisposed)
				throw new Error('Browser Epicenter is disposed');
			if (result.error !== null) {
				exchanges.delete(key);
				stopNextCredentials?.();
				return result;
			}
			if (!exchanges.has(key))
				throw new Error('Browser sync transport retired while attaching');
			stopCredentials?.();
			if (activeTransportKey !== undefined) {
				exchanges.delete(activeTransportKey);
			}
			activeTransportKey = key;
			stopCredentials = stopNextCredentials;
			return result;
		} catch (cause) {
			exchanges.delete(key);
			stopNextCredentials?.();
			throw cause;
		}
	}

	function dispose(): Promise<void> {
		if (disposalPromise !== undefined) return disposalPromise;
		isDisposing = true;
		try {
			stopCredentials?.();
		} catch (cause) {
			disposalFailures.push(cause);
		}
		stopCredentials = undefined;
		for (const exchange of pendingExchanges.values())
			exchange.isCanceled = true;
		disposalPromise = performDispose();
		return disposalPromise;
	}

	async function performDispose(): Promise<void> {
		const failures: unknown[] = [...disposalFailures];
		const documentResults = await Promise.allSettled(
			[...documents.values()].map((document) => document.dispose()),
		);
		for (const result of documentResults) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		try {
			if (workerFailure === undefined) {
				await sendRequest<void>({ kind: 'disconnect' });
			}
		} catch (cause) {
			failures.push(cause);
		}
		isDisposed = true;
		for (const request of [...pending.values()]) {
			request.reject(new Error('Browser Epicenter is disposed'));
		}
		tableListeners.clear();
		valueListeners.clear();
		exchanges.clear();
		pendingExchanges.clear();
		exchangeTails.clear();
		activeTransportKey = undefined;
		syncStatusListeners.clear();
		documents.clear();
		try {
			invalidationChannel?.close();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			closePort();
		} catch (cause) {
			failures.push(cause);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Browser Epicenter cleanup failed');
		}
	}

	return Object.freeze({
		bind,
		attachSync,
		get syncStatus(): SyncStatus {
			return syncStatus;
		},
		subscribeSyncStatus(listener: (status: SyncStatus) => void) {
			requireOpen();
			syncStatusListeners.add(listener);
			return () => syncStatusListeners.delete(listener);
		},
		[Symbol.asyncDispose]: dispose,
	});
}

export type BrowserEpicenter = Awaited<ReturnType<typeof openBrowserEpicenter>>;

function serializeTableDefinition(
	definition: TableDefinition,
): SerializedTableDefinition {
	const compiled = compileTableDefinition(definition);
	return {
		key: definition.key,
		fields: cloneJson(definition.fields),
		optionalFields: [...compiled.optional],
	};
}

function serializeValueDefinition(
	definition: ValueDefinition,
): SerializedValueDefinition {
	compileValueDefinition(definition);
	return { key: definition.key, value: cloneJson(definition.value) };
}

function cloneJson<TValue>(value: TValue): TValue {
	return JSON.parse(JSON.stringify(value)) as TValue;
}

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

function isInvalidationSignal(
	value: unknown,
): value is BrowserInvalidationSignal {
	if (typeof value !== 'object' || value === null) return false;
	const message = value as Partial<BrowserInvalidationSignal>;
	if (message.type !== 'invalidation' || typeof message.token !== 'string') {
		return false;
	}
	if (typeof message.change !== 'object' || message.change === null)
		return false;
	return (
		(message.change.kind === 'value' &&
			typeof message.change.key === 'string') ||
		(message.change.kind === 'table' &&
			typeof message.change.key === 'string' &&
			Array.isArray(message.change.rowIds) &&
			message.change.rowIds.every((rowId) => typeof rowId === 'string'))
	);
}

function defaultSharedWorker(): {
	port: ClientMessagePort;
	addEventListener(
		type: 'error',
		listener: (event: { message?: string }) => void,
	): void;
} {
	const SharedWorkerConstructor = (
		globalThis as {
			SharedWorker?: new (
				url: URL,
				options: { type: 'module'; name: string },
			) => {
				port: ClientMessagePort;
				addEventListener(
					type: 'error',
					listener: (event: { message?: string }) => void,
				): void;
			};
		}
	).SharedWorker;
	if (SharedWorkerConstructor === undefined) {
		throw new Error('SharedWorker is required for browser Epicenter storage');
	}
	return new SharedWorkerConstructor(
		new URL('./browser-worker.ts', import.meta.url),
		{
			type: 'module',
			name: 'epicenter-data',
		},
	);
}

function defaultBroadcastChannel(
	name: string,
): RuntimeBroadcastChannel | undefined {
	if (typeof BroadcastChannel === 'undefined') return undefined;
	const channel = new BroadcastChannel(name);
	const runtime: RuntimeBroadcastChannel = {
		onmessage: null,
		postMessage(message) {
			channel.postMessage(message);
		},
		close() {
			channel.close();
		},
	};
	channel.onmessage = ({ data }) => runtime.onmessage?.({ data });
	return runtime;
}

export type { ClientMessagePort, RuntimeBroadcastChannel };

function isEpicenterDesktopSurface(): boolean {
	const document = (
		globalThis as {
			document?: { getElementById(id: string): unknown };
		}
	).document;
	return (
		document?.getElementById('epicenter-auth-bootstrap') !== undefined &&
		document?.getElementById('epicenter-auth-bootstrap') !== null
	);
}
