import * as Y from '@y/y';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type {
	BrowserRecordAuthorityOperation,
	BrowserRecordAuthorityResult,
	BrowserRecordCandidateStart,
	BrowserRecordOperation,
	BrowserRecordResult,
	BrowserRecordSyncStatus,
	BrowserRecordWorkerInbound,
	BrowserRecordWorkerMessage,
} from './browser-record/protocol.js';
import type { RowDocument } from './documents.js';
import type { LensDefinition } from './lens.js';
import type { RecordAddress } from './protocol/v1/index.js';
import { registerRecordDocumentConnectionTarget } from './record-document-connection.js';
import {
	type BoundLenses,
	createRecordLensRuntime,
	type RecordEpicenter,
	type RecordInspection,
} from './record-epicenter.js';
import {
	RecordAuthorityLifetimeMismatchError,
	type RecordSyncSession,
	type RecordSyncStatus,
} from './record-sync-supervisor.js';
import type {
	ReplicaAttachmentState,
	ReplicaParkedWorkPage,
} from './store/replica/index.js';

type PendingRequest = {
	resolve(result: BrowserRecordResult): void;
	reject(cause: unknown): void;
};

type PageDocument = {
	refresh(update?: Uint8Array): void;
	revoke(message: string): void;
	dispose(): Promise<void>;
};

type PageAuthorityCall = {
	transportKey: number;
	ownerSession: string;
	ownerGeneration: number;
};

export type BrowserRecordClientWorker = {
	postMessage(message: BrowserRecordWorkerInbound): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserRecordWorkerMessage }) => void,
	): void;
	addEventListener(
		type: 'error',
		listener: (event: { message?: string }) => void,
	): void;
	terminate(): void;
};

type OpenBrowserRecordEpicenterTestOptions = {
	createWorker?(): BrowserRecordClientWorker;
	coordinationId?: string;
	storage?: BrowserRecordCandidateStart['storage'];
	log?: Logger;
};

const remoteDocumentOrigin = Symbol('browser-record-document-remote');

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

/** Open one page's typed Lens client over the origin's worker-owned replica. */
export function openBrowserRecordEpicenter() {
	return openBrowserRecordEpicenterForTest();
}

