/**
 * The scalar V1 sync supervisor: two independently scheduled lanes.
 *
 * ADR-0163 splits scalar synchronization into two jobs with different
 * identities and retry cadences. The supervisor is where that separation
 * becomes observable behavior rather than just two functions:
 *
 * - The **facts lane** learns current authority facts. It wakes on a periodic
 *   interval, because new facts arrive without any local signal.
 * - The **submissions lane** settles local intents. It wakes when the outbox
 *   commits a write, because that is the only thing that creates work for it.
 *
 * Each lane owns its own in-flight promise, its own retry attempt counter, and
 * its own scheduled wake. A facts feed failing into backoff does not delay a
 * local write from settling, and a submission stuck behind a fork does not stop
 * the replica learning what the authority already knows. Under the combined
 * exchange neither was possible: one cursor, one receipt, and one schedule had
 * to serve both jobs, so either failure stalled both.
 *
 * Row documents do not get a third lane. ADR-0166 keeps document publication
 * out of a scheduler of its own, and there is a real ordering reason to keep it
 * where it is: publication must see freshly installed deletions, so it drains
 * after the facts lane inside that lane's own cycle. A document-only wake still
 * coalesces, it just runs on the facts lane rather than beside it.
 *
 * One status surface spans both lanes. Errors are contained per lane but
 * reported once, so a caller sees "offline" while either lane is failing and
 * "idle" only when neither is.
 */
import { extractErrorMessage } from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';

import type { PublishDocument } from './documents.js';
import {
	type ReplicaV1,
	ReplicaV1Error,
	type ScalarTransport,
} from './replica/v1-replica.js';

const DEFAULT_FACTS_INTERVAL_MS = 30_000;
const DEFAULT_DOCUMENT_COALESCE_MS = 250;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

export type SyncState =
	| 'local'
	| 'syncing'
	| 'idle'
	| 'offline'
	| 'authentication-required';

export type SyncStatus = {
	state: SyncState;
	lastError: Error | undefined;
};

export type SyncCredentialProvider = {
	get(): string | undefined;
	subscribe?(listener: () => void): () => void;
};

export type SyncSupervisorSession = {
	transport: ScalarTransport;
	/**
	 * The session's outbound HTTP carrier for dirty document state. When absent
	 * the runtime keeps obligations durable and drains nothing; local document
	 * work waits for a session that can publish it.
	 */
	publishDocument?: PublishDocument;
	credentials?: SyncCredentialProvider;
};

export type SyncSchedule = (task: () => void, delayMs: number) => () => void;

type LaneName = 'facts' | 'submissions';

