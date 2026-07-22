import { customAlphabet } from 'nanoid';

import { openBunRecordOwner } from './bun-record-owner.js';
import type {
	DesktopRecordError,
	DesktopRecordEvent,
	DesktopRecordOperation,
	DesktopRecordRequest,
	DesktopRecordResponse,
	DesktopRecordResult,
	DesktopRecordSyncStatus,
} from './desktop-record/protocol.js';
import {
	EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME,
	isDesktopRecordMutation,
} from './desktop-record/protocol.js';
import {
	isJsonObject,
	isJsonValue,
	isLocalKey,
	isNamespaceKey,
	parseAddress,
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from './protocol/v1/index.js';
import type { RecordOwner } from './record-epicenter.js';
import type { RecordSyncStatus } from './record-sync-supervisor.js';
import type {
	BlobByteSource,
	BunBlobRead,
} from './store/replica/bun-blob-files.js';
import type { ReplicaBlobStore, ReplicaStore } from './store/replica/index.js';

const mintRecordKey = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const MAX_SURFACE_EVENTS = 2_048;
const DEFAULT_SURFACE_LEASE_MS = 60_000;
const DEFAULT_MAX_SURFACES = 32;

type MutationOutcome =
	| { result: DesktopRecordResult; error: null }
	| { result: null; error: DesktopRecordError };

type Surface = {
	generation: number;
	events: DesktopRecordEvent[];
	droppedThrough: number;
	lastSeenAt: number;
	activeOperations: number;
	nextMutationId: number;
	lastMutation?: {
		id: number;
		kind: DesktopRecordOperation['kind'];
		operationJson: string;
		outcome: MutationOutcome;
	};
};

type DesktopRecordEventInput<TEvent = DesktopRecordEvent> =
	TEvent extends DesktopRecordEvent ? Omit<TEvent, 'cursor'> : never;

type DesktopRecordOwnedState<TSource, TRead> = {
	owner: RecordOwner<TSource, TRead>;
	replica: ReplicaStore;
	blobs: ReplicaBlobStore<TSource, TRead>;
	decodeBlob(value: string): TSource;
	encodeBlob(value: TRead): Promise<string>;
};

type DesktopRecordOwnerRuntimeOptions = {
	now?: () => number;
	surfaceLeaseMs?: number;
	maxSurfaces?: number;
};

/** Open the one Bun-owned desktop universal-record Epicenter. */
export async function createDesktopRecordEpicenterOwner({
	directory,
}: {
	directory: string;
}) {
	const opened = await openBunRecordOwner({ directory });
	return createDesktopRecordEpicenterOwnerForTest({
		...opened,
		decodeBlob: decodeBunBlob,
		encodeBlob: encodeBunBlob,
	});
}

/** Internal dependency seam for repository tests of the host/page protocol. */
export function createDesktopRecordEpicenterOwnerForTest<TSource, TRead>(
	{
		owner,
		replica,
		blobs,
		decodeBlob,
		encodeBlob,
	}: DesktopRecordOwnedState<TSource, TRead>,
	{
		now = Date.now,
		surfaceLeaseMs = DEFAULT_SURFACE_LEASE_MS,
		maxSurfaces = DEFAULT_MAX_SURFACES,
	}: DesktopRecordOwnerRuntimeOptions = {},
) {
	if (!Number.isSafeInteger(surfaceLeaseMs) || surfaceLeaseMs < 1) {
		throw new RangeError('desktop record surface lease must be positive');
	}
	if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1) {
		throw new RangeError('desktop record surface capacity must be positive');
	}
	const surfaces = new Map<string, Surface>();
	let operationTail = Promise.resolve();
	let nextGeneration = 0;
	let nextCursor = 0;
	let isDisposed = false;

	function requireOpen(): void {
		if (isDisposed) throw new Error('Desktop record owner is disposed');
	}

	function sweepExpiredSurfaces(at: number): void {
		for (const [surfaceId, surface] of surfaces) {
			if (
				surface.activeOperations === 0 &&
				at - surface.lastSeenAt >= surfaceLeaseMs
			) {
				surfaces.delete(surfaceId);
			}
		}
	}

	function emit(event: DesktopRecordEventInput): void {
		if (isDisposed) return;
		sweepExpiredSurfaces(now());
		const copied = structuredClone({
			...event,
			cursor: ++nextCursor,
		}) as DesktopRecordEvent;
		for (const surface of surfaces.values()) {
			surface.events.push(copied);
			if (surface.events.length <= MAX_SURFACE_EVENTS) continue;
			const dropped = surface.events.splice(
				0,
				surface.events.length - MAX_SURFACE_EVENTS,
			);
			surface.droppedThrough = Math.max(
				surface.droppedThrough,
				dropped.at(-1)?.cursor ?? 0,
			);
		}
	}

	const stopRecords = replica.subscribe((addresses) => {
		const copied = addresses.map((address) => structuredClone(address));
		emit({ kind: 'records-invalidated', addresses: copied });
		for (const address of copied) {
			if (replica.visible(address)?.state === 'tombstone') {
				emit({
					kind: 'address-revoked',
					address,
					message: `Record '${addressLabel(address)}' was deleted`,
				});
			}
		}
	});
	const stopBlobs = blobs.subscribe((address) => {
		emit({ kind: 'blob-invalidated', address: structuredClone(address) });
	});
	const stopAttachment = owner.subscribeAttachment((attachment) => {
		emit({ kind: 'attachment', attachment: structuredClone(attachment) });
	});
	const stopSyncStatus = owner.subscribeSyncStatus((status) => {
		emit({ kind: 'sync-status', status: serializeSyncStatus(status) });
	});

	function requireSurface(
		surfaceId: string,
		generation: number | undefined,
	): Surface {
		const surface = surfaces.get(surfaceId);
		if (surface === undefined || generation !== surface.generation) {
			const cause = new Error(
				'Desktop record Epicenter moved to a newer surface generation',
			);
			cause.name = EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME;
			throw cause;
		}
		surface.lastSeenAt = now();
		return surface;
	}

	async function executeOperation(
		request: DesktopRecordRequest,
	): Promise<DesktopRecordResult> {
		const { surfaceId, operation } = request;
		if (operation.kind === 'open') {
			const openedAt = now();
			sweepExpiredSurfaces(openedAt);
			if (!surfaces.has(surfaceId) && surfaces.size >= maxSurfaces) {
				throw new Error('Desktop record surface capacity is exhausted');
			}
			const generation = ++nextGeneration;
			surfaces.set(surfaceId, {
				generation,
				events: [],
				droppedThrough: nextCursor,
				lastSeenAt: openedAt,
				activeOperations: 0,
				nextMutationId: 1,
			});
			return {
				kind: 'open',
				generation,
				cursor: nextCursor,
				attachment: structuredClone(owner.attachment),
				syncStatus: serializeSyncStatus(owner.syncStatus),
			};
		}
		const surface = requireSurface(surfaceId, request.generation);
		surface.activeOperations += 1;
		try {
			if (operation.kind === 'disconnect') {
				surfaces.delete(surfaceId);
				return { kind: 'disconnect' };
			}
			if (!isDesktopRecordMutation(operation)) {
				return executeOpenedOperation(surface, operation);
			}
			const mutationId = request.mutationId;
			if (!Number.isSafeInteger(mutationId) || (mutationId ?? 0) < 1) {
				throw new TypeError('Desktop record mutation ID must be positive');
			}
			const lastMutation = surface.lastMutation;
			const operationJson = JSON.stringify(operation);
			if (lastMutation !== undefined && lastMutation.id === mutationId) {
				if (
					lastMutation.kind !== operation.kind ||
					lastMutation.operationJson !== operationJson
				) {
					throw new TypeError(
						'Desktop record mutation ID changed operation payload',
					);
				}
				return restoreMutationOutcome(lastMutation.outcome);
			}
			if (mutationId !== surface.nextMutationId) {
				throw new TypeError('Desktop record mutation ID is out of sequence');
			}
			let outcome: MutationOutcome;
			try {
				const result = await executeOpenedOperation(surface, operation);
				outcome = { result, error: null };
			} catch (cause) {
				outcome = { result: null, error: serializeDesktopRecordError(cause) };
			}
			surface.lastMutation = {
				id: mutationId,
				kind: operation.kind,
				operationJson,
				outcome,
			};
			surface.nextMutationId += 1;
			return restoreMutationOutcome(outcome);
		} finally {
			surface.activeOperations -= 1;
			surface.lastSeenAt = now();
		}
	}

	async function executeOpenedOperation(
		surface: Surface,
		operation: DesktopRecordOperation,
	): Promise<DesktopRecordResult> {
		switch (operation.kind) {
			case 'open':
			case 'disconnect':
				throw new Error(`Unexpected opened operation '${operation.kind}'`);
			case 'read':
				return {
					kind: 'read',
					record: structuredClone(replica.visible(operation.address)),
				};
			case 'read-page':
				return {
					kind: 'read-page',
					page: structuredClone(
						replica.visibleRecords(
							operation.namespace,
							operation.collection,
							operation.after,
							operation.limit,
						),
					),
				};
			case 'create-record': {
				const recordKey = freshRecordKey(replica, operation);
				replica.localWrite({
					address: {
						namespace: operation.namespace,
						collection: operation.collection,
						recordKey,
					},
					op: 'patch',
					set: operation.payload,
					unset: [],
				});
				return { kind: 'create-record', recordKey };
			}
			case 'create-record-with-blob': {
				const recordKey = freshRecordKey(replica, operation);
				const address = {
					namespace: operation.namespace,
					collection: operation.collection,
					recordKey,
				};
				await blobs.captureNewRecord(
					address,
					decodeBlob(operation.bytesBase64),
					(digest) =>
						replica.admitLocalRecordWithBlob({
							address,
							payload: operation.payload,
							digest,
						}),
				);
				return { kind: 'create-record-with-blob', recordKey };
			}
			case 'patch-live': {
				const before = replica.visible(operation.address);
				if (before?.state !== 'live') {
					return { kind: 'patch-live', record: structuredClone(before) };
				}
				replica.localWrite({
					address: operation.address,
					op: 'patch',
					...operation.patch,
				});
				return {
					kind: 'patch-live',
					record: structuredClone(replica.visible(operation.address)),
				};
			}
			case 'tombstone-live': {
				const deleted = replica.visible(operation.address)?.state === 'live';
				if (deleted) {
					replica.localWrite({
						address: operation.address,
						op: 'tombstone',
					});
				}
				return { kind: 'tombstone-live', deleted };
			}
			case 'replace':
				replica.localWrite({
					address: operation.address,
					op: 'replace',
					value: operation.value,
				});
				return { kind: 'replace' };
			case 'unset':
				replica.localWrite({
					address: operation.address,
					op: 'unset',
				});
				return { kind: 'unset' };
			case 'export-document': {
				const visible = replica.visible(operation.address);
				if (visible?.state !== 'live' && visible?.state !== 'unset') {
					return { kind: 'export-document', recordState: 'not-openable' };
				}
				const update = replica.exportDocument(operation.address);
				return {
					kind: 'export-document',
					recordState: visible.state,
					...(update === undefined
						? {}
						: { updateBase64: bytesToBase64(update) }),
				};
			}
			case 'append-local-document-update':
				replica.appendLocalDocumentUpdate(
					operation.address,
					base64ToBytes(operation.updateBase64),
				);
				return { kind: 'append-local-document-update' };
			case 'install-accepted-document-update':
				replica.installAcceptedDocumentUpdate(
					operation.address,
					base64ToBytes(operation.updateBase64),
				);
				return { kind: 'install-accepted-document-update' };
			case 'put-blob':
				return {
					kind: 'put-blob',
					digest: await blobs.capture(
						operation.address,
						decodeBlob(operation.bytesBase64),
					),
				};
			case 'read-blob': {
				const bytes = await blobs.read(operation.address);
				return {
					kind: 'read-blob',
					bytesBase64: bytes === null ? null : await encodeBlob(bytes),
				};
			}
			case 'inspect-blob':
				return {
					kind: 'inspect-blob',
					inspection: structuredClone(blobs.inspect(operation.address)),
				};
			case 'parked-work':
				return {
					kind: 'parked-work',
					page: structuredClone(await owner.parkedWork(operation.after)),
				};
			case 'inspect-record':
				return {
					kind: 'inspect-record',
					inspection: structuredClone(
						await owner.inspectRecord(operation.address),
					),
				};
			case 'events': {
				if (operation.after > nextCursor) {
					throw new TypeError('Desktop record event cursor is ahead of owner');
				}
				const events = surface.events.filter(
					(event) => event.cursor > operation.after,
				);
				const cursor = events.at(-1)?.cursor ?? operation.after;
				surface.events = surface.events.filter(
					(event) => event.cursor > operation.after,
				);
				return {
					kind: 'events',
					cursor,
					events: structuredClone(events),
					overflowed: operation.after < surface.droppedThrough,
				};
			}
			default:
				return operation satisfies never;
		}
	}

	async function dispose(): Promise<void> {
		if (isDisposed) return;
		isDisposed = true;
		await operationTail;
		surfaces.clear();
		const failures: unknown[] = [];
		for (const release of [
			stopRecords,
			stopBlobs,
			stopAttachment,
			stopSyncStatus,
			() => owner[Symbol.asyncDispose](),
		]) {
			try {
				await release();
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, 'Desktop record owner cleanup failed');
		}
	}

	return Object.freeze({
		epicenter: owner,
		execute(input: unknown): Promise<DesktopRecordResponse> {
			let request: DesktopRecordRequest;
			try {
				requireOpen();
				request = parseDesktopRecordRequest(input);
			} catch (cause) {
				return Promise.resolve({
					result: null,
					error: serializeDesktopRecordError(cause),
				});
			}
			const candidateSurface =
				request.operation.kind === 'open'
					? undefined
					: surfaces.get(request.surfaceId);
			const queuedSurface =
				candidateSurface?.generation === request.generation
					? candidateSurface
					: undefined;
			if (queuedSurface !== undefined) {
				queuedSurface.activeOperations += 1;
				queuedSurface.lastSeenAt = now();
			}
			const execution = operationTail
				.then(() => executeOperation(request))
				.then(
					(result): DesktopRecordResponse => ({ result, error: null }),
					(cause: unknown) =>
						({
							result: null,
							error: serializeDesktopRecordError(cause),
						}) satisfies DesktopRecordResponse,
				)
				.finally(() => {
					if (queuedSurface !== undefined) queuedSurface.activeOperations -= 1;
				});
			operationTail = execution.then(
				() => undefined,
				() => undefined,
			);
			return execution;
		},
		[Symbol.asyncDispose]: dispose,
	});
}

