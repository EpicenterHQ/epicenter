import type { BlobAcceptance } from '../blob-v1/index.js';
import type { DocumentAcceptance } from '../document-v1/index.js';
import type {
	FactsRequest,
	FactsResponse,
	RecordAddress,
	SubmissionResponse,
} from '../protocol/v1/index.js';
import {
	PUBLICATION_OBLIGATION_PAGE_LIMIT,
	type ReplicaAttachment,
	type ReplicaBlobStore,
	type ReplicaStore,
} from '../store/replica/index.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

type Plane = 'scalar' | 'facts' | 'documents' | 'blobs';

export type AuthorityCarrier<TBlobBytes = unknown> = {
	fetchFacts(request: FactsRequest): Promise<FactsResponse>;
	submit(sealedRequestBytes: string): Promise<SubmissionResponse>;
	publishDocument(
		address: RecordAddress,
		publication: Extract<
			ReturnType<ReplicaStore['documentPublication']>,
			{ kind: 'ready' }
		>['publication'],
	): Promise<DocumentAcceptance>;
	publishBlob(
		address: RecordAddress,
		publication: NonNullable<
			Awaited<ReturnType<ReplicaBlobStore<unknown, TBlobBytes>['publication']>>
		>['request'],
		bytes: TBlobBytes,
	): Promise<BlobAcceptance>;
};

export type RuntimeSchedule = (task: () => void, delayMs: number) => () => void;

export type RuntimeBackoff = {
	now(): number;
	delay(attempt: number, plane: Plane): number;
	schedule: RuntimeSchedule;
};

export type SyncStatus = {
	state:
		| 'unattached'
		| 'attaching-first'
		| 'idle'
		| 'syncing'
		| 'offline'
		| 'signed-out';
	attachment: ReplicaAttachment | null;
};

export type AttachOutcome =
	| { kind: 'attached' }
	| {
			kind: 'first-attachment-choice';
			proceed(choice: 'bring' | 'discard'): void;
	  };

export type CreateRuntimeSupervisorOptions<TBlobSource, TBlobBytes> = {
	store: ReplicaStore;
	blobs: ReplicaBlobStore<TBlobSource, TBlobBytes> | null;
	carrier: AuthorityCarrier<TBlobBytes> | null;
	onInvalidate(addresses: RecordAddress[]): void;
	onStatus(status: SyncStatus): void;
	intervalMs?: number;
	backoff?: RuntimeBackoff;
};

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}

