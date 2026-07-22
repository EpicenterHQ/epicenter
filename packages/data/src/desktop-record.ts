import * as Y from '@y/y';
import { createLogger, type Logger } from 'wellcrafted/logger';

import type {
	DesktopRecordBlobOperationSource,
	DesktopRecordEvent,
	DesktopRecordNativeCapture,
	DesktopRecordOperation,
	DesktopRecordRequest,
	DesktopRecordResponse,
	DesktopRecordResult,
	DesktopRecordSyncStatus,
} from './desktop-record/protocol.js';
import {
	desktopRecordAttachmentUrl,
	desktopRecordUrl,
	EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME,
	isDesktopRecordMutation,
	MAX_RECORD_BLOB_BYTES,
} from './desktop-record/protocol.js';
import type { RowDocument } from './documents.js';
import type { LensDefinition } from './lens.js';
import type { RecordAddress } from './protocol/v1/index.js';
import { registerRecordDocumentConnectionTarget } from './record-document-connection.js';
import {
	type BoundLenses,
	createRecordLensRuntime,
	type RecordInspection,
} from './record-epicenter.js';
import type { RecordSyncStatus } from './record-sync-supervisor.js';
import type {
	FirstAttachmentChoice,
	ReplicaAttachmentState,
	ReplicaParkedWorkPage,
} from './store/replica/index.js';

/** Bytes or one host-owned capture accepted by atomic record creation. */
export type DesktopRecordBlobSource =
	| { kind: 'bytes'; bytes: Blob }
	| DesktopRecordNativeCapture;