export type DesktopRecordEpicenterOwner = Awaited<
	ReturnType<typeof createDesktopRecordEpicenterOwner>
>;

function freshRecordKey(
	replica: ReplicaStore,
	operation: Pick<
		Extract<
			DesktopRecordOperation,
			{ kind: 'create-record' | 'create-record-with-blob' }
		>,
		'namespace' | 'collection'
	>,
): string {
	let recordKey = mintRecordKey();
	for (
		let attempts = 0;
		replica.record({
			namespace: operation.namespace,
			collection: operation.collection,
			recordKey,
		}) !== null;
		attempts += 1
	) {
		if (attempts === 9) throw new Error('Could not mint a fresh record ID');
		recordKey = mintRecordKey();
	}
	return recordKey;
}

function restoreMutationOutcome(outcome: MutationOutcome): DesktopRecordResult {
	if (outcome.error === null) return structuredClone(outcome.result);
	const cause = new Error(outcome.error.message);
	cause.name = outcome.error.name;
	throw cause;
}

function serializeDesktopRecordError(cause: unknown): DesktopRecordError {
	if (
		cause instanceof Error &&
		cause.name === EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME
	) {
		return {
			name: EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
			message: 'Desktop record surface generation changed',
		};
	}
	if (cause instanceof TypeError) {
		return {
			name: EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME,
			message: 'Desktop record request is invalid',
		};
	}
	return {
		name: EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
		message: 'Desktop record operation failed',
	};
}

