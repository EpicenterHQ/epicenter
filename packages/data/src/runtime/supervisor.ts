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
		publication: Extract<
			Awaited<ReturnType<ReplicaBlobStore<unknown, TBlobBytes>['publication']>>,
			{ kind: 'ready' }
		>['publication']['request'],
		bytes: TBlobBytes,
	): Promise<BlobAcceptance>;
};

export type RuntimeSchedule = (task: () => void, delayMs: number) => () => void;

export type RuntimeBackoff = {
	now(): number;
	delay(attempt: number, plane: Plane): number;
	schedule: RuntimeSchedule;
};

/**
 * `local-only` is the one carrier-less state: the runtime was opened without
 * synchronization authority (an unclaimed replica, or an account replica
 * while signed out) and every durable obligation stays local until a later
 * carrier-bearing open of the same replica.
 */
export type SyncStatus = {
	state: 'local-only' | 'idle' | 'syncing' | 'offline';
};

export type CreateRuntimeSupervisorOptions<TBlobSource, TBlobBytes> = {
	store: ReplicaStore;
	blobs: ReplicaBlobStore<TBlobSource, TBlobBytes> | null;
	carrier: AuthorityCarrier<TBlobBytes> | null;
	onInvalidate(addresses: RecordAddress[]): void;
	onAuthorityReplacement(): void;
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

function isLifetimeMismatch(cause: unknown): boolean {
	return (
		typeof cause === 'object' &&
		cause !== null &&
		'name' in cause &&
		cause.name === 'LifetimeMismatch'
	);
}

/**
 * Own the one runtime lifetime that drains every replica obligation.
 *
 * The carrier is fixed for this lifetime: a supervisor opened without one is
 * permanently local-only, and a takeover replacement reconstructed from the
 * same open configuration is correct by construction (ADR-0178).
 *
 * Disposal is strict: `nudge` and `drainOnce` throw after disposal. `status`
 * remains readable.
 */
export function createRuntimeSupervisor<TBlobSource, TBlobBytes>({
	store,
	blobs,
	carrier,
	onInvalidate,
	onAuthorityReplacement,
	onStatus,
	intervalMs = DEFAULT_INTERVAL_MS,
	backoff = defaultBackoff(),
}: CreateRuntimeSupervisorOptions<TBlobSource, TBlobBytes>) {
	let currentStatus: SyncStatus = {
		state: carrier === null ? 'local-only' : 'idle',
	};
	let isDisposed = false;
	let requestedFollowUp = false;
	let running: Promise<void> | undefined;
	let cancelScheduled: (() => void) | undefined;
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

	function assertActive(): void {
		if (isDisposed) throw new Error('runtime supervisor is disposed');
	}

	function setStatus(state: SyncStatus['state']): void {
		if (state === currentStatus.state) return;
		currentStatus = { state };
		onStatus(structuredClone(currentStatus));
	}

	function cancelWake(): void {
		cancelScheduled?.();
		cancelScheduled = undefined;
	}

	function scheduleWake(delayMs: number): void {
		if (isDisposed || carrier === null) return;
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

	function replaceAuthority(): void {
		onAuthorityReplacement();
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
					const outcome = store.seal();
					if (outcome.kind === 'empty') break;
					sealed = outcome.request;
				}
				const response = await activeCarrier.submit(sealed.bytes);
				if (isDisposed) return 'ok';
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
				if (isDisposed) return 'ok';
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
					const state = store.documentPublication(address);
					switch (state.kind) {
						case 'settled':
						case 'refused':
						case 'record-not-live':
							continue;
						case 'ready':
							break;
						default:
							state satisfies never;
					}
					const acceptance = await activeCarrier.publishDocument(
						address,
						state.publication,
					);
					if (isDisposed) return 'ok';
					if (acceptance.kind === 'lifetime-mismatch') {
						replaceAuthority();
						return 'replaced';
					}
					const proof =
						acceptance.kind === 'accepted' ? acceptance.receipt : acceptance;
					const settlement = store.settleDocumentPublication(address, proof, {
						revision: state.publication.capturedRevision,
						digest: state.publication.digest,
					});
					switch (settlement.kind) {
						case 'settled':
							invalidated.set(JSON.stringify(address), address);
							break;
						case 'record-not-live':
							break;
						default:
							settlement satisfies never;
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
					const state = await blobs.publication(address);
					switch (state.kind) {
						case 'settled':
						case 'record-not-live':
							continue;
						case 'ready':
							break;
						default:
							state satisfies never;
					}
					const acceptance = await activeCarrier.publishBlob(
						address,
						state.publication.request,
						state.publication.bytes,
					);
					if (isDisposed) return 'ok';
					if (acceptance.kind === 'lifetime-mismatch') {
						replaceAuthority();
						return 'replaced';
					}
					const settlement = await blobs.settle(address, acceptance);
					switch (settlement.kind) {
						case 'settled':
							invalidated.set(JSON.stringify(address), address);
							break;
						case 'record-not-live':
							break;
						default:
							settlement satisfies never;
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
			setStatus('local-only');
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
