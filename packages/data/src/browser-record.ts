import * as Y from '@y/y';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type {
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
	type RecordInspection,
} from './record-epicenter.js';
import type {
	ReplicaAttachment,
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
	const syncStatusListeners = new Set<
		(status: BrowserRecordSyncStatus) => void
	>();
	const documents = new Map<string, Set<PageDocument>>();
	const revokedAddresses = new Set<string>();
	const seenTokens = new Set<string>();
	const seenTokenOrder: string[] = [];
	let nextRequestId = 0;
	let workerFailure: Error | undefined;
	let isDisposing = false;
	let isDisposed = false;
	let disposalPromise: Promise<void> | undefined;
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
				for (const listener of syncStatusListeners) {
					try {
						listener(structuredClone(message.status));
					} catch (cause) {
						log.error(new Error('Sync status subscriber threw', { cause }));
					}
				}
				return;
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
		await request({ kind: 'open' });
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
		let acceptedUpdateDepth = 0;
		const revocationListeners = new Set<(error: Error) => void>();
		let persistenceTail = Promise.resolve();

		function requireUsable(): void {
			if (isHandleDisposed) throw new Error('Row document handle is disposed');
			if (revoked !== undefined) throw revoked;
		}

		function queueDocumentOperation(operation: BrowserRecordOperation): void {
			persistenceTail = persistenceTail.then(async () => {
				await sendRequest(operation);
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

		const entry: PageDocument = {
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

	function dispose(): Promise<void> {
		disposalPromise ??= performDispose();
		return disposalPromise;
	}

	async function performDispose(): Promise<void> {
		if (isDisposed) return;
		isDisposing = true;
		const failures: unknown[] = [];
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
		async attachment(): Promise<ReplicaAttachmentState> {
			return (await request({ kind: 'attachment' })).attachment;
		},
		async prepareAttachment(
			attachment: ReplicaAttachment,
			firstAttachmentChoice?: 'bring' | 'discard',
		): Promise<{ attached: boolean; discarded: boolean }> {
			const result = await request({
				kind: 'prepare-attachment',
				attachment,
				...(firstAttachmentChoice === undefined
					? {}
					: { firstAttachmentChoice }),
			});
			return { attached: result.attached, discarded: result.discarded };
		},
		async syncStatus(): Promise<BrowserRecordSyncStatus> {
			return (await request({ kind: 'sync-status' })).status;
		},
		subscribeSyncStatus(listener: (status: BrowserRecordSyncStatus) => void) {
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
	});
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