function serializeSyncStatus(
	status: RecordSyncStatus,
): DesktopRecordSyncStatus {
	return {
		state: status.state,
		work: structuredClone(status.work),
		...(status.authorityLifetime === undefined
			? {}
			: { authorityLifetime: status.authorityLifetime }),
		...(status.lastError === undefined
			? {}
			: {
					lastError: {
						name: 'RecordSyncError',
						message: 'Desktop record synchronization failed',
					},
				}),
	};
}

function parseDesktopRecordRequest(input: unknown): DesktopRecordRequest {
	if (
		!isPlainRecord(input) ||
		typeof input.surfaceId !== 'string' ||
		input.surfaceId.length === 0 ||
		input.surfaceId.length > 128
	) {
		throw new TypeError('Invalid desktop record Epicenter request');
	}
	const operation = parseDesktopRecordOperation(input.operation);
	const isOpen = operation.kind === 'open';
	const isMutation = isDesktopRecordMutation(operation);
	requireExactKeys(
		input,
		['surfaceId', 'operation'],
		[...(isOpen ? [] : ['generation']), ...(isMutation ? ['mutationId'] : [])],
	);
	if (
		!isOpen &&
		(!Number.isSafeInteger(input.generation) ||
			(input.generation as number) < 1)
	) {
		throw new TypeError('Invalid desktop record generation');
	}
	if (
		isMutation &&
		(!Number.isSafeInteger(input.mutationId) ||
			(input.mutationId as number) < 1)
	) {
		throw new TypeError('Invalid desktop record mutation ID');
	}
	return {
		surfaceId: input.surfaceId,
		...(isOpen ? {} : { generation: input.generation as number }),
		...(isMutation ? { mutationId: input.mutationId as number } : {}),
		operation,
	};
}