function defaultBackoff(): RuntimeBackoff {
	return {
		now: Date.now,
		delay(attempt) {
			return Math.min(DEFAULT_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
		},
		schedule: scheduleTimeout,
	};
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function isLifetimeMismatch(cause: unknown): boolean {
	return (
		(typeof cause === 'object' &&
			cause !== null &&
			'name' in cause &&
			cause.name === 'LifetimeMismatch') ||
		/lifetime mismatch|lifetime does not match/u.test(errorMessage(cause))
	);
}

// A record can stop being visibly live between an owed scan and the capture
// or settlement it feeds: tombstoned (obligation reaped), or reversibly unset
// (document/blob state preserved but not publishable until resurrection,
// ADR-0160). Both are ordinary per-address races, never plane failures.
function isRecordLivenessRace(cause: unknown): boolean {
	return /(document|blob) record is (absent|tombstoned|not live)/u.test(
		errorMessage(cause),
	);
}

/**
 * Own the one runtime lifetime that drains every replica obligation.
 *
 * Disposal is strict: `nudge`, `setCarrier`, `attach`, and `drainOnce` throw
 * after disposal. `status` remains readable.
 */
export function createRuntimeSupervisor<TBlobSource, TBlobBytes>({
	store,
	blobs,
	carrier: initialCarrier,
	onInvalidate,
	onStatus,
	intervalMs = DEFAULT_INTERVAL_MS,
	backoff = defaultBackoff(),
}: CreateRuntimeSupervisorOptions<TBlobSource, TBlobBytes>) {
	let carrier = initialCarrier;
	let currentStatus: SyncStatus = initialStatus();
	let isDisposed = false;
	let requestedFollowUp = false;
	let running: Promise<void> | undefined;
	let cancelScheduled: (() => void) | undefined;
	let attachmentDemand = false;
	const attempts: Record<Plane, number> = {
		scalar: 0,
		facts: 0,
		documents: 0,
		blobs: 0,
	};
	const blockedUntil: Record<Plane, number> = {
		scalar: 0,
		facts: 0,
		documents: 0,
		blobs: 0,
	};

	function initialStatus(): SyncStatus {
		const attachment = store.attachment();
		return {
			state:
				attachment === null
					? 'unattached'
					: initialCarrier === null
						? 'signed-out'
						: 'idle',
			attachment,
		};
	}

	function assertActive(): void {
		if (isDisposed) throw new Error('runtime supervisor is disposed');
	}

	function setStatus(state: SyncStatus['state']): void {
		const next = { state, attachment: store.attachment() };
		if (
			next.state === currentStatus.state &&
			next.attachment?.deploymentId ===
				currentStatus.attachment?.deploymentId &&
			next.attachment?.principalId === currentStatus.attachment?.principalId
		) {
			return;
		}
		currentStatus = next;
		onStatus(structuredClone(next));
	}

	function cancelWake(): void {
		cancelScheduled?.();
		cancelScheduled = undefined;
	}

	function scheduleWake(delayMs: number): void {
		if (isDisposed || carrier === null || store.attachment() === null) return;
		cancelWake();
		cancelScheduled = backoff.schedule(() => {
			cancelScheduled = undefined;
			if (!isDisposed) void requestDrain();
		}, delayMs);
	}

	function planeReady(plane: Plane): boolean {
		return backoff.now() >= blockedUntil[plane];
	}

	function planeSucceeded(plane: Plane): void {
		attempts[plane] = 0;
		blockedUntil[plane] = 0;
	}

	function planeFailed(plane: Plane): void {
		const delay = backoff.delay(attempts[plane], plane);
		attempts[plane] += 1;
		blockedUntil[plane] = backoff.now() + delay;
	}

	function resetBackoff(): void {
		for (const plane of Object.keys(attempts) as Plane[]) {
			planeSucceeded(plane);
		}
	}

	function replaceAuthority(): void {
		store.erase();
		setStatus('idle');
		scheduleWake(0);
	}

	async function runScalar(
		activeCarrier: AuthorityCarrier<TBlobBytes>,
		invalidated: Map<string, RecordAddress>,
	): Promise<'ok' | 'failed' | 'replaced'> {
		if (!planeReady('scalar') || store.sync().authorityLifetime === null) {
			return 'ok';
		}
		try {
			while (!isDisposed) {
				let sealed = store.sealedRequest();
				if (sealed === null) {
					try {
						sealed = store.seal();
					} catch (cause) {
						if (errorMessage(cause) === 'nothing to seal') break;
						throw cause;
					}
				}
				const response = await activeCarrier.submit(sealed.bytes);
				if (isDisposed || carrier !== activeCarrier) return 'ok';
				if (response.authorityLifetime !== store.sync().authorityLifetime) {
					replaceAuthority();
					return 'replaced';
				}
				store.settle(response);
				for (const fact of response.facts) {
					invalidated.set(JSON.stringify(fact.address), fact.address);
				}
			}
			planeSucceeded('scalar');
			return 'ok';
		} catch (cause) {
			if (isLifetimeMismatch(cause)) {
				replaceAuthority();
				return 'replaced';
			}
			planeFailed('scalar');
			return 'failed';
		}
	}

	async function runFacts(
		activeCarrier: AuthorityCarrier<TBlobBytes>,
		invalidated: Map<string, RecordAddress>,
	): Promise<'ok' | 'failed' | 'replaced'> {
		if (!planeReady('facts')) return 'ok';
		try {
			let hasMore: boolean;
			do {
				const sync = store.sync();
				const request: FactsRequest = {
					...(sync.authorityLifetime === null
						? {}
						: { authorityLifetime: sync.authorityLifetime }),
					afterSequence: sync.afterSequence,
				};
				const response = await activeCarrier.fetchFacts(request);
				if (isDisposed || carrier !== activeCarrier) return 'ok';
				if (
					request.authorityLifetime !== undefined &&
					response.authorityLifetime !== request.authorityLifetime
				) {
					replaceAuthority();
					return 'replaced';
				}
				store.installFacts({ request, response });
				for (const fact of response.facts) {
					invalidated.set(JSON.stringify(fact.address), fact.address);
				}
				hasMore = response.hasMore;
			} while (hasMore && !isDisposed);
			planeSucceeded('facts');
			return 'ok';
		} catch (cause) {
			if (isLifetimeMismatch(cause)) {
				replaceAuthority();
				return 'replaced';
			}
			planeFailed('facts');
			return 'failed';
		}
	}

	async function runDocuments(
		activeCarrier: AuthorityCarrier<TBlobBytes>,
		invalidated: Map<string, RecordAddress>,
	): Promise<'ok' | 'failed' | 'replaced'> {
		if (!planeReady('documents') || store.sync().authorityLifetime === null) {
			return 'ok';
		}
		try {
			let addresses: RecordAddress[];
			do {
				addresses = store.owedDocuments(PUBLICATION_OBLIGATION_PAGE_LIMIT);
				for (const address of addresses) {
					if (isDisposed) return 'ok';
					try {
						const state = store.documentPublication(address);
						if (state.kind !== 'ready') continue;
						const acceptance = await activeCarrier.publishDocument(
							address,
							state.publication,
						);
						if (isDisposed || carrier !== activeCarrier) return 'ok';
						if (acceptance.kind === 'lifetime-mismatch') {
							replaceAuthority();
							return 'replaced';
						}
						const proof =
							acceptance.kind === 'accepted' ? acceptance.receipt : acceptance;
						store.settleDocumentPublication(address, proof, {
							revision: state.publication.capturedRevision,
							digest: state.publication.digest,
						});
						invalidated.set(JSON.stringify(address), address);
					} catch (cause) {
						// One address's liveness race must not abort the rest of the
						// page; every other failure still fails the plane.
						if (!isRecordLivenessRace(cause)) throw cause;
					}
				}
			} while (
				addresses.length === PUBLICATION_OBLIGATION_PAGE_LIMIT &&
				!isDisposed
			);
			planeSucceeded('documents');
			return 'ok';
		} catch (cause) {
			if (isLifetimeMismatch(cause)) {
				replaceAuthority();
				return 'replaced';
			}
			planeFailed('documents');
			return 'failed';
		}
	}

	async function runBlobs(
		activeCarrier: AuthorityCarrier<TBlobBytes>,
		invalidated: Map<string, RecordAddress>,
	): Promise<'ok' | 'failed' | 'replaced'> {
		if (
			blobs === null ||
			!planeReady('blobs') ||
			store.sync().authorityLifetime === null
		) {
			return 'ok';
		}
		try {
			let addresses: RecordAddress[];
			do {
				addresses = store.owedBlobs(PUBLICATION_OBLIGATION_PAGE_LIMIT);
				for (const address of addresses) {
					if (isDisposed) return 'ok';
					try {
						const publication = await blobs.publication(address);
						if (publication === null) continue;
						const acceptance = await activeCarrier.publishBlob(
							address,
							publication.request,
							publication.bytes,
						);
						if (isDisposed || carrier !== activeCarrier) return 'ok';
						if (acceptance.kind === 'lifetime-mismatch') {
							replaceAuthority();
							return 'replaced';
						}
						await blobs.settle(address, acceptance);
						invalidated.set(JSON.stringify(address), address);
					} catch (cause) {
						// Same per-address liveness-race isolation as documents.
						if (!isRecordLivenessRace(cause)) throw cause;
					}
				}
			} while (
				addresses.length === PUBLICATION_OBLIGATION_PAGE_LIMIT &&
				!isDisposed
			);
			planeSucceeded('blobs');
			return 'ok';
		} catch (cause) {
			if (isLifetimeMismatch(cause)) {
				replaceAuthority();
				return 'replaced';
			}
			planeFailed('blobs');
			return 'failed';
		}
	}

	async function pass(): Promise<void> {
		const activeCarrier = carrier;
		if (activeCarrier === null) {
			setStatus(store.attachment() === null ? 'unattached' : 'signed-out');
			return;
		}
		if (store.attachment() === null) {
			setStatus(attachmentDemand ? 'attaching-first' : 'unattached');
			return;
		}

		setStatus('syncing');
		const invalidated = new Map<string, RecordAddress>();
		let failed = false;

		if (store.sync().authorityLifetime === null) {
			const bootstrap = await runFacts(activeCarrier, invalidated);
			failed ||= bootstrap === 'failed';
			if (bootstrap === 'replaced' || isDisposed) return;
		}

		const scalar = await runScalar(activeCarrier, invalidated);
		failed ||= scalar === 'failed';
		if (scalar === 'replaced' || isDisposed) return;

		const facts = await runFacts(activeCarrier, invalidated);
		failed ||= facts === 'failed';
		if (facts === 'replaced' || isDisposed) return;

		const documents = await runDocuments(activeCarrier, invalidated);
		failed ||= documents === 'failed';
		if (documents === 'replaced' || isDisposed) return;

		const blobResult = await runBlobs(activeCarrier, invalidated);
		failed ||= blobResult === 'failed';
		if (blobResult === 'replaced' || isDisposed) return;

		if (invalidated.size > 0) onInvalidate([...invalidated.values()]);
		setStatus(failed ? 'offline' : 'idle');
		if (failed) {
			const nextRetry = Math.min(
				...Object.values(blockedUntil).filter((time) => time > backoff.now()),
			);
			scheduleWake(
				Number.isFinite(nextRetry)
					? Math.max(0, nextRetry - backoff.now())
					: intervalMs,
			);
		} else {
			scheduleWake(intervalMs);
		}
	}

	function requestDrain(): Promise<void> {
		assertActive();
		cancelWake();
		if (running !== undefined) {
			requestedFollowUp = true;
			return running;
		}
		running = pass().finally(() => {
			running = undefined;
			if (requestedFollowUp && !isDisposed) {
				requestedFollowUp = false;
				void requestDrain();
			}
		});
		return running;
	}

	const supervisor = {
		nudge(): void {
			assertActive();
			if (running === undefined) scheduleWake(0);
			else requestedFollowUp = true;
		},
		setCarrier(nextCarrier: AuthorityCarrier<TBlobBytes> | null): void {
			assertActive();
			carrier = nextCarrier;
			resetBackoff();
			cancelWake();
			if (nextCarrier === null) {
				setStatus(store.attachment() === null ? 'unattached' : 'signed-out');
				return;
			}
			if (store.attachment() !== null) scheduleWake(0);
		},
		attach(
			pair: ReplicaAttachment,
			choice?: 'bring' | 'discard',
		): AttachOutcome {
			assertActive();
			if (
				store.attachment() === null &&
				!store.isLogicallyEmpty() &&
				choice === undefined
			) {
				attachmentDemand = true;
				setStatus('attaching-first');
				let proceeded = false;
				return {
					kind: 'first-attachment-choice',
					proceed(selectedChoice) {
						assertActive();
						if (proceeded) {
							throw new Error('first-attachment choice was already resolved');
						}
						proceeded = true;
						store.attach({ ...pair, choice: selectedChoice });
						attachmentDemand = false;
						setStatus(carrier === null ? 'signed-out' : 'idle');
						if (carrier !== null) scheduleWake(0);
					},
				};
			}
			store.attach({ ...pair, ...(choice === undefined ? {} : { choice }) });
			attachmentDemand = false;
			setStatus(carrier === null ? 'signed-out' : 'idle');
			if (carrier !== null) scheduleWake(0);
			return { kind: 'attached' };
		},
		drainOnce(): Promise<void> {
			return requestDrain();
		},
		status(): SyncStatus {
			return structuredClone(currentStatus);
		},
		async dispose(): Promise<void> {
			if (isDisposed) return;
			isDisposed = true;
			cancelWake();
			requestedFollowUp = false;
			await running;
		},
	};

	return supervisor;
}

export type RuntimeSupervisor<
	TBlobSource = unknown,
	TBlobBytes = unknown,
> = ReturnType<typeof createRuntimeSupervisor<TBlobSource, TBlobBytes>>;
