import { createLogger, type Logger } from 'wellcrafted/logger';
import type {
	BlobAcceptance,
	BlobPublicationRequest,
} from './blob-v1/index.js';
import type {
	DocumentAcceptance,
	DocumentPublicationRequest,
} from './document-v1/index.js';
import type {
	FactsRequest,
	FactsResponse,
	SubmissionResponse,
} from './protocol/v1/index.js';
import type {
	FirstAttachmentChoice,
	ReplicaAttachment,
	ReplicaBlobStore,
	ReplicaParkedWorkPage,
	ReplicaStore,
	ReplicaWorkSummary,
	SealedRequest,
} from './store/replica/index.js';
import type { SyncCredentialProvider, SyncSchedule } from './sync-types.js';

const DEFAULT_DRAIN_INTERVAL_MS = 30_000;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

export type RecordSyncState =
	| 'local'
	| 'syncing'
	| 'idle'
	| 'offline'
	| 'authentication-required';

export type RecordSyncStatus = {
	state: RecordSyncState;
	work: ReplicaWorkSummary;
	authorityLifetime?: string;
	lastError?: Error;
};

export type RecordSyncTransport<TBlobRead> = {
	readFacts(request: FactsRequest): Promise<FactsResponse>;
	submit(request: SealedRequest): Promise<SubmissionResponse>;
	publishDocument(
		request: DocumentPublicationRequest,
	): Promise<DocumentAcceptance>;
	publishBlob(publication: {
		request: BlobPublicationRequest;
		bytes: TBlobRead;
	}): Promise<BlobAcceptance>;
};

export type RecordSyncSession<TBlobRead> = {
	attachment: ReplicaAttachment;
	firstAttachmentChoice?: FirstAttachmentChoice;
	transport: RecordSyncTransport<TBlobRead>;
	credentials?: SyncCredentialProvider;
};

export class RecordAuthorityLifetimeMismatchError extends Error {
	override readonly name = 'RecordAuthorityLifetimeMismatch';

	constructor(readonly activeAuthorityLifetime: string) {
		super('Authority lifetime changed');
	}
}

/** A dispatched page-owned transport call was canceled without a result. */
export class RecordSyncTransportCancelledError extends Error {
	override readonly name = 'RecordSyncTransportCancelled';
}

class DrainCancelled extends Error {}