export function createSyncSupervisorV1({
	replica,
	drainDocuments,
	factsIntervalMs = DEFAULT_FACTS_INTERVAL_MS,
	documentCoalesceMs = DEFAULT_DOCUMENT_COALESCE_MS,
	schedule = scheduleTimeout,
	log = createLogger('data/sync-v1'),
}: {
	replica: ReplicaV1;
	/**
	 * Publish owed document work for the attached session. Runs at the end of a
	 * facts-lane cycle so liveness reflects freshly installed deletions, and
	 * alone in a coalesced document-only wake (ADR-0166).
	 */
	drainDocuments?: (
		session: SyncSupervisorSession,
	) => Promise<Result<void, ReplicaV1Error>>;
	factsIntervalMs?: number;
	/** How long a document-only wake waits so rapid edits become one publish. */
	documentCoalesceMs?: number;
	schedule?: SyncSchedule;
	log?: Logger;
}) {
	const listeners = new Set<(status: SyncStatus) => void>();
	let status: SyncStatus = { state: 'local', lastError: undefined };
	let session: SyncSupervisorSession | undefined;
	let stopCredentials: (() => void) | undefined;
	let cancelDocumentCoalesce: (() => void) | undefined;
	let factsRequested = false;
	let documentsRequested = false;
	let generation = 0;
	let isDisposed = false;

	/**
	 * Call an injected dependency without letting it escape.
	 *
	 * The supervisor calls out to code it does not own on nearly every path: the
	 * scheduler and its canceller, the credential provider, the unsubscribes, and
	 * the logger. Any of them can throw, and most are reached from a background
	 * wake or a teardown step where a throw has no owner: it would surface as an
	 * unrelated caller's failure, or strand the rest of a teardown and leave a
	 * half-disposed supervisor still waking a dead session.
	 */
	function contain(what: string, step: () => void): void {
		try {
			step();
		} catch (cause) {
			try {
				log.error(new Error(`Sync supervisor could not ${what}`, { cause }));
			} catch {
				// The logger is itself injected. If reporting fails there is nowhere
				// left to report it, and it must not become the caller's problem.
			}
		}
	}

	/**
	 * One independently scheduled lane.
	 *
	 * Both lanes need the same machinery: coalesce concurrent requests into one
	 * run, never reject, retire superseded generations, and back off on transport
	 * trouble. Only the work and the idle cadence differ, so the mechanics live
	 * here once rather than being written twice and drifting.
	 */
	function createLane(
		name: LaneName,
		run: (
			session: SyncSupervisorSession,
		) => Promise<Result<unknown, ReplicaV1Error>>,
		{ idleIntervalMs }: { idleIntervalMs: number | undefined },
	) {
		let running: Promise<void> | undefined;
		let requested = false;
		let retryAttempt = 0;
		let cancelScheduled: (() => void) | undefined;
		let lastError: Error | undefined;

		function cancelWake(): void {
			const cancel = cancelScheduled;
			cancelScheduled = undefined;
			if (cancel !== undefined) contain(`cancel the ${name} wake`, cancel);
		}

		function scheduleWake(delayMs: number): void {
			cancelWake();
			// A scheduler that throws leaves this lane with no wake rather than
			// turning a completed cycle into a reported failure.
			contain(`schedule the next ${name} wake`, () => {
				cancelScheduled = schedule(() => {
					cancelScheduled = undefined;
					// A lane's own wake is a full cycle for that lane. For facts that
					// means an actual fact read, which is the whole point of the
					// periodic safety wake.
					if (name === 'facts') factsRequested = true;
					request();
				}, delayMs);
			});
		}

		function retryDelay(): number {
			const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
			retryAttempt += 1;
			return delay;
		}

		async function cycle(activeGeneration: number): Promise<void> {
			while (
				requested &&
				!isDisposed &&
				activeGeneration === generation &&
				session !== undefined
			) {
				requested = false;
				if (!hasCredentials()) {
					lastError = undefined;
					publishStatus();
					return;
				}
				publishStatus();
				const result = await run(session);
				if (activeGeneration !== generation || isDisposed) return;
				if (result.error !== null) {
					lastError = new Error(extractErrorMessage(result.error), {
						cause: result.error,
					});
					// Transport trouble retries fast with backoff; everything else
					// still gets the periodic safety wake, so recovery never depends
					// on another local write happening.
					scheduleWake(
						result.error.name === 'TransportFailed'
							? retryDelay()
							: (idleIntervalMs ?? MAX_RETRY_MS),
					);
					publishStatus();
					return;
				}
				retryAttempt = 0;
				lastError = undefined;
			}
			if (!isDisposed && activeGeneration === generation && hasCredentials()) {
				// A lane with no idle cadence sleeps until something wakes it. The
				// submissions lane is exactly that: only a local write creates work,
				// so a periodic poll would be a guaranteed-empty round trip.
				if (idleIntervalMs !== undefined) scheduleWake(idleIntervalMs);
			}
			publishStatus();
		}

		/**
		 * Run one cycle to completion without ever rejecting.
		 *
		 * This is the lane's single failure boundary. Expected trouble already
		 * arrives as a typed Result; only a bug or a throwing injected dependency
		 * reaches the catch. Either way nothing rejects, which is what lets a
		 * background wake discard this promise safely.
		 */
		async function runCycle(activeGeneration: number): Promise<void> {
			try {
				await cycle(activeGeneration);
			} catch (cause) {
				const faulted = ReplicaV1Error.SyncFaulted({ cause });
				if (activeGeneration === generation && !isDisposed) {
					contain(`report a failed ${name} cycle`, () => {
						log.error(faulted.error);
						lastError = new Error(faulted.error.message, {
							cause: faulted.error,
						});
						scheduleWake(idleIntervalMs ?? MAX_RETRY_MS);
						publishStatus();
					});
				}
			}
		}

		function start(): Promise<void> {
			if (isDisposed || session === undefined) return Promise.resolve();
			if (running !== undefined) return running;
			const activeGeneration = generation;
			running = runCycle(activeGeneration).finally(() => {
				running = undefined;
				if (requested && !isDisposed && activeGeneration === generation) {
					start();
					return;
				}
				// Published here, after `running` clears, because that is the first
				// moment this lane is observably not busy. Reporting from inside the
				// cycle would compute `syncing` from its own still-set promise and
				// leave the supervisor stuck there with no later event to correct it.
				publishStatus();
			});
			return running;
		}

		/**
		 * Wake this lane and hand back the cycle it will run in.
		 *
		 * The promise is what lets `attach` mean "the first cycle was attempted"
		 * rather than "a timer was set". Callers that only want a nudge may ignore
		 * it; it never rejects, so discarding it is safe.
		 */
		function request(): Promise<void> {
			if (isDisposed || session === undefined) return Promise.resolve();
			cancelWake();
			requested = true;
			return start();
		}

		return {
			request,
			cancelWake,
			reset(): void {
				retryAttempt = 0;
				requested = false;
				lastError = undefined;
			},
			get isBusy(): boolean {
				return running !== undefined;
			},
			get lastError(): Error | undefined {
				return lastError;
			},
		};
	}

	function hasCredentials(): boolean {
		return (
			session?.credentials?.get() !== undefined ||
			session?.credentials === undefined
		);
	}

	const facts = createLane(
		'facts',
		async (active) => {
			// Read and clear both intents up front: whatever arrives while this
			// cycle is in flight belongs to the next one, and the lane already
			// re-runs for it.
			const wantsFacts = factsRequested;
			const wantsDocuments = documentsRequested;
			factsRequested = false;
			documentsRequested = false;

			if (wantsFacts) {
				const pulled = await replica.pullFacts(active.transport);
				if (pulled.error !== null) return pulled;
				// Learning facts is the only thing that can bind the authority
				// lifetime, and a replica may not submit before it is bound. So a
				// successful fact read is what releases work the submissions lane was
				// unable to touch; without this nudge, intents written before the
				// first successful read would wait for an unrelated local write.
				// Cheap when there is nothing to do: no lifetime, no pending work, and
				// no sealed submission all return without a round trip.
				void submissions.request();
			}
			// Documents drain at the tail so publication sees freshly installed
			// deletions (ADR-0166). A document-only wake skips the fact read it has
			// no reason to make: coalesced local edits would otherwise each buy an
			// empty round trip.
			if (drainDocuments === undefined || !(wantsFacts || wantsDocuments)) {
				return Ok(undefined);
			}
			return drainDocuments(active);
		},
		{ idleIntervalMs: factsIntervalMs },
	);

	/** Wake the facts lane for a real fact read, not just a document drain. */
	function requestFactsCycle(): Promise<void> {
		factsRequested = true;
		return facts.request();
	}

	const submissions = createLane(
		'submissions',
		async (active) => {
			const pushed = await replica.pushSubmissions(active.transport);
			if (pushed.error !== null) return pushed;
			// Only a pass that actually settled may ask for another. More pending
			// work than one submission could carry is real progress, so repeating
			// terminates. The other outcomes consumed nothing, and re-requesting on
			// them is a loop with no exit.
			if (pushed.data.kind === 'settled' && pushed.data.hasMorePending) {
				void submissions.request();
			}
			return pushed;
		},
		// No idle cadence: only a local write creates submission work, so a timer
		// here would be a guaranteed-empty round trip on every quiet interval.
		{ idleIntervalMs: undefined },
	);

	function publishStatus(): void {
		const next = computeStatus();
		if (
			status.state === next.state &&
			status.lastError?.message === next.lastError?.message
		) {
			return;
		}
		status = next;
		for (const listener of listeners) {
			try {
				listener(status);
			} catch (cause) {
				contain('notify a status subscriber', () => {
					log.error(new Error('Sync status subscriber threw', { cause }));
				});
			}
		}
	}

	/**
	 * One status across both lanes.
	 *
	 * Deliberately worst-of rather than last-writer: a caller asking "is my data
	 * safe" must not see `idle` because the facts lane happens to have finished
	 * while submissions are still failing to settle.
	 */
	function computeStatus(): SyncStatus {
		if (session === undefined) return { state: 'local', lastError: undefined };
		if (!hasCredentials()) {
			return { state: 'authentication-required', lastError: undefined };
		}
		const lastError = submissions.lastError ?? facts.lastError;
		if (lastError !== undefined) return { state: 'offline', lastError };
		if (facts.isBusy || submissions.isBusy) {
			return { state: 'syncing', lastError: undefined };
		}
		return { state: 'idle', lastError: undefined };
	}

	function cancelDocumentWake(): void {
		const cancel = cancelDocumentCoalesce;
		cancelDocumentCoalesce = undefined;
		if (cancel !== undefined) contain('cancel the document wake', cancel);
	}

	/**
	 * Contained end to end because this runs as the credential provider's own
	 * subscriber: a throw here (most likely from `get`) would otherwise land in
	 * whatever rotated the token, blaming an auth refresh for a sync fault.
	 */
	function credentialsChanged(): void {
		contain('handle a credential change', () => {
			if (isDisposed || session === undefined) return;
			generation += 1;
			facts.cancelWake();
			submissions.cancelWake();
			cancelDocumentWake();
			if (!hasCredentials()) {
				facts.reset();
				submissions.reset();
				publishStatus();
				return;
			}
			requestFactsCycle();
			submissions.request();
		});
	}

	const stopOutbox = replica.subscribeOutbox(() => {
		// A committed local write is the only thing that creates submission work.
		submissions.request();
	});

	return {
		async attach(
			nextSession: SyncSupervisorSession,
		): Promise<Result<void, ReplicaV1Error>> {
			if (isDisposed) throw new Error('Sync supervisor is disposed');
			generation += 1;
			facts.cancelWake();
			submissions.cancelWake();
			cancelDocumentWake();
			const stopPreviousCredentials = stopCredentials;
			stopCredentials = undefined;
			if (stopPreviousCredentials !== undefined) {
				// Contained like disposal's: a throwing unsubscribe must not leave
				// this half-attached, with the generation bumped and the old
				// subscription still live.
				contain(
					'stop the previous credential subscription',
					stopPreviousCredentials,
				);
			}
			session = nextSession;
			facts.reset();
			submissions.reset();
			stopCredentials =
				nextSession.credentials?.subscribe?.(credentialsChanged);
			if (!hasCredentials()) {
				publishStatus();
				return Ok(undefined);
			}
			// Three ordered steps, because each needs the one before it.
			//
			// Facts first, so a fresh replica binds the authority lifetime before
			// the submissions lane has anything it is allowed to send (ADR-0163).
			// Then submissions, so rows this replica created offline exist at the
			// authority. Then facts again, whose tail is where documents drain:
			// publication is refused for a row the authority has never seen, so
			// draining before the rows are submitted would owe work that cannot
			// succeed until the next periodic wake.
			//
			// Awaited because `attach` promises the first cycle was attempted: a
			// caller that attaches and immediately reads expects to see what the
			// authority already had, and a transport that hangs must leave attach
			// pending rather than report success it cannot support.
			await requestFactsCycle();
			await submissions.request();
			await requestFactsCycle();
			return Ok(undefined);
		},

		/** Ask the facts lane to learn current authority state now. */
		requestFacts(): void {
			requestFactsCycle();
		},

		/** Ask the submissions lane to settle pending local work now. */
		requestSubmissions(): void {
			submissions.request();
		},

		/**
		 * Wake the document drain after a short coalescing delay so rapid local
		 * edits normally become one publication. The periodic facts cycle remains
		 * the safety wake for crash, restart, and transient-failure recovery.
		 */
		requestDocumentDrain(): void {
			if (isDisposed || session === undefined) return;
			if (cancelDocumentCoalesce !== undefined) return;
			contain('schedule the document wake', () => {
				cancelDocumentCoalesce = schedule(() => {
					cancelDocumentCoalesce = undefined;
					documentsRequested = true;
					facts.request();
				}, documentCoalesceMs);
			});
		},

		get status(): SyncStatus {
			return status;
		},

		subscribe(listener: (next: SyncStatus) => void): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		dispose(): void {
			if (isDisposed) return;
			isDisposed = true;
			generation += 1;
			facts.cancelWake();
			submissions.cancelWake();
			cancelDocumentWake();
			const stopNextCredentials = stopCredentials;
			stopCredentials = undefined;
			if (stopNextCredentials !== undefined) {
				contain('stop the credential subscription', stopNextCredentials);
			}
			contain('stop the outbox subscription', stopOutbox);
			session = undefined;
			listeners.clear();
		},
	};
}

export type SyncSupervisorV1 = ReturnType<typeof createSyncSupervisorV1>;

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