/** Internal construction seam for the browser adapter's repository tests. */
export async function openBrowserRecordEpicenterForTest({
	createWorker = defaultWorker,
	coordinationId,
	storage,
	log = createLogger('data/browser-record'),
}: OpenBrowserRecordEpicenterTestOptions = {}) {
	const worker = createWorker();
	const pending = new Map<number, PendingRequest>();
	const recordListeners = new Set<
		(addresses: readonly RecordAddress[]) => void
	>();
	const blobListeners = new Set<(address: RecordAddress) => void>();
	const attachmentListeners = new Set<
		(attachment: ReplicaAttachmentState) => void
	>();
	const syncStatusListeners = new Set<(status: RecordSyncStatus) => void>();
	const documents = new Map<string, Set<PageDocument>>();
	const revokedAddresses = new Set<string>();
	const seenTokens = new Set<string>();
	const seenTokenOrder: string[] = [];
	let nextRequestId = 0;
	let workerFailure: Error | undefined;
	let isDisposing = false;
	let isDisposed = false;
	let disposalPromise: Promise<void> | undefined;
	const transports = new Map<number, RecordSyncSession<Blob>>();
	const authorityCalls = new Map<number, PageAuthorityCall>();
	let nextTransportKey = 0;
	let activeTransportKey: number | undefined;
	let stopCredentials: (() => void) | undefined;
	let attachmentCache: ReplicaAttachmentState | undefined;
	let syncStatusCache: RecordSyncStatus | undefined;
	let closeWaiter:
		| {
				promise: Promise<void>;
				resolve(): void;
				reject(cause: unknown): void;
		  }
		| undefined;

	function requireOpen(): void {
		if (isDisposing || isDisposed) {
			throw new Error('Browser record Epicenter is disposed');
		}
		if (workerFailure !== undefined) throw workerFailure;
	}

	function rememberToken(token: string): boolean {
		if (seenTokens.has(token)) return false;
		seenTokens.add(token);
		seenTokenOrder.push(token);
		const expired =
			seenTokenOrder.length > 1_024 ? seenTokenOrder.shift() : undefined;
		if (expired !== undefined) seenTokens.delete(expired);
		return true;
	}

	function sendRequest<TOperation extends BrowserRecordOperation>(
		operation: TOperation,
	): Promise<Extract<BrowserRecordResult, { kind: TOperation['kind'] }>> {
		const id = ++nextRequestId;
		return new Promise((resolve, reject) => {
			pending.set(id, {
				resolve(result) {
					pending.delete(id);
					if (result.kind !== operation.kind) {
						reject(
							new Error(
								`Browser record worker returned '${result.kind}' for '${operation.kind}'`,
							),
						);
						return;
					}
					resolve(
						result as Extract<
							BrowserRecordResult,
							{ kind: TOperation['kind'] }
						>,
					);
				},
				reject(cause) {
					pending.delete(id);
					reject(cause);
				},
			});
			try {
				worker.postMessage({ type: 'request', id, operation });
			} catch (cause) {
				const failure = new Error('Browser record worker port failed', {
					cause,
				});
				pending.get(id)?.reject(failure);
				failWorker(failure);
			}
		});
	}

	function request<TOperation extends BrowserRecordOperation>(
		operation: TOperation,
	): Promise<Extract<BrowserRecordResult, { kind: TOperation['kind'] }>> {
		requireOpen();
		return sendRequest(operation);
	}

	function revokeAllDocuments(message: string): void {
		for (const entries of documents.values()) {
			for (const document of entries) document.revoke(message);
		}
	}

	function failWorker(cause: Error): void {
		if (workerFailure !== undefined) {
			closeWaiter?.reject(workerFailure);
			closeWaiter = undefined;
			return;
		}
		workerFailure = cause;
		try {
			stopCredentials?.();
		} catch (cleanupCause) {
			log.error(
				new Error('Browser authority credential cleanup failed', {
					cause: cleanupCause,
				}),
			);
		}
		stopCredentials = undefined;
		activeTransportKey = undefined;
		transports.clear();
		authorityCalls.clear();
		closeWaiter?.reject(cause);
		closeWaiter = undefined;
		for (const request of [...pending.values()]) request.reject(cause);
		revokeAllDocuments(cause.message);
		try {
			worker.terminate();
		} catch (cleanupCause) {
			log.error(
				new Error('Browser record port cleanup failed', {
					cause: cleanupCause,
				}),
			);
		}
	}

	async function closeWorker(): Promise<void> {
		if (workerFailure !== undefined) return;
		let resolve!: () => void;
		let reject!: (cause: unknown) => void;
		const promise = new Promise<void>((onResolve, onReject) => {
			resolve = onResolve;
			reject = onReject;
		});
		closeWaiter = { promise, resolve, reject };
		try {
			worker.postMessage({ type: 'close' });
		} catch (cause) {
			closeWaiter = undefined;
			reject(cause);
		}
		await promise;
	}

	async function refreshDocuments(address: RecordAddress): Promise<void> {
		const entries = documents.get(addressKey(address));
		if (entries === undefined || entries.size === 0) return;
		try {
			const result = await request({ kind: 'export-document', address });
			if (result.recordState === 'not-openable') return;
			for (const document of [...entries]) document.refresh(result.update);
		} catch (cause) {
			if (workerFailure !== undefined || isDisposing || isDisposed) return;
			if (revokedAddresses.has(addressKey(address))) return;
			log.error(new Error('Browser record document refresh failed', { cause }));
		}
	}

	function deserializeSyncStatus(
		status: BrowserRecordSyncStatus,
	): RecordSyncStatus {
		const lastError =
			status.lastError === undefined
				? undefined
				: Object.assign(new Error(status.lastError.message), {
						name: status.lastError.name,
					});
		return {
			state: status.state,
			work: structuredClone(status.work),
			...(status.authorityLifetime === undefined
				? {}
				: { authorityLifetime: status.authorityLifetime }),
			...(lastError === undefined ? {} : { lastError }),
		};
	}

	function postControl(message: BrowserRecordWorkerInbound): void {
		try {
			worker.postMessage(message);
		} catch (cause) {
			failWorker(new Error('Browser record worker port failed', { cause }));
		}
	}

	async function executeAuthority(
		operation: BrowserRecordAuthorityOperation,
		transport: RecordSyncSession<Blob>['transport'],
	): Promise<BrowserRecordAuthorityResult> {
		switch (operation.kind) {
			case 'read-facts':
				return {
					kind: 'read-facts',
					response: await transport.readFacts(operation.request),
				};
			case 'submit':
				return {
					kind: 'submit',
					response: await transport.submit(operation.request),
				};
			case 'publish-document':
				return {
					kind: 'publish-document',
					acceptance: await transport.publishDocument(operation.request),
				};
			case 'publish-blob':
				return {
					kind: 'publish-blob',
					acceptance: await transport.publishBlob({
						request: operation.request,
						bytes: operation.bytes,
					}),
				};
			default:
				return operation satisfies never;
		}
	}

	function runAuthorityRequest(
		message: Extract<BrowserRecordWorkerMessage, { type: 'authority-request' }>,
	): void {
		const transport = transports.get(message.transportKey)?.transport;
		if (transport === undefined) {
			postControl({
				type: 'authority-error',
				authorityId: message.authorityId,
				transportKey: message.transportKey,
				ownerSession: message.ownerSession,
				ownerGeneration: message.ownerGeneration,
				code: 'transport-unavailable',
			});
			return;
		}
		const call: PageAuthorityCall = {
			transportKey: message.transportKey,
			ownerSession: message.ownerSession,
			ownerGeneration: message.ownerGeneration,
		};
		authorityCalls.set(message.authorityId, call);
		void executeAuthority(message.operation, transport).then(
			(result) => {
				if (authorityCalls.get(message.authorityId) !== call) return;
				authorityCalls.delete(message.authorityId);
				postControl({
					type: 'authority-result',
					authorityId: message.authorityId,
					transportKey: message.transportKey,
					ownerSession: message.ownerSession,
					ownerGeneration: message.ownerGeneration,
					result,
				});
			},
			(cause: unknown) => {
				if (authorityCalls.get(message.authorityId) !== call) return;
				authorityCalls.delete(message.authorityId);
				postControl({
					type: 'authority-error',
					authorityId: message.authorityId,
					transportKey: message.transportKey,
					ownerSession: message.ownerSession,
					ownerGeneration: message.ownerGeneration,
					...(cause instanceof RecordAuthorityLifetimeMismatchError
						? {
								code: 'lifetime-mismatch' as const,
								activeAuthorityLifetime: cause.activeAuthorityLifetime,
							}
						: { code: 'transport-failed' as const }),
				});
			},
		);
	}

	worker.addEventListener('message', ({ data: message }) => {
		switch (message.type) {
			case 'result':
				pending.get(message.id)?.resolve(message.result);
				return;
			case 'error': {
				const cause = new Error(message.message);
				cause.name = message.name;
				pending.get(message.id)?.reject(cause);
				return;
			}
			case 'records-invalidated':
				if (!rememberToken(message.token)) return;
				for (const listener of recordListeners) {
					try {
						listener(structuredClone(message.addresses));
					} catch (cause) {
						log.error(new Error('Data subscriber threw', { cause }));
					}
				}
				for (const address of message.addresses) void refreshDocuments(address);
				return;
			case 'blob-invalidated':
				if (!rememberToken(message.token)) return;
				for (const listener of blobListeners) {
					try {
						listener(structuredClone(message.address));
					} catch (cause) {
						log.error(new Error('Blob subscriber threw', { cause }));
					}
				}
				return;
			case 'address-revoked': {
				if (!rememberToken(message.token)) return;
				const key = addressKey(message.address);
				revokedAddresses.add(key);
				for (const document of documents.get(key) ?? []) {
					try {
						document.revoke(message.message);
					} catch (cause) {
						log.error(
							new Error('Document revocation subscriber threw', { cause }),
						);
					}
				}
				return;
			}
			case 'sync-status':
				if (!rememberToken(message.token)) return;
				syncStatusCache = deserializeSyncStatus(message.status);
				for (const listener of syncStatusListeners) {
					try {
						listener(deserializeSyncStatus(message.status));
					} catch (cause) {
						log.error(new Error('Sync status subscriber threw', { cause }));
					}
				}
				return;
			case 'attachment':
				if (!rememberToken(message.token)) return;
				attachmentCache = structuredClone(message.attachment);
				for (const listener of attachmentListeners) {
					try {
						listener(structuredClone(message.attachment));
					} catch (cause) {
						log.error(new Error('Attachment subscriber threw', { cause }));
					}
				}
				return;
			case 'authority-request':
				runAuthorityRequest(message);
				return;
			case 'authority-cancel': {
				const call = authorityCalls.get(message.authorityId);
				if (
					call?.transportKey === message.transportKey &&
					call.ownerSession === message.ownerSession &&
					call.ownerGeneration === message.ownerGeneration
				)
					authorityCalls.delete(message.authorityId);
				return;
			}
			case 'owner-lost': {
				const cause = new Error(message.message);
				cause.name = message.name;
				failWorker(cause);
				return;
			}
			case 'status':
				return;
			case 'closed':
				closeWaiter?.resolve();
				closeWaiter = undefined;
				return;
			case 'fatal': {
				const cause = new Error(message.message);
				cause.name = message.name;
				failWorker(cause);
				return;
			}
			default:
				message satisfies never;
		}
	});
	worker.addEventListener('error', ({ message }) => {
		failWorker(new Error(message || 'Browser record dedicated worker failed'));
	});
	worker.postMessage({
		type: 'start',
		...(coordinationId === undefined ? {} : { coordinationId }),
		...(storage === undefined ? {} : { storage }),
	});

	try {
		const opened = await request({ kind: 'open' });
		attachmentCache = structuredClone(opened.attachment);
		syncStatusCache = deserializeSyncStatus(opened.syncStatus);
	} catch (cause) {
		isDisposing = true;
		const failures: unknown[] = [];
		try {
			await closeWorker();
		} catch (cleanupCause) {
			failures.push(cleanupCause);
		}
		isDisposed = true;
		for (const unresolved of [...pending.values()]) unresolved.reject(cause);
		recordListeners.clear();
		blobListeners.clear();
		attachmentListeners.clear();
		syncStatusListeners.clear();
		try {
			worker.terminate();
		} catch (cleanupCause) {
			failures.push(cleanupCause);
		}
		if (failures.length > 0) {
			throw new AggregateError(
				[cause, ...failures],
				'Browser record opening and cleanup failed',
			);
		}
		throw cause;
	}

	async function openDocument(address: RecordAddress): Promise<RowDocument> {
		const opened = await request({ kind: 'export-document', address });
		if (opened.recordState !== 'live') {
			throw new Error(
				`Cannot open document for absent record '${address.namespace}/${address.collection}/${address.recordKey}'`,
			);
		}
		requireOpen();
		const document = new Y.Doc({ gc: true });
		let isHandleDisposed = false;
		let revoked: Error | undefined;
		let persistenceFailure: Error | undefined;
		let acceptedUpdateDepth = 0;
		const revocationListeners = new Set<(error: Error) => void>();
		let persistenceTail = Promise.resolve();
		let entry!: PageDocument;

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (revoked !== undefined) throw revoked;
		}

		function queueDocumentOperation(operation: BrowserRecordOperation): void {
			if (persistenceFailure !== undefined) return;
			persistenceTail = persistenceTail
				.then(async () => {
					await sendRequest(operation);
				})
				.catch((cause: unknown) => {
					persistenceFailure =
						cause instanceof Error
							? cause
							: new Error('Browser document persistence failed', { cause });
					entry.revoke(persistenceFailure.message);
					throw persistenceFailure;
				});
		}

		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin || acceptedUpdateDepth > 0) return;
			queueDocumentOperation({
				kind: 'append-local-document-update',
				address,
				update: new Uint8Array(update),
			});
		};
		document.on('updateV2', persist);
		if (opened.update !== undefined) {
			Y.applyUpdateV2(
				document,
				new Uint8Array(opened.update),
				remoteDocumentOrigin,
			);
		}

		const entries =
			documents.get(addressKey(address)) ?? new Set<PageDocument>();
		documents.set(addressKey(address), entries);

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
				document.off('updateV2', persist);
				entries.delete(entry);
				if (entries.size === 0) documents.delete(addressKey(address));
				try {
					await persistenceTail;
				} finally {
					document.destroy();
				}
			},
		};

		entry = {
			refresh(update) {
				if (isHandleDisposed || revoked !== undefined || update === undefined)
					return;
				Y.applyUpdateV2(document, new Uint8Array(update), remoteDocumentOrigin);
			},
			revoke(message) {
				if (revoked !== undefined || isHandleDisposed) return;
				revoked = new Error(message);
				document.off('updateV2', persist);
				for (const listener of revocationListeners) {
					try {
						listener(revoked);
					} catch (cause) {
						log.error(
							new Error('Document revocation subscriber threw', { cause }),
						);
					}
				}
				revocationListeners.clear();
			},
			dispose: handle[Symbol.asyncDispose],
		};
		entries.add(entry);

		registerRecordDocumentConnectionTarget(handle, {
			address: structuredClone(address),
			applyUpdate(update, origin) {
				requireUsable();
				queueDocumentOperation({
					kind: 'install-accepted-document-update',
					address,
					update: new Uint8Array(update),
				});
				acceptedUpdateDepth += 1;
				try {
					Y.applyUpdateV2(document, new Uint8Array(update), origin);
				} finally {
					acceptedUpdateDepth -= 1;
				}
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
		return handle;
	}

	const lenses = createRecordLensRuntime<Blob, Blob>({
		async read(address) {
			return (await request({ kind: 'read', address })).record;
		},
		async readPage(namespace, collection, after, limit) {
			return (
				await request({
					kind: 'read-page',
					namespace,
					collection,
					...(after === undefined ? {} : { after }),
					...(limit === undefined ? {} : { limit }),
				})
			).page;
		},
		async createRecord(namespace, collection, payload) {
			return (
				await request({ kind: 'create-record', namespace, collection, payload })
			).recordKey;
		},
		async createRecordWithBlob(namespace, collection, payload, source) {
			return (
				await request({
					kind: 'create-record-with-blob',
					namespace,
					collection,
					payload,
					bytes: source,
				})
			).recordKey;
		},
		async patchLive(address, patch) {
			return (await request({ kind: 'patch-live', address, patch })).record;
		},
		async tombstoneLive(address) {
			return (await request({ kind: 'tombstone-live', address })).deleted;
		},
		async replace(address, value) {
			await request({ kind: 'replace', address, value });
		},
		async unset(address) {
			await request({ kind: 'unset', address });
		},
		subscribeRecords(listener) {
			recordListeners.add(listener);
			return () => recordListeners.delete(listener);
		},
		openDocument,
		async putBlob(address, source) {
			return (await request({ kind: 'put-blob', address, bytes: source }))
				.digest;
		},
		async readBlob(address) {
			return (await request({ kind: 'read-blob', address })).bytes;
		},
		async inspectBlob(address) {
			return (await request({ kind: 'inspect-blob', address })).inspection;
		},
		subscribeBlobs(listener) {
			blobListeners.add(listener);
			return () => blobListeners.delete(listener);
		},
	});

	function bind<const TLenses extends Record<string, LensDefinition>>(
		definitions: TLenses,
	): BoundLenses<TLenses, Blob, Blob> {
		return lenses.bind(definitions);
	}

	async function attachSync(session: RecordSyncSession<Blob>): Promise<void> {
		requireOpen();
		const transportKey = ++nextTransportKey;
		const hasCredentials =
			session.credentials === undefined ||
			session.credentials.get() !== undefined;
		transports.set(transportKey, session);
		postControl({
			type: 'transport-register',
			transportKey,
			attachment: structuredClone(session.attachment),
			hasCredentials,
		});
		let stopNextCredentials: (() => void) | undefined;
		try {
			stopNextCredentials = session.credentials?.subscribe?.(() => {
				if (!transports.has(transportKey) || isDisposing || isDisposed) return;
				postControl({
					type: 'transport-credentials',
					transportKey,
					hasCredentials: session.credentials?.get() !== undefined,
				});
			});
			const result = await request({
				kind: 'attach-sync',
				transportKey,
				attachment: structuredClone(session.attachment),
				...(session.firstAttachmentChoice === undefined
					? {}
					: { firstAttachmentChoice: session.firstAttachmentChoice }),
			});
			requireOpen();
			attachmentCache = structuredClone(result.attachment);
			syncStatusCache = deserializeSyncStatus(result.syncStatus);
			const previousTransportKey = activeTransportKey;
			const stopPreviousCredentials = stopCredentials;
			activeTransportKey = transportKey;
			stopCredentials = stopNextCredentials;
			stopNextCredentials = undefined;
			if (previousTransportKey !== undefined) {
				transports.delete(previousTransportKey);
			}
			stopPreviousCredentials?.();
		} catch (cause) {
			transports.delete(transportKey);
			postControl({ type: 'transport-unregister', transportKey });
			const previous =
				activeTransportKey === undefined
					? undefined
					: transports.get(activeTransportKey);
			if (previous !== undefined && activeTransportKey !== undefined) {
				postControl({
					type: 'transport-register',
					transportKey: activeTransportKey,
					attachment: structuredClone(previous.attachment),
					hasCredentials:
						previous.credentials === undefined ||
						previous.credentials.get() !== undefined,
				});
			}
			stopNextCredentials?.();
			throw cause;
		}
	}

	function dispose(): Promise<void> {
		disposalPromise ??= performDispose();
		return disposalPromise;
	}

	async function performDispose(): Promise<void> {
		if (isDisposed) return;
		isDisposing = true;
		const failures: unknown[] = [];
		try {
			stopCredentials?.();
		} catch (cause) {
			failures.push(cause);
		}
		stopCredentials = undefined;
		if (activeTransportKey !== undefined) {
			postControl({
				type: 'transport-unregister',
				transportKey: activeTransportKey,
			});
		}
		activeTransportKey = undefined;
		transports.clear();
		authorityCalls.clear();
		for (const result of await Promise.allSettled(
			[...documents.values()].flatMap((entries) =>
				[...entries].map((document) => document.dispose()),
			),
		)) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		try {
			await lenses.dispose();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			await closeWorker();
		} catch (cause) {
			failures.push(cause);
		}
		isDisposed = true;
		for (const unresolved of [...pending.values()]) {
			unresolved.reject(new Error('Browser record Epicenter is disposed'));
		}
		recordListeners.clear();
		blobListeners.clear();
		syncStatusListeners.clear();
		documents.clear();
		revokedAddresses.clear();
		try {
			worker.terminate();
		} catch (cause) {
			failures.push(cause);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Browser record cleanup failed');
		}
	}

	return Object.freeze({
		bind,
		attachSync,
		get attachment(): ReplicaAttachmentState {
			requireOpen();
			if (attachmentCache === undefined) {
				throw new Error('Browser record attachment cache is not initialized');
			}
			return structuredClone(attachmentCache);
		},
		get syncStatus(): RecordSyncStatus {
			requireOpen();
			if (syncStatusCache === undefined) {
				throw new Error('Browser record sync-status cache is not initialized');
			}
			return {
				state: syncStatusCache.state,
				work: structuredClone(syncStatusCache.work),
				...(syncStatusCache.authorityLifetime === undefined
					? {}
					: { authorityLifetime: syncStatusCache.authorityLifetime }),
				...(syncStatusCache.lastError === undefined
					? {}
					: {
							lastError: Object.assign(
								new Error(syncStatusCache.lastError.message),
								{ name: syncStatusCache.lastError.name },
							),
						}),
			};
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
			syncStatusListeners.add(listener);
			return () => syncStatusListeners.delete(listener);
		},
		async parkedWork(after?: RecordAddress): Promise<ReplicaParkedWorkPage> {
			return (
				await request({
					kind: 'parked-work',
					...(after === undefined ? {} : { after }),
				})
			).page;
		},
		async inspectRecord(address: RecordAddress): Promise<RecordInspection> {
			return (await request({ kind: 'inspect-record', address })).inspection;
		},
		[Symbol.asyncDispose]: dispose,
	}) satisfies RecordEpicenter<Blob, Blob>;
}

export type BrowserRecordEpicenter = Awaited<
	ReturnType<typeof openBrowserRecordEpicenter>
>;

function defaultWorker(): BrowserRecordClientWorker {
	const WorkerConstructor = (
		globalThis as {
			Worker?: new (
				url: URL,
				options: { type: 'module'; name: string },
			) => BrowserRecordClientWorker;
		}
	).Worker;
	if (WorkerConstructor === undefined) {
		throw new Error('Worker is required for browser record storage');
	}
	return new WorkerConstructor(
		new URL('./browser-record-worker.ts', import.meta.url),
		{ type: 'module', name: 'epicenter-data-record' },
	);
}