/** Own attachment, automatic plane drains, retry, status, and disposal. */
export function createRecordSyncSupervisor<TSource, TBlobRead>({
	replica,
	blobs,
	drainIntervalMs = DEFAULT_DRAIN_INTERVAL_MS,
	schedule = scheduleTimeout,
	log = createLogger('data/sync'),
}: {
	replica: ReplicaStore;
	blobs: ReplicaBlobStore<TSource, TBlobRead>;
	drainIntervalMs?: number;
	schedule?: SyncSchedule;
	log?: Logger;
}) {
	const listeners = new Set<(status: RecordSyncStatus) => void>();
	const initialLifetime = replica.sync().authorityLifetime;
	let status: RecordSyncStatus = {
		state: 'local',
		work: replica.workSummary(),
		...(initialLifetime === null ? {} : { authorityLifetime: initialLifetime }),
	};
	let session: RecordSyncSession<TBlobRead> | undefined;
	let stopCredentials: (() => void) | undefined;
	let cancelScheduled: (() => void) | undefined;
	let running: Promise<void> | undefined;
	let runningGeneration: number | undefined;
	let runRequested = false;
	let retryAttempt = 0;
	let requiresReattach = false;
	let generation = 0;
	let isDisposed = false;

	function equalWork(
		left: ReplicaWorkSummary,
		right: ReplicaWorkSummary,
	): boolean {
		return (
			left.scalar.pending === right.scalar.pending &&
			left.scalar.sealed === right.scalar.sealed &&
			left.scalar.parked === right.scalar.parked &&
			left.document.owed === right.document.owed &&
			left.document.parked === right.document.parked &&
			left.blob.owed === right.blob.owed &&
			left.blob.parked === right.blob.parked
		);
	}

	function setStatus(state: RecordSyncState, lastError?: Error): void {
		const work = replica.workSummary();
		const authorityLifetime = replica.sync().authorityLifetime ?? undefined;
		if (
			status.state === state &&
			status.authorityLifetime === authorityLifetime &&
			status.lastError?.message === lastError?.message &&
			equalWork(status.work, work)
		) {
			return;
		}
		status = {
			state,
			work,
			...(authorityLifetime === undefined ? {} : { authorityLifetime }),
			...(lastError === undefined ? {} : { lastError }),
		};
		for (const listener of listeners) {
			try {
				listener(status);
			} catch (cause) {
				log.error(new Error('Sync status subscriber threw', { cause }));
			}
		}
	}

	function hasCredentials(): boolean {
		return (
			session?.credentials === undefined ||
			session.credentials.get() !== undefined
		);
	}

	function cancelWake(): void {
		cancelScheduled?.();
		cancelScheduled = undefined;
	}

	function scheduleWake(delayMs: number): void {
		cancelWake();
		cancelScheduled = schedule(() => {
			cancelScheduled = undefined;
			void requestDrain();
		}, delayMs);
	}

	function retryDelay(): number {
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		return delay;
	}

	function requireActive(activeGeneration: number): void {
		if (isDisposed || activeGeneration !== generation)
			throw new DrainCancelled();
	}

	async function drainFacts(
		activeGeneration: number,
		transport: RecordSyncTransport<TBlobRead>,
	): Promise<boolean> {
		const sync = replica.sync();
		const request: FactsRequest = {
			...(sync.authorityLifetime === null
				? {}
				: { authorityLifetime: sync.authorityLifetime }),
			afterSequence: sync.afterSequence,
		};
		const response = await transport.readFacts(request);
		requireActive(activeGeneration);
		replica.installFacts({ request, response });
		return response.hasMore || response.facts.length > 0;
	}

	async function drainScalar(
		activeGeneration: number,
		transport: RecordSyncTransport<TBlobRead>,
	): Promise<boolean> {
		if (replica.sync().authorityLifetime === null) return false;
		let sealed = replica.sealedRequest();
		if (sealed === null && replica.workSummary().scalar.pending > 0) {
			sealed = replica.seal();
		}
		if (sealed === null) return false;
		const response = await transport.submit(sealed);
		requireActive(activeGeneration);
		replica.settle(response);
		return true;
	}

	async function drainDocuments(
		activeGeneration: number,
		transport: RecordSyncTransport<TBlobRead>,
	): Promise<boolean> {
		let progressed = false;
		for (const address of replica.owedDocuments()) {
			const state = replica.documentPublication(address);
			if (
				state.kind === 'settled' ||
				state.kind === 'not-settled' ||
				state.kind === 'refused'
			) {
				continue;
			}
			const { capturedRevision, ...request } = state.publication;
			const acceptance = await transport.publishDocument(request);
			requireActive(activeGeneration);
			switch (acceptance.kind) {
				case 'accepted':
					replica.settleDocumentPublication(address, acceptance.receipt, {
						revision: capturedRevision,
						digest: request.digest,
					});
					progressed = true;
					break;
				case 'document-bound':
					replica.settleDocumentPublication(address, acceptance, {
						revision: capturedRevision,
						digest: request.digest,
					});
					progressed = true;
					break;
				case 'record-not-live':
					// The scalar plane owns record liveness. Leave the document owed
					// and wait for a later facts pass instead of persisting a second
					// liveness state or immediately retrying the same publication.
					break;
				case 'lifetime-mismatch':
					await replaceSupersededReplica(activeGeneration);
					return true;
			}
		}
		return progressed;
	}

	async function drainBlobs(
		activeGeneration: number,
		transport: RecordSyncTransport<TBlobRead>,
	): Promise<boolean> {
		let progressed = false;
		for (const address of replica.owedBlobs()) {
			const publication = await blobs.publication(address);
			if (publication === null) continue;
			const acceptance = await transport.publishBlob(publication);
			requireActive(activeGeneration);
			if (acceptance.kind === 'lifetime-mismatch') {
				await replaceSupersededReplica(activeGeneration);
				return true;
			}
			await blobs.settle(address, acceptance);
			progressed = true;
		}
		return progressed;
	}

	async function replaceSupersededReplica(
		activeGeneration: number,
	): Promise<void> {
		requireActive(activeGeneration);
		replica.erase();
		await blobs.sweepDebris();
		requireActive(activeGeneration);
	}

	async function drain(activeGeneration: number): Promise<void> {
		let replacedLifetime: string | undefined;
		while (
			runRequested &&
			!isDisposed &&
			activeGeneration === generation &&
			session !== undefined
		) {
			runRequested = false;
			if (!hasCredentials()) {
				setStatus('authentication-required');
				return;
			}
			setStatus('syncing', status.lastError);
			const transport = session.transport;
			try {
				const errors: unknown[] = [];
				async function attempt(
					operation: () => Promise<boolean>,
				): Promise<boolean> {
					try {
						return await operation();
					} catch (cause) {
						if (
							cause instanceof DrainCancelled ||
							cause instanceof RecordSyncTransportCancelledError
						)
							throw cause;
						errors.push(cause);
						return false;
					}
				}
				const factsProgress = await attempt(() =>
					drainFacts(activeGeneration, transport),
				);
				requireActive(activeGeneration);
				const scalarProgress = await attempt(() =>
					drainScalar(activeGeneration, transport),
				);
				requireActive(activeGeneration);
				const documentProgress = await attempt(() =>
					drainDocuments(activeGeneration, transport),
				);
				requireActive(activeGeneration);
				const blobProgress = await attempt(() =>
					drainBlobs(activeGeneration, transport),
				);
				requireActive(activeGeneration);
				const mismatch = errors.find(
					(error): error is RecordAuthorityLifetimeMismatchError =>
						error instanceof RecordAuthorityLifetimeMismatchError,
				);
				if (mismatch !== undefined) {
					if (replacedLifetime === mismatch.activeAuthorityLifetime) {
						throw new Error(
							'Authority repeated one lifetime mismatch after erase',
						);
					}
					replacedLifetime = mismatch.activeAuthorityLifetime;
					await replaceSupersededReplica(activeGeneration);
					runRequested = true;
					continue;
				}
				if (errors.length > 0) {
					throw errors.length === 1
						? errors[0]
						: new AggregateError(errors, 'Epicenter synchronization failed');
				}
				const work = replica.workSummary();
				const retryImmediately =
					factsProgress ||
					scalarProgress ||
					documentProgress ||
					blobProgress ||
					work.scalar.pending > 0 ||
					work.scalar.sealed > 0;
				retryAttempt = 0;
				setStatus('idle');
				if (retryImmediately) runRequested = true;
			} catch (cause) {
				if (cause instanceof DrainCancelled) return;
				if (cause instanceof RecordSyncTransportCancelledError) {
					requiresReattach = true;
					setStatus('offline', cause);
					runRequested = false;
					return;
				}
				const error =
					cause instanceof Error
						? cause
						: new Error('Epicenter synchronization failed', { cause });
				setStatus('offline', error);
				runRequested = false;
				scheduleWake(retryDelay());
				return;
			}
		}
		if (!isDisposed && activeGeneration === generation && hasCredentials()) {
			scheduleWake(drainIntervalMs);
		}
	}

	function requestDrain(): Promise<void> {
		if (isDisposed || session === undefined) {
			setStatus('local');
			return Promise.resolve();
		}
		if (requiresReattach) return Promise.resolve();
		cancelWake();
		runRequested = true;
		if (running !== undefined) {
			return runningGeneration === generation
				? running
				: running.then(() => requestDrain());
		}
		const activeGeneration = generation;
		runningGeneration = activeGeneration;
		running = drain(activeGeneration).finally(() => {
			running = undefined;
			runningGeneration = undefined;
			if (runRequested && !isDisposed && activeGeneration === generation) {
				void requestDrain();
			}
		});
		return running;
	}

	function credentialsChanged(): void {
		if (isDisposed || session === undefined) return;
		if (requiresReattach) return;
		generation += 1;
		cancelWake();
		if (!hasCredentials()) {
			runRequested = false;
			setStatus('authentication-required');
			return;
		}
		void requestDrain();
	}

	const stopReplica = replica.subscribe(() => {
		setStatus(status.state, status.lastError);
		void requestDrain();
	});
	const stopBlobs = blobs.subscribe(() => {
		setStatus(status.state, status.lastError);
		void requestDrain();
	});

	return {
		async attach(next: RecordSyncSession<TBlobRead>): Promise<void> {
			if (isDisposed) throw new Error('Sync supervisor is disposed');
			requiresReattach = false;
			const attached = replica.attach(
				next.attachment,
				next.firstAttachmentChoice,
			);
			generation += 1;
			cancelWake();
			stopCredentials?.();
			if (attached.discarded) await blobs.sweepDebris();
			session = next;
			stopCredentials = next.credentials?.subscribe?.(credentialsChanged);
			if (!hasCredentials()) {
				setStatus('authentication-required');
				return;
			}
			await requestDrain();
		},
		requestDrain,
		get status(): RecordSyncStatus {
			return status;
		},
		parked(
			after?: Parameters<ReplicaStore['parkedWork']>[0],
		): ReplicaParkedWorkPage {
			return replica.parkedWork(after);
		},
		subscribe(listener: (next: RecordSyncStatus) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;
			generation += 1;
			cancelWake();
			stopCredentials?.();
			stopCredentials = undefined;
			stopReplica();
			stopBlobs();
			session = undefined;
			listeners.clear();
		},
	};
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