function parseDesktopRecordOperation(input: unknown): DesktopRecordOperation {
	if (!isPlainRecord(input) || typeof input.kind !== 'string') {
		throw new TypeError('Invalid desktop record operation');
	}
	switch (input.kind) {
		case 'open':
		case 'disconnect':
			requireExactKeys(input, ['kind']);
			return input as DesktopRecordOperation;
		case 'read':
		case 'tombstone-live':
		case 'export-document':
		case 'read-blob':
		case 'inspect-blob':
		case 'inspect-record':
			requireExactKeys(input, ['kind', 'address']);
			requireAddress(input.address);
			return input as DesktopRecordOperation;
		case 'read-page':
			requireExactKeys(
				input,
				['kind', 'namespace', 'collection'],
				['after', 'limit'],
			);
			requireCollection(input.namespace, input.collection);
			if (input.after !== undefined && typeof input.after !== 'string') {
				throw new TypeError('Invalid desktop record page cursor');
			}
			if (input.after !== undefined) {
				requireAddress({
					namespace: input.namespace,
					collection: input.collection,
					recordKey: input.after,
				});
			}
			if (
				input.limit !== undefined &&
				(!Number.isSafeInteger(input.limit) ||
					(input.limit as number) < 1 ||
					(input.limit as number) > 1_000)
			) {
				throw new TypeError('Invalid desktop record page limit');
			}
			return input as DesktopRecordOperation;
		case 'create-record':
		case 'create-record-with-blob':
			requireExactKeys(
				input,
				['kind', 'namespace', 'collection', 'payload'],
				input.kind === 'create-record-with-blob' ? ['bytesBase64'] : [],
			);
			requireCollection(input.namespace, input.collection);
			if (!isJsonObject(input.payload, SCALAR_SYNC_V1_LIMITS)) {
				throw new TypeError('Invalid desktop record payload');
			}
			if (input.kind === 'create-record-with-blob') {
				requireBase64(input.bytesBase64);
			}
			return input as DesktopRecordOperation;
		case 'patch-live':
			requireExactKeys(input, ['kind', 'address', 'patch']);
			requireAddress(input.address);
			if (!isPlainRecord(input.patch)) {
				throw new TypeError('Invalid desktop record patch');
			}
			requireExactKeys(input.patch, ['set', 'unset']);
			if (
				!isJsonObject(input.patch.set, SCALAR_SYNC_V1_LIMITS) ||
				!Array.isArray(input.patch.unset) ||
				input.patch.unset.some((key) => typeof key !== 'string')
			) {
				throw new TypeError('Invalid desktop record patch');
			}
			return input as DesktopRecordOperation;
		case 'replace':
			requireExactKeys(input, ['kind', 'address', 'value']);
			requireAddress(input.address);
			if (!isJsonValue(input.value, SCALAR_SYNC_V1_LIMITS)) {
				throw new TypeError('Invalid desktop record replacement');
			}
			return input as DesktopRecordOperation;
		case 'unset':
			requireExactKeys(input, ['kind', 'address']);
			requireAddress(input.address);
			return input as DesktopRecordOperation;
		case 'append-local-document-update':
		case 'install-accepted-document-update':
			requireExactKeys(input, ['kind', 'address', 'updateBase64']);
			requireAddress(input.address);
			requireBase64(input.updateBase64);
			return input as DesktopRecordOperation;
		case 'put-blob':
			requireExactKeys(input, ['kind', 'address', 'bytesBase64']);
			requireAddress(input.address);
			requireBase64(input.bytesBase64);
			return input as DesktopRecordOperation;
		case 'parked-work':
			requireExactKeys(input, ['kind'], ['after']);
			if (input.after !== undefined) requireAddress(input.after);
			return input as DesktopRecordOperation;
		case 'events':
			requireExactKeys(input, ['kind', 'after']);
			if (!Number.isSafeInteger(input.after) || (input.after as number) < 0) {
				throw new TypeError('Invalid desktop record event cursor');
			}
			return input as DesktopRecordOperation;
		default:
			throw new TypeError('Unknown desktop record operation');
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function requireExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const keys = Object.keys(value);
	const admitted = new Set([...required, ...optional]);
	if (
		keys.length < required.length ||
		keys.some((key) => !admitted.has(key)) ||
		required.some((key) => !Object.hasOwn(value, key))
	) {
		throw new TypeError('Desktop record object has invalid keys');
	}
}

function requireAddress(value: unknown): void {
	const parsed = parseAddress(value, SCALAR_SYNC_V1_LIMITS);
	if (parsed.error !== null) throw new TypeError('Invalid record address');
}

function requireCollection(namespace: unknown, collection: unknown): void {
	if (
		!isNamespaceKey(namespace, SCALAR_SYNC_V1_LIMITS) ||
		!isLocalKey(collection, SCALAR_SYNC_V1_LIMITS)
	) {
		throw new TypeError('Invalid record collection');
	}
}

function requireBase64(value: unknown): void {
	if (
		typeof value !== 'string' ||
		Buffer.from(value, 'base64').toString('base64') !== value
	) {
		throw new TypeError('Invalid base64 bytes');
	}
}

function addressLabel(address: RecordAddress): string {
	return `${address.namespace}/${address.collection}/${address.recordKey}`;
}

function decodeBunBlob(value: string): BlobByteSource {
	return new Blob([base64ToBytes(value)]).stream();
}

async function encodeBunBlob(value: BunBlobRead): Promise<string> {
	return bytesToBase64(new Uint8Array(await new Response(value).arrayBuffer()));
}

function base64ToBytes(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, 'base64'));
}

function bytesToBase64(value: Uint8Array): string {
	return Buffer.from(value).toString('base64');
}