export type OpenDesktopRecordEpicenterOptions = {
	baseUrl?: string;
	fetch?: (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => Promise<Response>;
};

type OpenDesktopRecordEpicenterTestOptions =
	OpenDesktopRecordEpicenterOptions & {
		pollIntervalMs?: number;
		requestTimeoutMs?: number;
		log?: Logger;
	};

type PageDocument = {
	refresh(update?: Uint8Array): void;
	revoke(message: string): void;
	dispose(): Promise<void>;
};

const remoteDocumentOrigin = Symbol('desktop-record-document-remote');

class DesktopRecordHostError extends Error {}

function addressKey(address: RecordAddress): string {
	return JSON.stringify([
		address.namespace,
		address.collection,
		address.recordKey,
	]);
}

/** Open one trusted WebView Lens client over the Bun host's record owner. */
export function openDesktopRecordEpicenter(
	options: OpenDesktopRecordEpicenterOptions = {},
) {
	return openDesktopRecordEpicenterForTest(options);
}

/** Internal timing seam for repository tests. */
export async function openDesktopRecordEpicenterForTest({
	baseUrl = defaultOrigin(),
	fetch: fetchInput = globalThis.fetch,
	pollIntervalMs = 100,
	requestTimeoutMs = 30_000,
	log = createLogger('data/desktop-record'),
}: OpenDesktopRecordEpicenterTestOptions = {}) {
	if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
		throw new RangeError('desktop record request timeout must be positive');
	}
	const surfaceId = crypto.randomUUID();
	const pending = new Set<Promise<unknown>>();
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
	let generation: number | undefined;
	let nextMutationId = 0;
	let mutationTail = Promise.resolve();
	let cursor = 0;
	let attachmentCache: ReplicaAttachmentState | undefined;
	let syncStatusCache: RecordSyncStatus | undefined;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let activePoll: Promise<void> | undefined;
	let clientFailure: Error | undefined;
	let isDisposing = false;
	let isDisposed = false;
	let disposalPromise: Promise<void> | undefined;

	function requireOpen(): void {
		if (isDisposing || isDisposed) {
			throw new Error('Desktop record Epicenter is disposed');
		}
		if (clientFailure !== undefined) throw clientFailure;
	}

	function track<TResult>(execution: Promise<TResult>): Promise<TResult> {
		pending.add(execution);
		void execution
			.finally(() => pending.delete(execution))
			.catch(() => undefined);
		return execution;
	}

	async function fetchWithDeadline(
		input: Parameters<typeof globalThis.fetch>[0],
		init: Parameters<typeof globalThis.fetch>[1],
	): Promise<Response> {
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				fetchInput(input, { ...init, signal: controller.signal }),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => {
						controller.abort();
						reject(new Error('Desktop record request timed out'));
					}, requestTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
	}

	function sendRequestOnce<TOperation extends DesktopRecordOperation>(
		operation: TOperation,
		mutationId?: number,
	): Promise<Extract<DesktopRecordResult, { kind: TOperation['kind'] }>> {
		const request: DesktopRecordRequest = {
			surfaceId,
			...(operation.kind === 'open' ? {} : { generation }),
			...(mutationId === undefined ? {} : { mutationId }),
			operation,
		};
		const execution = (async () => {
			const response = await fetchWithDeadline(desktopRecordUrl(baseUrl), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				credentials: 'same-origin',
				body: JSON.stringify(request),
			});
			const envelope = (await response.json()) as DesktopRecordResponse;
			if (!response.ok || envelope.error !== null) {
				const cause = new DesktopRecordHostError(
					envelope.error?.message ??
						`Desktop record Epicenter HTTP ${response.status}`,
				);
				if (envelope.error !== null) cause.name = envelope.error.name;
				throw cause;
			}
			if (envelope.result.kind !== operation.kind) {
				throw new Error(
					`Desktop record host returned '${envelope.result.kind}' for '${operation.kind}'`,
				);
			}
			return envelope.result as Extract<
				DesktopRecordResult,
				{ kind: TOperation['kind'] }
			>;
		})();
		return track(execution);
	}

	function sendRequest<TOperation extends DesktopRecordOperation>(
		operation: TOperation,
	): Promise<Extract<DesktopRecordResult, { kind: TOperation['kind'] }>> {
		if (!isDesktopRecordMutation(operation)) {
			if (operation.kind === 'disconnect') return sendRequestOnce(operation);
			return (async () => {
				try {
					return await sendRequestOnce(operation);
				} catch (cause) {
					if (cause instanceof DesktopRecordHostError) throw cause;
					return sendRequestOnce(operation);
				}
			})();
		}
		const mutationId = ++nextMutationId;
		const execution = mutationTail.then(async () => {
			if (clientFailure !== undefined) throw clientFailure;
			try {
				return await sendRequestOnce(operation, mutationId);
			} catch (cause) {
				if (cause instanceof DesktopRecordHostError) {
					if (
						cause.name === EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME ||
						cause.name === EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME
					) {
						failClient(cause);
					}
					throw cause;
				}
				try {
					return await sendRequestOnce(operation, mutationId);
				} catch (retryCause) {
					if (!(retryCause instanceof DesktopRecordHostError)) {
						failClient(
							new Error(
								'Desktop record mutation outcome is unknown; reopen the surface',
								{ cause: retryCause },
							),
						);
					}
					throw retryCause;
				}
			}
		});
		mutationTail = execution.then(
			() => undefined,
			() => undefined,
		);
		return execution;
	}

	function request<TOperation extends DesktopRecordOperation>(
		operation: TOperation,
	): Promise<Extract<DesktopRecordResult, { kind: TOperation['kind'] }>> {
		requireOpen();
		return sendRequest(operation);
	}

	function revokeAllDocuments(message: string): void {
		for (const entries of documents.values()) {
			for (const document of entries) document.revoke(message);
		}
	}

	function failClient(cause: unknown): void {
		if (clientFailure !== undefined || isDisposing || isDisposed) return;
		clientFailure =
			cause instanceof Error
				? cause
				: new Error('Desktop record transport failed', { cause });
		clearTimeout(pollTimer);
		revokeAllDocuments(clientFailure.message);
	}

	async function refreshDocuments(address: RecordAddress): Promise<void> {
		const entries = documents.get(addressKey(address));
		if (entries === undefined || entries.size === 0) return;
		try {
			const result = await request({ kind: 'export-document', address });
			if (result.recordState === 'not-openable') return;
			const update =
				result.updateBase64 === undefined
					? undefined
					: base64ToBytes(result.updateBase64);
			for (const document of [...entries]) document.refresh(update);
		} catch (cause) {
			if (isDisposing || isDisposed || clientFailure !== undefined) return;
			if (revokedAddresses.has(addressKey(address))) return;
			log.error(new Error('Desktop record document refresh failed', { cause }));
		}
	}

	function publishEvent(event: DesktopRecordEvent): void {
		switch (event.kind) {
			case 'records-invalidated':
				for (const listener of recordListeners) {
					try {
						listener(structuredClone(event.addresses));
					} catch (cause) {
						log.error(new Error('Data subscriber threw', { cause }));
					}
				}
				for (const address of event.addresses) void refreshDocuments(address);
				return;
			case 'blob-invalidated':
				for (const listener of blobListeners) {
					try {
						listener(structuredClone(event.address));
					} catch (cause) {
						log.error(new Error('Blob subscriber threw', { cause }));
					}
				}
				return;
			case 'address-revoked': {
				const key = addressKey(event.address);
				revokedAddresses.add(key);
				for (const document of documents.get(key) ?? []) {
					document.revoke(event.message);
				}
				return;
			}
			case 'attachment':
				attachmentCache = structuredClone(event.attachment);
				for (const listener of attachmentListeners) {
					try {
						listener(structuredClone(event.attachment));
					} catch (cause) {
						log.error(new Error('Attachment subscriber threw', { cause }));
					}
				}
				return;
			case 'sync-status':
				syncStatusCache = deserializeSyncStatus(event.status);
				for (const listener of syncStatusListeners) {
					try {
						listener(deserializeSyncStatus(event.status));
					} catch (cause) {
						log.error(new Error('Sync-status subscriber threw', { cause }));
					}
				}
				return;
			default:
				event satisfies never;
		}
	}

	function schedulePoll(): void {
		if (isDisposing || isDisposed || clientFailure !== undefined) return;
		pollTimer = setTimeout(() => {
			activePoll = poll().finally(() => {
				activePoll = undefined;
			});
		}, pollIntervalMs);
	}

	async function poll(): Promise<void> {
		try {
			const result = await request({ kind: 'events', after: cursor });
			if (result.overflowed) {
				throw new Error(
					'Desktop record event stream fell behind; reopen the surface',
				);
			}
			for (const event of result.events) publishEvent(event);
			cursor = result.cursor;
			schedulePoll();
		} catch (cause) {
			failClient(cause);
		}
	}

	let opened: Extract<DesktopRecordResult, { kind: 'open' }>;
	try {
		opened = await sendRequestOnce({ kind: 'open' });
	} catch (cause) {
		if (cause instanceof DesktopRecordHostError) throw cause;
		opened = await sendRequestOnce({ kind: 'open' });
	}
	generation = opened.generation;
	cursor = opened.cursor;
	attachmentCache = structuredClone(opened.attachment);
	syncStatusCache = deserializeSyncStatus(opened.syncStatus);
	schedulePoll();

	async function openDocument(address: RecordAddress): Promise<RowDocument> {
		const openedDocument = await request({ kind: 'export-document', address });
		if (openedDocument.recordState !== 'live') {
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

		function queueDocumentOperation(operation: DesktopRecordOperation): void {
			if (persistenceFailure !== undefined) return;
			persistenceTail = persistenceTail
				.then(async () => {
					await sendRequest(operation);
				})
				.catch((cause: unknown) => {
					persistenceFailure =
						cause instanceof Error
							? cause
							: new Error('Desktop document persistence failed', { cause });
					entry.revoke(persistenceFailure.message);
					throw persistenceFailure;
				});
		}

		const persist = (update: Uint8Array, origin: unknown) => {
			if (origin === remoteDocumentOrigin || acceptedUpdateDepth > 0) return;
			queueDocumentOperation({
				kind: 'append-local-document-update',
				address,
				updateBase64: bytesToBase64(update),
			});
		};
		document.on('updateV2', persist);
		if (openedDocument.updateBase64 !== undefined) {
			Y.applyUpdateV2(
				document,
				base64ToBytes(openedDocument.updateBase64),
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
				Y.applyUpdateV2(document, update, remoteDocumentOrigin);
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
					updateBase64: bytesToBase64(update),
				});
				acceptedUpdateDepth += 1;
				try {
					Y.applyUpdateV2(document, update, origin);
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

	const lenses = createRecordLensRuntime<Blob, Blob, DesktopRecordBlobSource>({
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
					source: await serializeBlobSource(source),
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
			return (
				await request({
					kind: 'put-blob',
					address,
					bytesBase64: await blobToBase64(source),
				})
			).digest;
		},
		async readBlob(address) {
			const result = await request({ kind: 'read-blob', address });
			return result.bytesBase64 === null
				? null
				: new Blob([base64ToArrayBuffer(result.bytesBase64)]);
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
	): BoundLenses<TLenses, Blob, Blob, DesktopRecordBlobSource> {
		return lenses.bind(definitions);
	}

	function dispose(): Promise<void> {
		disposalPromise ??= performDispose();
		return disposalPromise;
	}

	async function performDispose(): Promise<void> {
		if (isDisposed) return;
		isDisposing = true;
		clearTimeout(pollTimer);
		const failures: unknown[] = [];
		for (const result of await Promise.allSettled(
			[...documents.values()].flatMap((entries) =>
				[...entries].map((document) => document.dispose()),
			),
		)) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		if (activePoll !== undefined) {
			try {
				await activePoll;
			} catch (cause) {
				failures.push(cause);
			}
		}
		for (const result of await Promise.allSettled([...pending])) {
			if (result.status === 'rejected') failures.push(result.reason);
		}
		try {
			await lenses.dispose();
		} catch (cause) {
			failures.push(cause);
		}
		try {
			await sendRequest({ kind: 'disconnect' });
		} catch (cause) {
			failures.push(cause);
		}
		isDisposed = true;
		recordListeners.clear();
		blobListeners.clear();
		attachmentListeners.clear();
		syncStatusListeners.clear();
		documents.clear();
		revokedAddresses.clear();
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Desktop record cleanup failed');
		}
	}

	return Object.freeze({
		bind,
		get attachment(): ReplicaAttachmentState {
			requireOpen();
			if (attachmentCache === undefined) {
				throw new Error('Desktop record attachment cache is not initialized');
			}
			return structuredClone(attachmentCache);
		},
		get syncStatus(): RecordSyncStatus {
			requireOpen();
			if (syncStatusCache === undefined) {
				throw new Error('Desktop record sync-status cache is not initialized');
			}
			return cloneSyncStatus(syncStatusCache);
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
		chooseFirstAttachment(choice: FirstAttachmentChoice): Promise<void> {
			requireOpen();
			return track(
				(async () => {
					const response = await fetchWithDeadline(
						desktopRecordAttachmentUrl(baseUrl),
						{
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							credentials: 'same-origin',
							body: JSON.stringify({ choice }),
						},
					);
					if (!response.ok) {
						throw new DesktopRecordHostError(
							`Desktop record attachment choice failed (${response.status})`,
						);
					}
				})(),
			);
		},
		[Symbol.asyncDispose]: dispose,
	});
}

export type DesktopRecordEpicenter = Awaited<
	ReturnType<typeof openDesktopRecordEpicenter>
>;

function deserializeSyncStatus(
	status: DesktopRecordSyncStatus,
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

function cloneSyncStatus(status: RecordSyncStatus): RecordSyncStatus {
	return {
		state: status.state,
		work: structuredClone(status.work),
		...(status.authorityLifetime === undefined
			? {}
			: { authorityLifetime: status.authorityLifetime }),
		...(status.lastError === undefined
			? {}
			: {
					lastError: Object.assign(new Error(status.lastError.message), {
						name: status.lastError.name,
					}),
				}),
	};
}

function defaultOrigin(): string {
	const location = (globalThis as { location?: { origin?: unknown } }).location;
	if (typeof location?.origin !== 'string') {
		throw new Error('Desktop record Epicenter requires an explicit baseUrl');
	}
	return location.origin;
}

async function serializeBlobSource(
	source: DesktopRecordBlobSource,
): Promise<DesktopRecordBlobOperationSource> {
	switch (source.kind) {
		case 'bytes':
			return {
				kind: 'bytes',
				bytesBase64: await blobToBase64(source.bytes),
			};
		case 'native-capture':
			return {
				kind: 'native-capture',
				captureId: source.captureId,
				byteLength: source.byteLength,
			};
		default:
			return source satisfies never;
	}
}

async function blobToBase64(blob: Blob): Promise<string> {
	if (blob.size > MAX_RECORD_BLOB_BYTES) {
		throw new RangeError(
			`Desktop record blob exceeds the ${MAX_RECORD_BLOB_BYTES}-byte limit`,
		);
	}
	return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
	const bytes = base64ToBytes(value);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function bytesToBase64(value: Uint8Array): string {
	let binary = '';
	const chunkSize = 32_768;
	for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
		binary += String.fromCharCode(
			...value.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}
