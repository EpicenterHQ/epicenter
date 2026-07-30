import {
	type ConstrainedUpdate,
	type CreateInputFor,
	createInvalidationDispatcher,
	type Lens,
	type RowFor,
	serializeTableDefinition,
	serializeValueDefinition,
	type TableDefinition,
	type TableDefinitions,
	type TableInvalidation,
	type ValueDefinition,
	type ValueDefinitions,
	type ValueFor,
} from '@epicenter/lens';
import * as Y from '@y/y';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type {
	BrowserOperation,
	BrowserWorkerInbound,
	BrowserWorkerMessage,
	SerializedTableDefinition,
	SessionTransportRequest,
	SessionTransportResponse,
} from './browser/protocol.js';
import {
	type DocumentSyncIssue,
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
import type { JsonValue, RowAddress, ValueAddress } from './protocol/index.js';
import type { SyncStatus } from './sync-supervisor.js';
import { describeThrownError } from './thrown-error.js';

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

type PageDocument = {
	apply(update: Uint8Array): void;
	revoke(message: string): void;
	dispose(): Promise<void>;
};

type PageTransport = {
	transportKey: number;
	isCanceled: boolean;
};

type SessionTransports = Pick<
	EpicenterSyncSession,
	'exchange' | 'publishDocument' | 'pullDocument'
>;

export type OpenBrowserEpicenterOptions = {
	createWorker?(): {
		port: ClientMessagePort;
		addEventListener?(
			type: 'error',
			listener: (event: { message?: string }) => void,
		): void;
	};
	log?: Logger;
};

const remoteDocumentOrigin = Object.freeze({ kind: 'browser-document-remote' });

/** Open the page-side proxy for this origin's worker-owned Epicenter replica. */
export async function openBrowserEpicenter({
	createWorker,
	log = createLogger('data/browser'),
}: OpenBrowserEpicenterOptions = {}): Promise<Epicenter> {
	const worker = (createWorker ?? defaultDedicatedWorker)();
	const port = worker.port;
	const pending = new Map<number, PendingRequest>();
	const observation = createInvalidationDispatcher({ log });
	const documents = new Map<number, PageDocument>();
	const transports = new Map<number, SessionTransports>();
	const transportTails = new Map<number, Promise<void>>();
	const pendingTransports = new Map<number, PageTransport>();
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
		for (const transport of pendingTransports.values())
			transport.isCanceled = true;
		transports.clear();
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

	async function callSessionTransport(
		session: SessionTransports,
		request: SessionTransportRequest,
	): Promise<SessionTransportResponse> {
		switch (request.kind) {
			case 'exchange':
				return {
					kind: 'exchange',
					response: await session.exchange(request.request),
				};
			case 'document-publish': {
				if (session.publishDocument === undefined)
					throw new Error('Sync session cannot publish documents');
				return {
					kind: 'document-publish',
					outcome: await session.publishDocument({
						address: request.address,
						update: request.update,
					}),
				};
			}
			case 'document-pull': {
				if (session.pullDocument === undefined)
					throw new Error('Sync session cannot pull documents');
				return {
					kind: 'document-pull',
					response: await session.pullDocument({
						address: request.address,
						sinceVersion: request.sinceVersion,
					}),
				};
			}
			default:
				return request satisfies never;
		}
	}

	function proxyTransport(
		message: Extract<BrowserWorkerMessage, { type: 'transport-request' }>,
	): void {
		if (workerFailure !== undefined) return;
		if (isDisposing) {
			port.postMessage({
				type: 'transport-error',
				transportId: message.transportId,
				transportKey: message.transportKey,
				name: 'BrowserDisposedError',
				message: 'Browser Epicenter is disposing',
			});
			return;
		}
		if (isDisposed) return;
		const pendingTransport: PageTransport = {
			transportKey: message.transportKey,
			isCanceled: false,
		};
		pendingTransports.set(message.transportId, pendingTransport);
		const previous =
			transportTails.get(message.transportKey) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(async () => {
				if (pendingTransport.isCanceled || isDisposing || isDisposed) return;
				try {
					const session = transports.get(message.transportKey);
					if (session === undefined)
						throw new Error('Sync transport is not attached');
					const response = await callSessionTransport(session, message.request);
					if (!pendingTransport.isCanceled && !isDisposing && !isDisposed) {
						port.postMessage({
							type: 'transport-result',
							transportId: message.transportId,
							transportKey: message.transportKey,
							response,
						});
					}
				} catch (cause) {
					if (!pendingTransport.isCanceled && !isDisposing && !isDisposed) {
						port.postMessage({
							type: 'transport-error',
							transportId: message.transportId,
							transportKey: message.transportKey,
							...describeThrownError(cause),
						});
					}
				}
			})
			.finally(() => {
				pendingTransports.delete(message.transportId);
				if (transportTails.get(message.transportKey) === current) {
					transportTails.delete(message.transportKey);
				}
			});
		transportTails.set(message.transportKey, current);
	}

	port.addEventListener('message', ({ data: message }) => {
		switch (message.type) {
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
				observation.deliver(message.changes);
				return;
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
			case 'transport-request':
				proxyTransport(message);
				return;
			case 'transport-cancel':
				{
					const pendingTransport = pendingTransports.get(message.transportId);
					if (pendingTransport?.transportKey === message.transportKey) {
						pendingTransport.isCanceled = true;
					}
				}
				return;
			default:
				message satisfies never;
		}
	});
	worker.addEventListener?.('error', ({ message }) => {
		const cause = new Error(message || 'Browser Epicenter worker failed');
		failWorker(cause);
	});
	port.start?.();

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
	>(lens: Lens<TTables, TValues>): BoundData<TTables, TValues> {
		requireOpen();
		const boundTables = Object.fromEntries(
			Object.entries(lens.tables).map(([table, definition]) => [
				table,
				createTableLens(lens.namespace, table, definition),
			]),
		);
		const boundValues = Object.fromEntries(
			Object.entries(lens.values).map(([value, definition]) => [
				value,
				createValueLens(lens.namespace, value, definition),
			]),
		);
		return Object.freeze({
			tables: Object.freeze(boundTables),
			values: Object.freeze(boundValues),
		}) as BoundData<TTables, TValues>;
	}

	function createTableLens<TDefinition extends TableDefinition>(
		namespace: string,
		table: string,
		definition: TDefinition,
	): TableLens<TDefinition> {
		const serialized = serializeTableDefinition(namespace, table, definition);
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
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['get']>>>({
					kind: 'table-get',
					definition: serialized,
					address,
				});
			},
			update<const TChanges extends Record<string, unknown>>(
				rowId: string,
				patch: TChanges & ConstrainedUpdate<TDefinition, TChanges>,
			) {
				const address = rowAddress(namespace, table, rowId);
				return request<Awaited<ReturnType<TableLens<TDefinition>['update']>>>({
					kind: 'table-update',
					definition: serialized,
					address,
					patch,
				});
			},
			delete(rowId: string) {
				const address = rowAddress(namespace, table, rowId);
				return request<boolean>({
					kind: 'table-delete',
					definition: serialized,
					address,
				});
			},
			...createTableReadMethods(readEntriesPage),
			subscribe(listener: (invalidation: TableInvalidation) => void) {
				requireOpen();
				return observation.subscribeTable(namespace, table, listener);
			},
			openDocument(rowId: string) {
				return createPageDocument(serialized, rowId);
			},
		};
		return Object.freeze(lens) as TableLens<TDefinition>;
	}

	function createValueLens<TDefinition extends ValueDefinition>(
		namespace: string,
		valueName: string,
		definition: TDefinition,
	): ValueLens<TDefinition> {
		const address: ValueAddress = {
			kind: 'value',
			namespace,
			valueName: valueName,
		};
		const serialized = serializeValueDefinition(address, definition);
		return Object.freeze({
			get() {
				return request<Awaited<ReturnType<ValueLens<TDefinition>['get']>>>({
					kind: 'value-get',
					definition: serialized,
					address,
				});
			},
			set(value: ValueFor<TDefinition>) {
				return request<void>({
					kind: 'value-set',
					definition: serialized,
					address,
					value: value as JsonValue,
				});
			},
			unset() {
				return request<void>({
					kind: 'value-unset',
					definition: serialized,
					address,
				});
			},
			subscribe(listener: () => void) {
				requireOpen();
				return observation.subscribeValue(address, listener);
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
			address: rowAddress(definition.namespace, definition.table, rowId),
		});
		requireOpen();
		const document = new Y.Doc({ gc: true });
		let isHandleDisposed = false;
		let revoked: Error | undefined;
		let persistFailure: Error | undefined;
		let persistenceTail = Promise.resolve();

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			// Fail closed: once the worker has missed an edit, letting later
			// edits continue would silently diverge this page from durable
			// state, so the handle refuses further use instead.
			if (persistFailure !== undefined) throw persistFailure;
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
				}).catch((cause) => {
					persistFailure ??= new Error(
						'Row document persistence failed; the handle is closed to protect durable state',
						{ cause },
					);
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
			async pull() {
				requireUsable();
				// The worker owns the pull: overlap safety, the version cache,
				// and the accepted-origin apply all live with the owner document.
				await persistenceTail;
				requireUsable();
				return request<Awaited<ReturnType<RowDocument['pull']>>>({
					kind: 'document-pull',
					documentId: opened.documentId,
				});
			},
			async syncIssue(): Promise<DocumentSyncIssue> {
				requireUsable();
				return request<DocumentSyncIssue>({
					kind: 'document-issue',
					documentId: opened.documentId,
				});
			},
			async [Symbol.asyncDispose](): Promise<void> {
				if (isHandleDisposed) return;
				isHandleDisposed = true;
				documents.delete(opened.documentId);
				document.off('updateV2', persist);
				const failures: unknown[] = [];
				await persistenceTail;
				if (persistFailure !== undefined) failures.push(persistFailure);
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
			address: rowAddress(definition.namespace, definition.table, rowId),
			applyUpdate(update, origin) {
				requireUsable();
				Y.applyUpdateV2(document, new Uint8Array(update), origin);
			},
			encodeStateAsUpdate() {
				requireUsable();
				return new Uint8Array(Y.encodeStateAsUpdateV2(document));
			},
			observe(listener) {
				requireUsable();
				document.on('updateV2', listener);
				return () => document.off('updateV2', listener);
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
		transports.set(key, session);
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
				canPublishDocuments: session.publishDocument !== undefined,
				canPullDocuments: session.pullDocument !== undefined,
			});
			if (isDisposing || isDisposed)
				throw new Error('Browser Epicenter is disposed');
			if (result.error !== null) {
				transports.delete(key);
				stopNextCredentials?.();
				return result;
			}
			if (!transports.has(key))
				throw new Error('Browser sync transport retired while attaching');
			stopCredentials?.();
			if (activeTransportKey !== undefined) {
				transports.delete(activeTransportKey);
			}
			activeTransportKey = key;
			stopCredentials = stopNextCredentials;
			return result;
		} catch (cause) {
			transports.delete(key);
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
		for (const transport of pendingTransports.values())
			transport.isCanceled = true;
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
		observation.clear();
		transports.clear();
		pendingTransports.clear();
		transportTails.clear();
		activeTransportKey = undefined;
		syncStatusListeners.clear();
		documents.clear();
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

function rowAddress(
	namespace: string,
	tableName: string,
	rowId: string,
): RowAddress {
	return { kind: 'row', namespace, tableName, rowId };
}

function defaultDedicatedWorker(): {
	port: ClientMessagePort;
	addEventListener(
		type: 'error',
		listener: (event: { message?: string }) => void,
	): void;
} {
	if (typeof Worker === 'undefined') {
		throw new Error('Worker is required for browser Epicenter storage');
	}
	// Written as a literal `new Worker(new URL('...', import.meta.url), ...)`
	// because that exact syntax is what bundlers pattern-match to compile this
	// worker into its own same-origin asset. Reaching the constructor through
	// any alias still runs, but the build silently degrades to an inlined
	// `data:` module that the desktop host's Content-Security-Policy refuses
	// (ADR-0183), so first paint dies with no message worth reading.
	const worker = new Worker(
		new URL('./browser-dedicated-worker.ts', import.meta.url),
		{
			type: 'module',
			name: 'epicenter-data',
		},
	);
	return {
		port: {
			postMessage: (message) => worker.postMessage(message),
			addEventListener: (type, listener) =>
				worker.addEventListener(type, listener),
			close: () => worker.terminate(),
		},
		addEventListener: (type, listener) =>
			worker.addEventListener(type, listener),
	};
}

export type { ClientMessagePort };
