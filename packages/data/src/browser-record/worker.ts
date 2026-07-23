import { customAlphabet } from 'nanoid';
import { createLogger, type Logger } from 'wellcrafted/logger';

import {
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '../protocol/v1/index.js';
import { createRecordOwner, type RecordOwner } from '../record-epicenter.js';
import type { RecordSyncStatus } from '../record-sync-supervisor.js';
import {
	type BrowserReplicaOwner,
	openBrowserReplicaOwner,
} from '../store/replica/browser-owner.js';
import type {
	ReplicaAttachment,
	ReplicaBlobStore,
	ReplicaStore,
} from '../store/replica/index.js';
import {
	type BrowserRecordAuthorityRelay,
	createBrowserRecordAuthorityRelay,
} from './authority-relay.js';
import type {
	BrowserRecordAuthorityOperation,
	BrowserRecordCandidateStart,
	BrowserRecordCoordinationMessage,
	BrowserRecordOperation,
	BrowserRecordRequest,
	BrowserRecordResult,
	BrowserRecordSyncStatus,
	BrowserRecordWorkerInbound,
	BrowserRecordWorkerMessage,
} from './protocol.js';

const DEFAULT_COORDINATION_ID = 'epicenter-data-record-owner-v1';
const mintRecordKey = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);
const mintReplicaId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	24,
);

export type BrowserRecordCandidateWorkerScope = {
	postMessage(message: BrowserRecordWorkerMessage): void;
	addEventListener(
		type: 'message',
		listener: (event: { data: BrowserRecordWorkerInbound }) => void,
	): void;
	close(): void;
};

export type BrowserRecordWorkerOwner = {
	owner: RecordOwner<Blob, Blob>;
	replica: ReplicaStore;
	blobs: ReplicaBlobStore<Blob, Blob>;
	ownerGeneration: number;
	integrityCheck(): void | Promise<void>;
	captureSnapshot(options?: {
		lens?: import('../lens.js').LensDefinition;
	}): Promise<{
		artifact: Blob;
		metadata: import('../store/replica/index.js').SnapshotArtifactMetadata;
	}>;
};

export type BrowserRecordCoordinationChannel = {
	onmessage:
		| ((event: { data: BrowserRecordCoordinationMessage }) => void)
		| null;
	postMessage(message: BrowserRecordCoordinationMessage): void;
	close(): void;
};

export type OpenBrowserRecordWorkerOwner = (options: {
	onStolen(): void;
	signal: AbortSignal;
	storage?: BrowserRecordCandidateStart['storage'];
}) => Promise<BrowserRecordWorkerOwner>;

type OwnerRuntime = BrowserRecordWorkerOwner & {
	execute(
		operation: BrowserRecordOperation,
		candidateId: string,
	): Promise<BrowserRecordResult>;
	stopEvents(): Promise<void>;
};

type ResponseMessage = Extract<
	BrowserRecordWorkerMessage,
	{ type: 'result' | 'error' }
>;

type EventMessage = Extract<
	BrowserRecordWorkerMessage,
	{
		type:
			| 'records-invalidated'
			| 'blob-invalidated'
			| 'address-revoked'
			| 'sync-status'
			| 'attachment';
	}
>;

function serializeError(cause: unknown): { name: string; message: string } {
	return cause instanceof Error
		? { name: cause.name, message: cause.message }
		: { name: 'Error', message: String(cause) };
}

function serializeSyncStatus(
	status: RecordSyncStatus,
): BrowserRecordSyncStatus {
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
						name: status.lastError.name,
						message: status.lastError.message,
					},
				}),
	};
}

function ownerLostMessage(id: number): ResponseMessage {
	return {
		type: 'error',
		id,
		name: 'EpicenterBrowserOwnerLostError',
		message:
			'The browser record owner changed before the operation result arrived',
	};
}

function addressLabel(address: RecordAddress): string {
	return `${address.namespace}/${address.collection}/${address.recordKey}`;
}

function createOwnerOperations(
	opened: BrowserRecordWorkerOwner,
	attachSync: (
		candidateId: string,
		operation: Extract<BrowserRecordOperation, { kind: 'attach-sync' }>,
	) => Promise<Extract<BrowserRecordResult, { kind: 'attach-sync' }>>,
) {
	return async function execute(
		operation: BrowserRecordOperation,
		candidateId: string,
	): Promise<BrowserRecordResult> {
		switch (operation.kind) {
			case 'open':
				return {
					kind: 'open',
					attachment: opened.owner.attachment,
					syncStatus: serializeSyncStatus(opened.owner.syncStatus),
				};
			case 'read':
				return {
					kind: 'read',
					record: opened.replica.visible(operation.address),
				};
			case 'read-page':
				return {
					kind: 'read-page',
					page: opened.replica.visibleRecords(
						operation.namespace,
						operation.collection,
						operation.after,
						operation.limit,
					),
				};
			case 'create-record': {
				let recordKey = mintRecordKey();
				for (
					let attempts = 0;
					opened.replica.record({
						namespace: operation.namespace,
						collection: operation.collection,
						recordKey,
					}) !== null;
					attempts += 1
				) {
					if (attempts === 9)
						throw new Error('Could not mint a fresh record ID');
					recordKey = mintRecordKey();
				}
				opened.replica.localWrite({
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
				let recordKey = mintRecordKey();
				for (
					let attempts = 0;
					opened.replica.record({
						namespace: operation.namespace,
						collection: operation.collection,
						recordKey,
					}) !== null;
					attempts += 1
				) {
					if (attempts === 9)
						throw new Error('Could not mint a fresh record ID');
					recordKey = mintRecordKey();
				}
				const address = {
					namespace: operation.namespace,
					collection: operation.collection,
					recordKey,
				};
				await opened.blobs.captureNewRecord(
					address,
					operation.bytes,
					(digest) => {
						opened.replica.admitLocalRecordWithBlob({
							address,
							payload: operation.payload,
							digest,
						});
					},
				);
				return { kind: 'create-record-with-blob', recordKey };
			}
			case 'patch-live': {
				const before = opened.replica.visible(operation.address);
				if (before?.state !== 'live') {
					return { kind: 'patch-live', record: before };
				}
				opened.replica.localWrite({
					address: operation.address,
					op: 'patch',
					...operation.patch,
				});
				return {
					kind: 'patch-live',
					record: opened.replica.visible(operation.address),
				};
			}
			case 'tombstone-live': {
				const deleted =
					opened.replica.visible(operation.address)?.state === 'live';
				if (deleted) {
					opened.replica.localWrite({
						address: operation.address,
						op: 'tombstone',
					});
				}
				return { kind: 'tombstone-live', deleted };
			}
			case 'replace':
				opened.replica.localWrite({
					address: operation.address,
					op: 'replace',
					value: operation.value,
				});
				return { kind: 'replace' };
			case 'unset':
				opened.replica.localWrite({
					address: operation.address,
					op: 'unset',
				});
				return { kind: 'unset' };
			case 'export-document': {
				const visible = opened.replica.visible(operation.address);
				if (visible?.state !== 'live' && visible?.state !== 'unset') {
					return { kind: 'export-document', recordState: 'not-openable' };
				}
				const update = opened.replica.exportDocument(operation.address);
				return {
					kind: 'export-document',
					recordState: visible.state,
					...(update === undefined ? {} : { update }),
				};
			}
			case 'append-local-document-update':
				opened.replica.appendLocalDocumentUpdate(
					operation.address,
					operation.update,
				);
				return { kind: 'append-local-document-update' };
			case 'install-accepted-document-update':
				opened.replica.installAcceptedDocumentUpdate(
					operation.address,
					operation.update,
				);
				return { kind: 'install-accepted-document-update' };
			case 'put-blob':
				return {
					kind: 'put-blob',
					digest: await opened.blobs.capture(
						operation.address,
						operation.bytes,
					),
				};
			case 'read-blob':
				return {
					kind: 'read-blob',
					bytes: await opened.blobs.read(operation.address),
				};
			case 'inspect-blob':
				return {
					kind: 'inspect-blob',
					inspection: opened.blobs.inspect(operation.address),
				};
			case 'parked-work':
				return {
					kind: 'parked-work',
					page: await opened.owner.parkedWork(operation.after),
				};
			case 'inspect-record':
				return {
					kind: 'inspect-record',
					inspection: await opened.owner.inspectRecord(operation.address),
				};
			case 'capture-snapshot': {
				const captured = await opened.captureSnapshot({
					...(operation.lens === undefined ? {} : { lens: operation.lens }),
				});
				return { kind: 'capture-snapshot', ...captured };
			}
			case 'attach-sync':
				return attachSync(candidateId, operation);
			default:
				return operation satisfies never;
		}
	};
}

/** Start one page's dedicated-worker candidate for the record owner. */
export function startBrowserRecordCandidateWorker(
	scope: BrowserRecordCandidateWorkerScope,
	{
		openOwner = openBrowserRecordWorkerOwner,
		createChannel = createBrowserRecordCoordinationChannel,
		candidateId = crypto.randomUUID(),
		mintOwnerSession = () => crypto.randomUUID(),
		authorityTimeoutMs,
		log = createLogger('data/browser-record-worker'),
	}: {
		openOwner?: OpenBrowserRecordWorkerOwner;
		createChannel?: (name: string) => BrowserRecordCoordinationChannel;
		candidateId?: string;
		mintOwnerSession?: () => string;
		authorityTimeoutMs?: number;
		log?: Logger;
	} = {},
): void {
	const queued = new Map<number, BrowserRecordOperation>();
	const forwarded = new Map<
		number,
		{ ownerSession: string; ownerGeneration: number }
	>();
	const localRequests = new Map<string, { candidate: string; id: number }>();
	let channel: BrowserRecordCoordinationChannel | undefined;
	let owner: OwnerRuntime | undefined;
	let ownerSession: string | undefined;
	let ownerGeneration: number | undefined;
	let authorityRelay: BrowserRecordAuthorityRelay | undefined;
	let isOwnerSyncAttached = false;
	let pageTransport:
		| {
				transportKey: number;
				attachment: ReplicaAttachment;
				hasCredentials: boolean;
		  }
		| undefined;
	const pageAuthorityRequests = new Map<
		number,
		{ transportKey: number; ownerSession: string; ownerGeneration: number }
	>();
	let currentSession: string | undefined;
	let currentGeneration = 0;
	let ownerTail = Promise.resolve();
	let acquisition: Promise<void> | undefined;
	let lossTransition = Promise.resolve();
	const lifecycleFailures: unknown[] = [];
	let openingController: AbortController | undefined;
	let isStarted = false;
	let isClosed = false;
	let closure: Promise<void> | undefined;
	let nextEventId = 0;

	function postStatus(role: 'waiting' | 'follower' | 'owner'): void {
		scope.postMessage({
			type: 'status',
			role,
			ownerSession: currentSession ?? null,
			ownerGeneration: currentGeneration === 0 ? null : currentGeneration,
		});
	}

	function respond(
		candidate: string,
		message: ResponseMessage,
		session: string,
		generation: number,
	): void {
		if (candidate === candidateId) {
			scope.postMessage(message);
			return;
		}
		channel?.postMessage({
			version: 1,
			type: 'response',
			candidateId: candidate,
			ownerSession: session,
			ownerGeneration: generation,
			message,
		});
	}

	function emit(
		message: EventMessage,
		session: string,
		generation: number,
	): void {
		scope.postMessage(message);
		channel?.postMessage({
			version: 1,
			type: 'event',
			ownerSession: session,
			ownerGeneration: generation,
			message,
		});
	}

	function requireOwnerFence(): { session: string; generation: number } {
		if (ownerSession === undefined || ownerGeneration === undefined) {
			throw new Error('Browser record candidate is not the owner');
		}
		return { session: ownerSession, generation: ownerGeneration };
	}

	function sendAuthorityRequest(
		capability: { candidateId: string; transportKey: number },
		authorityId: number,
		operation: BrowserRecordAuthorityOperation,
	): void {
		const { session, generation } = requireOwnerFence();
		const message: Extract<
			BrowserRecordWorkerMessage,
			{ type: 'authority-request' }
		> = {
			type: 'authority-request',
			authorityId,
			transportKey: capability.transportKey,
			ownerSession: session,
			ownerGeneration: generation,
			operation,
		};
		if (capability.candidateId === candidateId) {
			pageAuthorityRequests.set(authorityId, {
				transportKey: capability.transportKey,
				ownerSession: session,
				ownerGeneration: generation,
			});
			scope.postMessage(message);
			return;
		}
		channel?.postMessage({
			version: 1,
			type: 'authority-request',
			candidateId: capability.candidateId,
			ownerSession: session,
			ownerGeneration: generation,
			authorityId,
			transportKey: capability.transportKey,
			operation,
		});
	}

	function sendAuthorityCancel(
		capability: { candidateId: string; transportKey: number },
		authorityId: number,
	): void {
		const { session, generation } = requireOwnerFence();
		const message: Extract<
			BrowserRecordWorkerMessage,
			{ type: 'authority-cancel' }
		> = {
			type: 'authority-cancel',
			authorityId,
			transportKey: capability.transportKey,
			ownerSession: session,
			ownerGeneration: generation,
		};
		if (capability.candidateId === candidateId) {
			pageAuthorityRequests.delete(authorityId);
			scope.postMessage(message);
			return;
		}
		channel?.postMessage({
			version: 1,
			type: 'authority-cancel',
			candidateId: capability.candidateId,
			ownerSession: session,
			ownerGeneration: generation,
			authorityId,
			transportKey: capability.transportKey,
		});
	}

	function announcePageTransport(): void {
		const transport = pageTransport;
		const session = currentSession;
		if (
			transport === undefined ||
			session === undefined ||
			currentGeneration === 0
		)
			return;
		if (ownerSession === session && ownerGeneration === currentGeneration) {
			registerAuthorityCapability(
				candidateId,
				transport.transportKey,
				transport.attachment,
				transport.hasCredentials,
			);
			return;
		}
		channel?.postMessage({
			version: 1,
			type: 'transport',
			candidateId,
			ownerSession: session,
			ownerGeneration: currentGeneration,
			transportKey: transport.transportKey,
			attachment: structuredClone(transport.attachment),
			hasCredentials: transport.hasCredentials,
		});
	}

	function registerAuthorityCapability(
		transportCandidateId: string,
		transportKey: number,
		attachment: ReplicaAttachment,
		hasCredentials: boolean,
	): void {
		const opened = owner;
		const relay = authorityRelay;
		if (opened === undefined || relay === undefined) return;
		const current = opened.owner.attachment;
		if (
			current.kind === 'attached' &&
			(current.attachment.deploymentId !== attachment.deploymentId ||
				current.attachment.principalId !== attachment.principalId)
		)
			return;
		relay.register(transportCandidateId, transportKey, hasCredentials);
		maybeRestoreOwnerSync(attachment);
	}

	function maybeRestoreOwnerSync(attachment: ReplicaAttachment): void {
		const opened = owner;
		const relay = authorityRelay;
		if (opened === undefined || relay === undefined || isOwnerSyncAttached)
			return;
		const current = opened.owner.attachment;
		if (
			current.kind !== 'attached' ||
			current.attachment.deploymentId !== attachment.deploymentId ||
			current.attachment.principalId !== attachment.principalId
		)
			return;
		ownerTail = ownerTail
			.then(async () => {
				if (owner !== opened || authorityRelay !== relay || isOwnerSyncAttached)
					return;
				await opened.owner.attachSync({
					attachment,
					transport: relay.transport,
					credentials: relay.credentials,
				});
				isOwnerSyncAttached = true;
			})
			.catch((cause: unknown) => {
				log.error(
					new Error('Browser owner sync restoration failed', { cause }),
				);
			});
	}

	async function attachOwnerSync(
		opened: BrowserRecordWorkerOwner,
		requestingCandidate: string,
		operation: Extract<BrowserRecordOperation, { kind: 'attach-sync' }>,
	): Promise<Extract<BrowserRecordResult, { kind: 'attach-sync' }>> {
		const relay = authorityRelay;
		if (owner !== undefined && owner.owner !== opened.owner) {
			throw new Error('Browser record owner changed while attaching sync');
		}
		if (relay === undefined)
			throw new Error('Browser authority relay is unavailable');
		if (requestingCandidate === candidateId) announcePageTransport();
		if (!relay.has(requestingCandidate, operation.transportKey)) {
			throw new Error('Browser authority transport was not registered');
		}
		await opened.owner.attachSync({
			attachment: operation.attachment,
			...(operation.firstAttachmentChoice === undefined
				? {}
				: { firstAttachmentChoice: operation.firstAttachmentChoice }),
			transport: relay.transport,
			credentials: relay.credentials,
		});
		isOwnerSyncAttached = true;
		const attachment = opened.owner.attachment;
		const syncStatus = serializeSyncStatus(opened.owner.syncStatus);
		return { kind: 'attach-sync', attachment, syncStatus };
	}

	function bindOwnerEvents(
		opened: BrowserRecordWorkerOwner,
		session: string,
		generation: number,
	): () => Promise<void> {
		function token(): string {
			nextEventId += 1;
			return `${generation}:${session}:${nextEventId}`;
		}
		const stops: (() => void)[] = [];
		try {
			stops.push(
				opened.replica.subscribe((addresses) => {
					const copied = [...structuredClone(addresses)];
					emit(
						{ type: 'records-invalidated', token: token(), addresses: copied },
						session,
						generation,
					);
					for (const address of copied) {
						if (opened.replica.visible(address)?.state !== 'tombstone')
							continue;
						emit(
							{
								type: 'address-revoked',
								token: token(),
								address,
								message: `Row document was revoked because '${addressLabel(address)}' is no longer live`,
							},
							session,
							generation,
						);
					}
				}),
			);
			stops.push(
				opened.owner.subscribeAttachment((attachment) => {
					emit(
						{
							type: 'attachment',
							token: token(),
							attachment,
						},
						session,
						generation,
					);
				}),
			);
			stops.push(
				opened.blobs.subscribe((address) => {
					emit(
						{
							type: 'blob-invalidated',
							token: token(),
							address: structuredClone(address),
						},
						session,
						generation,
					);
				}),
			);
			stops.push(
				opened.owner.subscribeSyncStatus((status) => {
					emit(
						{
							type: 'sync-status',
							token: token(),
							status: serializeSyncStatus(status),
						},
						session,
						generation,
					);
				}),
			);
		} catch (cause) {
			const failures: unknown[] = [cause];
			for (const stop of stops) {
				try {
					stop();
				} catch (cleanupCause) {
					failures.push(cleanupCause);
				}
			}
			throw failures.length === 1
				? cause
				: new AggregateError(
						failures,
						'Browser record owner event binding failed',
					);
		}
		return async () => {
			const failures: unknown[] = [];
			for (const stop of stops) {
				try {
					stop();
				} catch (cause) {
					failures.push(cause);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) {
				throw new AggregateError(
					failures,
					'Browser record owner event cleanup failed',
				);
			}
		};
	}

	function executeFor(
		candidate: string,
		request: BrowserRecordRequest,
		session: string,
		generation: number,
	): void {
		if (
			owner === undefined ||
			ownerSession !== session ||
			ownerGeneration !== generation
		)
			return;
		const key = JSON.stringify([candidate, request.id]);
		localRequests.set(key, { candidate, id: request.id });
		ownerTail = ownerTail.then(async () => {
			try {
				const active = owner;
				if (
					active === undefined ||
					ownerSession !== session ||
					ownerGeneration !== generation
				) {
					respond(candidate, ownerLostMessage(request.id), session, generation);
					return;
				}
				const result = await active.execute(request.operation, candidate);
				respond(
					candidate,
					ownerSession === session && ownerGeneration === generation
						? { type: 'result', id: request.id, result }
						: ownerLostMessage(request.id),
					session,
					generation,
				);
			} catch (cause) {
				respond(
					candidate,
					ownerSession === session && ownerGeneration === generation
						? {
								type: 'error',
								id: request.id,
								...serializeError(cause),
							}
						: ownerLostMessage(request.id),
					session,
					generation,
				);
			} finally {
				localRequests.delete(key);
			}
		});
	}

	function route(id: number, operation: BrowserRecordOperation): void {
		const session = currentSession;
		const generation = currentGeneration;
		if (session === undefined || generation === 0) {
			queued.set(id, operation);
			return;
		}
		if (ownerSession === session && ownerGeneration === generation) {
			executeFor(
				candidateId,
				{ type: 'request', id, operation },
				session,
				generation,
			);
			return;
		}
		forwarded.set(id, { ownerSession: session, ownerGeneration: generation });
		channel?.postMessage({
			version: 1,
			type: 'request',
			candidateId,
			ownerSession: session,
			ownerGeneration: generation,
			request: { type: 'request', id, operation },
		});
	}

	function acceptOwner(session: string, generation: number): void {
		if (!Number.isSafeInteger(generation) || generation <= 0) return;
		if (generation <= currentGeneration) return;
		const previousSession = currentSession;
		const previousGeneration = currentGeneration;
		for (const [authorityId, request] of pageAuthorityRequests) {
			scope.postMessage({
				type: 'authority-cancel',
				authorityId,
				transportKey: request.transportKey,
				ownerSession: request.ownerSession,
				ownerGeneration: request.ownerGeneration,
			});
		}
		pageAuthorityRequests.clear();
		currentSession = session;
		currentGeneration = generation;
		if (previousSession !== undefined || previousGeneration !== 0) {
			for (const [id, destination] of forwarded) {
				if (
					destination.ownerSession === session &&
					destination.ownerGeneration === generation
				)
					continue;
				forwarded.delete(id);
				scope.postMessage(ownerLostMessage(id));
			}
		}
		postStatus(ownerSession === session ? 'owner' : 'follower');
		for (const [id, operation] of queued) {
			queued.delete(id);
			route(id, operation);
		}
		announcePageTransport();
	}

	function receiveCoordination(
		message: BrowserRecordCoordinationMessage,
	): void {
		if (message.version !== 1) return;
		switch (message.type) {
			case 'discover':
				if (ownerSession === undefined || ownerGeneration === undefined) return;
				channel?.postMessage({
					version: 1,
					type: 'owner',
					candidateId,
					ownerSession,
					ownerGeneration,
				});
				return;
			case 'owner':
				acceptOwner(message.ownerSession, message.ownerGeneration);
				return;
			case 'request':
				executeFor(
					message.candidateId,
					message.request,
					message.ownerSession,
					message.ownerGeneration,
				);
				return;
			case 'response': {
				const destination = forwarded.get(message.message.id);
				if (
					message.candidateId !== candidateId ||
					destination?.ownerSession !== message.ownerSession ||
					destination.ownerGeneration !== message.ownerGeneration
				) {
					return;
				}
				forwarded.delete(message.message.id);
				scope.postMessage(message.message);
				return;
			}
			case 'event':
				if (
					message.ownerSession !== currentSession ||
					message.ownerGeneration !== currentGeneration
				)
					return;
				scope.postMessage(message.message);
				return;
			case 'transport':
				if (
					message.ownerSession !== ownerSession ||
					message.ownerGeneration !== ownerGeneration
				)
					return;
				registerAuthorityCapability(
					message.candidateId,
					message.transportKey,
					message.attachment,
					message.hasCredentials,
				);
				return;
			case 'transport-remove':
				if (
					message.ownerSession !== ownerSession ||
					message.ownerGeneration !== ownerGeneration
				)
					return;
				authorityRelay?.remove(message.candidateId, message.transportKey);
				return;
			case 'authority-request':
				if (
					message.candidateId !== candidateId ||
					message.ownerSession !== currentSession ||
					message.ownerGeneration !== currentGeneration ||
					pageTransport?.transportKey !== message.transportKey
				)
					return;
				pageAuthorityRequests.set(message.authorityId, {
					transportKey: message.transportKey,
					ownerSession: message.ownerSession,
					ownerGeneration: message.ownerGeneration,
				});
				scope.postMessage({
					type: 'authority-request',
					authorityId: message.authorityId,
					transportKey: message.transportKey,
					ownerSession: message.ownerSession,
					ownerGeneration: message.ownerGeneration,
					operation: message.operation,
				});
				return;
			case 'authority-cancel':
				if (
					message.candidateId !== candidateId ||
					message.ownerSession !== currentSession ||
					message.ownerGeneration !== currentGeneration
				)
					return;
				pageAuthorityRequests.delete(message.authorityId);
				scope.postMessage({
					type: 'authority-cancel',
					authorityId: message.authorityId,
					transportKey: message.transportKey,
					ownerSession: message.ownerSession,
					ownerGeneration: message.ownerGeneration,
				});
				return;
			case 'authority-result':
				if (
					message.ownerSession !== ownerSession ||
					message.ownerGeneration !== ownerGeneration
				)
					return;
				authorityRelay?.handleResponse(
					message.candidateId,
					message.transportKey,
					message.authorityId,
					{ type: 'result', result: message.result },
				);
				return;
			case 'authority-error':
				if (
					message.ownerSession !== ownerSession ||
					message.ownerGeneration !== ownerGeneration
				)
					return;
				authorityRelay?.handleResponse(
					message.candidateId,
					message.transportKey,
					message.authorityId,
					{
						type: 'error',
						code: message.code,
						...(message.activeAuthorityLifetime === undefined
							? {}
							: {
									activeAuthorityLifetime: message.activeAuthorityLifetime,
								}),
					},
				);
				return;
		}
	}

	function beginLocalOwnerLoss() {
		const lostSession = ownerSession;
		const lostGeneration = ownerGeneration;
		const opened = owner;
		const drain = ownerTail;
		authorityRelay?.dispose();
		authorityRelay = undefined;
		isOwnerSyncAttached = false;
		owner = undefined;
		ownerSession = undefined;
		ownerGeneration = undefined;
		if (
			lostSession !== undefined &&
			lostGeneration !== undefined &&
			currentSession === lostSession &&
			currentGeneration === lostGeneration
		)
			currentSession = undefined;
		let stopEvents: Promise<unknown> | undefined;
		try {
			stopEvents = opened?.stopEvents().then(
				() => undefined,
				(cause) => cause,
			);
		} catch (cause) {
			stopEvents = Promise.resolve(cause);
		}
		return { opened, drain, stopEvents };
	}

	async function finishLocalOwnerLoss({
		opened,
		drain,
		stopEvents,
	}: ReturnType<typeof beginLocalOwnerLoss>): Promise<void> {
		await drain;
		if (opened === undefined) return;
		const failures: unknown[] = [];
		const stopEventsFailure = await stopEvents;
		if (stopEventsFailure !== undefined) failures.push(stopEventsFailure);
		for (const cleanup of [() => opened.owner[Symbol.asyncDispose]()]) {
			try {
				await cleanup();
			} catch (cause) {
				failures.push(cause);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				'Lost browser record owner cleanup failed',
			);
		}
	}

	function scheduleOwnerLoss(): void {
		if (isClosed) return;
		const loss = beginLocalOwnerLoss();
		lossTransition = lossTransition.then(async () => {
			try {
				await finishLocalOwnerLoss(loss);
			} catch (cause) {
				lifecycleFailures.push(cause);
				log.error(
					new Error('Lost browser record owner cleanup failed', { cause }),
				);
			}
		});
	}

	async function compete(start: BrowserRecordCandidateStart): Promise<void> {
		let opened: BrowserRecordWorkerOwner | undefined;
		let wasStolenBeforeAdmission = false;
		try {
			const controller = new AbortController();
			openingController = controller;
			opened = await openOwner({
				onStolen: () => {
					wasStolenBeforeAdmission = owner === undefined;
					scheduleOwnerLoss();
				},
				signal: controller.signal,
				...(start.storage === undefined ? {} : { storage: start.storage }),
			});
			if (openingController === controller) openingController = undefined;
			if (isClosed) {
				await opened.owner[Symbol.asyncDispose]();
				return;
			}
			if (wasStolenBeforeAdmission) {
				await opened.owner[Symbol.asyncDispose]();
				return;
			}
			await opened.integrityCheck();
			if (opened.ownerGeneration <= currentGeneration) {
				throw new Error('browser record owner generation did not advance');
			}
			ownerSession = mintOwnerSession();
			ownerGeneration = opened.ownerGeneration;
			const session = ownerSession;
			const generation = ownerGeneration;
			const admitted = opened;
			authorityRelay = createBrowserRecordAuthorityRelay({
				sendRequest: sendAuthorityRequest,
				sendCancel: sendAuthorityCancel,
				...(authorityTimeoutMs === undefined ? {} : { authorityTimeoutMs }),
				log,
			});
			owner = {
				...admitted,
				execute: createOwnerOperations(
					admitted,
					(requestingCandidate, operation) =>
						attachOwnerSync(admitted, requestingCandidate, operation),
				),
				stopEvents: bindOwnerEvents(admitted, session, generation),
			};
			opened = undefined;
			acceptOwner(session, generation);
			channel?.postMessage({
				version: 1,
				type: 'owner',
				candidateId,
				ownerSession: session,
				ownerGeneration: generation,
			});
			emit(
				{
					type: 'attachment',
					token: `${generation}:${session}:owner-attachment`,
					attachment: admitted.owner.attachment,
				},
				session,
				generation,
			);
			emit(
				{
					type: 'sync-status',
					token: `${generation}:${session}:owner-sync-status`,
					status: serializeSyncStatus(admitted.owner.syncStatus),
				},
				session,
				generation,
			);
		} catch (cause) {
			let admissionFailure = cause;
			authorityRelay?.dispose();
			authorityRelay = undefined;
			isOwnerSyncAttached = false;
			if (opened !== undefined) {
				try {
					await opened.owner[Symbol.asyncDispose]();
				} catch (cleanupCause) {
					admissionFailure = new AggregateError(
						[cause, cleanupCause],
						'Browser record owner admission failed',
					);
				}
			}
			if (isClosed) return;
			isClosed = true;
			const error = serializeError(admissionFailure);
			scope.postMessage({ type: 'fatal', ...error });
			try {
				channel?.close();
			} catch (cleanupCause) {
				log.error(
					new Error('Browser record channel cleanup failed', {
						cause: cleanupCause,
					}),
				);
			}
			channel = undefined;
			scope.close();
		}
	}

	async function performClose(): Promise<void> {
		const failures: unknown[] = [];
		isClosed = true;
		openingController?.abort(new Error('Browser record candidate closing'));
		for (const id of queued.keys()) scope.postMessage(ownerLostMessage(id));
		for (const id of forwarded.keys()) scope.postMessage(ownerLostMessage(id));
		queued.clear();
		forwarded.clear();
		for (const transition of [acquisition]) {
			try {
				await transition;
			} catch (cause) {
				failures.push(cause);
			}
		}
		for (const transition of [lossTransition, ownerTail]) {
			try {
				await transition;
			} catch (cause) {
				failures.push(cause);
			}
		}
		failures.push(...lifecycleFailures);
		const opened = owner;
		authorityRelay?.dispose();
		authorityRelay = undefined;
		isOwnerSyncAttached = false;
		owner = undefined;
		ownerSession = undefined;
		ownerGeneration = undefined;
		if (opened !== undefined) {
			for (const cleanup of [
				() => opened.stopEvents(),
				() => opened.owner[Symbol.asyncDispose](),
			]) {
				try {
					await cleanup();
				} catch (cause) {
					failures.push(cause);
				}
			}
		}
		try {
			channel?.close();
		} catch (cause) {
			failures.push(cause);
		}
		channel = undefined;
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				'Browser record candidate cleanup failed',
			);
		}
	}

	function close(): Promise<void> {
		closure ??= performClose();
		return closure;
	}

	function unregisterPageTransport(transportKey: number): void {
		if (pageTransport?.transportKey !== transportKey) return;
		for (const [authorityId, request] of pageAuthorityRequests) {
			if (request.transportKey !== transportKey) continue;
			pageAuthorityRequests.delete(authorityId);
			scope.postMessage({
				type: 'authority-cancel',
				authorityId,
				transportKey,
				ownerSession: request.ownerSession,
				ownerGeneration: request.ownerGeneration,
			});
		}
		const session = currentSession;
		const generation = currentGeneration;
		if (
			session !== undefined &&
			generation !== 0 &&
			ownerSession === session &&
			ownerGeneration === generation
		) {
			authorityRelay?.remove(candidateId, transportKey);
		} else if (session !== undefined && generation !== 0) {
			channel?.postMessage({
				version: 1,
				type: 'transport-remove',
				candidateId,
				ownerSession: session,
				ownerGeneration: generation,
				transportKey,
			});
		}
		pageTransport = undefined;
	}

	function handlePageAuthorityResponse(
		message: Extract<
			BrowserRecordWorkerInbound,
			{ type: 'authority-result' | 'authority-error' }
		>,
	): void {
		const request = pageAuthorityRequests.get(message.authorityId);
		if (
			request === undefined ||
			request.transportKey !== message.transportKey ||
			request.ownerSession !== message.ownerSession ||
			request.ownerGeneration !== message.ownerGeneration
		)
			return;
		pageAuthorityRequests.delete(message.authorityId);
		if (
			ownerSession === message.ownerSession &&
			ownerGeneration === message.ownerGeneration
		) {
			authorityRelay?.handleResponse(
				candidateId,
				message.transportKey,
				message.authorityId,
				message.type === 'authority-result'
					? { type: 'result', result: message.result }
					: {
							type: 'error',
							code: message.code,
							...(message.activeAuthorityLifetime === undefined
								? {}
								: {
										activeAuthorityLifetime: message.activeAuthorityLifetime,
									}),
						},
			);
			return;
		}
		channel?.postMessage(
			message.type === 'authority-result'
				? {
						version: 1,
						type: 'authority-result',
						candidateId,
						ownerSession: message.ownerSession,
						ownerGeneration: message.ownerGeneration,
						authorityId: message.authorityId,
						transportKey: message.transportKey,
						result: message.result,
					}
				: {
						version: 1,
						type: 'authority-error',
						candidateId,
						ownerSession: message.ownerSession,
						ownerGeneration: message.ownerGeneration,
						authorityId: message.authorityId,
						transportKey: message.transportKey,
						code: message.code,
						...(message.activeAuthorityLifetime === undefined
							? {}
							: {
									activeAuthorityLifetime: message.activeAuthorityLifetime,
								}),
					},
		);
	}

	scope.addEventListener('message', ({ data: message }) => {
		if (message.type === 'start') {
			if (isStarted) {
				scope.postMessage({
					type: 'fatal',
					name: 'Error',
					message: 'browser record candidate is already started',
				});
				return;
			}
			isStarted = true;
			channel = createChannel(
				message.coordinationId ?? DEFAULT_COORDINATION_ID,
			);
			channel.onmessage = ({ data }) => receiveCoordination(data);
			postStatus('waiting');
			channel.postMessage({
				version: 1,
				type: 'discover',
				candidateId,
			});
			acquisition = compete(message);
			return;
		}
		if (message.type === 'transport-register') {
			if (
				!Number.isSafeInteger(message.transportKey) ||
				message.transportKey <= 0
			)
				return;
			if (
				pageTransport !== undefined &&
				pageTransport.transportKey !== message.transportKey
			) {
				unregisterPageTransport(pageTransport.transportKey);
			}
			pageTransport = {
				transportKey: message.transportKey,
				attachment: structuredClone(message.attachment),
				hasCredentials: message.hasCredentials,
			};
			announcePageTransport();
			return;
		}
		if (message.type === 'transport-credentials') {
			if (pageTransport?.transportKey !== message.transportKey) return;
			pageTransport.hasCredentials = message.hasCredentials;
			if (
				ownerSession === currentSession &&
				ownerGeneration === currentGeneration
			) {
				authorityRelay?.credentialsChanged(
					candidateId,
					message.transportKey,
					message.hasCredentials,
				);
			} else {
				announcePageTransport();
			}
			return;
		}
		if (message.type === 'transport-unregister') {
			unregisterPageTransport(message.transportKey);
			return;
		}
		if (
			message.type === 'authority-result' ||
			message.type === 'authority-error'
		) {
			handlePageAuthorityResponse(message);
			return;
		}
		if (message.type === 'request') {
			if (!isStarted || isClosed) {
				scope.postMessage({
					type: 'error',
					id: message.id,
					name: 'Error',
					message: 'browser record candidate is not available',
				});
				return;
			}
			route(message.id, message.operation);
			return;
		}
		if (pageTransport !== undefined) {
			if (
				ownerSession === currentSession &&
				ownerGeneration === currentGeneration
			) {
				pageTransport = undefined;
			} else {
				unregisterPageTransport(pageTransport.transportKey);
			}
		}
		void close()
			.then(() => scope.postMessage({ type: 'closed' }))
			.catch((cause: unknown) => {
				const error = serializeError(cause);
				scope.postMessage({ type: 'fatal', ...error });
			})
			.finally(() => scope.close());
	});
}

function createBrowserRecordCoordinationChannel(
	name: string,
): BrowserRecordCoordinationChannel {
	const channel = new BroadcastChannel(name);
	const runtime: BrowserRecordCoordinationChannel = {
		onmessage: null,
		postMessage(message) {
			channel.postMessage(message);
		},
		close() {
			channel.close();
		},
	};
	channel.onmessage = ({ data }) =>
		runtime.onmessage?.({ data: data as BrowserRecordCoordinationMessage });
	return runtime;
}

async function openBrowserRecordWorkerOwner({
	onStolen,
	signal,
	storage,
}: {
	onStolen(): void;
	signal: AbortSignal;
	storage?: BrowserRecordCandidateStart['storage'];
}): Promise<BrowserRecordWorkerOwner> {
	const storageOwner: BrowserReplicaOwner = await openBrowserReplicaOwner({
		limits: SCALAR_SYNC_V1_LIMITS,
		initialize: { replicaId: mintReplicaId() },
		onStolen,
		signal,
		...(storage ?? {}),
	});
	const owner = createRecordOwner({
		replica: storageOwner.store,
		blobs: storageOwner.blobs,
		dispose: () => storageOwner.dispose(),
	});
	return {
		owner,
		replica: storageOwner.store,
		blobs: storageOwner.blobs,
		ownerGeneration: storageOwner.ownerGeneration,
		integrityCheck: () => storageOwner.integrityCheck(),
		captureSnapshot: (options) => storageOwner.captureSnapshot(options),
	};
}
