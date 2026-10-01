import {
	type AnyTaggedError,
	defineErrors,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { VadState } from '$lib/constants/audio';
import type { DeliveryReach } from '$lib/operations/delivery';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';
import type { WhisperingRecording } from '../operations/recording.svelte.js';

/**
 * The dictation lifecycle owned by the main window. See ADR-0039.
 *
 * Voice-activated capture is *continuous*: an utterance transcribes while the
 * session keeps listening, so a live meter and a pipeline outcome run at once.
 * Manual capture is sequential. Two facts keep both honest:
 *
 * - `capture` is *derived* from the recorder machines: the live session, with no
 *   second copy of "are we recording" to drift.
 * - `outcome` is the most-recent utterance's pipeline result, an ephemeral signal
 *   the pipeline drives. Most-recent-wins: a new utterance overwrites it, and the
 *   OS-notification path reads it and wants each distinct failure exactly once.
 *
 * A failure is transient here, not a held state: the pill glances it (manual),
 * the OS notification fires for it, and the recordings row is the durable
 * record. The pill is not a review surface, so there is no failure latch.
 */
export type DictationCapture =
	| { kind: 'idle' }
	| { kind: 'recording'; trigger: 'manual' }
	| { kind: 'recording'; trigger: 'vad'; vadState: Exclude<VadState, 'IDLE'> };

export type DictationOutcome =
	| { kind: 'none' }
	| { kind: 'transcribing' }
	| { kind: 'polishing' }
	| { kind: 'delivered'; reach: DeliveryReach }
	| ({ kind: 'failed' } & DictationFailure);

export type DictationLifecycle = {
	capture: DictationCapture;
	outcome: DictationOutcome;
};

/** Where a dictation failed, which determines how loudly feedback surfaces it. */
export type DictationFailureTier = 'silent-loss' | 'transcription';

/** A dictation failure, carrying the live error object for the projection. */
export type DictationFailure = {
	tier: DictationFailureTier;
	error: AnyTaggedError;
};

const log = createLogger('whispering/dictation-lifecycle');

/**
 * The one failure this lifecycle logs. `markFailed` is the funnel every
 * dictation failure passes through, and the tier says where it happened.
 */
export const DictationLifecycleError = defineErrors({
	DictationFailed: ({
		tier,
		cause,
	}: {
		tier: DictationFailureTier;
		cause: AnyTaggedError;
	}) => ({
		message: `Dictation failed (${tier})`,
		tier,
		cause,
	}),
});
export type DictationLifecycleError = InferErrors<
	typeof DictationLifecycleError
>;

// How long a clean delivery's checkmark flashes before the outcome retires to
// `none`. Sub-second: the transcribed text landing is the real receipt, so this
// is a glance confirming it, not a notice to read. Only the clean `output` reach
// flashes; a reduced reach persists instead (see `markDelivered`). (A live VAD
// session projects `delivered` to no pip, so this flash only ever shows once
// capture is idle.)
const DELIVERED_FLASH_MS = 900;

function createDictationLifecycle() {
	// The outcome track is the ephemeral signal directly: `none` when no utterance
	// is in flight, otherwise the most-recent utterance's phase. Reset to `none`
	// when a new dictation begins so a stale `failed` never lingers past the next
	// attempt.
	let outcome = $state.raw<DictationOutcome>({ kind: 'none' });
	let deliveredTimer: ReturnType<typeof setTimeout> | undefined;
	let attempt = {};

	function clearDeliveredTimer() {
		clearTimeout(deliveredTimer);
		deliveredTimer = undefined;
	}

	return {
		/** Project the current outcome alongside this session's capture. */
		current(recording: Pick<WhisperingRecording, 'state'>): DictationLifecycle {
			if (recording.state === 'RECORDING')
				return { capture: { kind: 'recording', trigger: 'manual' }, outcome };
			if (vadRecorder.state !== 'IDLE')
				return {
					capture: {
						kind: 'recording',
						trigger: 'vad',
						vadState: vadRecorder.state,
					},
					outcome,
				};
			return { capture: { kind: 'idle' }, outcome };
		},
		get outcome() {
			return outcome;
		},

		/**
		 * A new dictation is starting: clear any terminal outcome from the last one
		 * and return the predicate that lets this attempt publish feedback. A newer
		 * reset retires feedback without cancelling the older inference or history.
		 */
		reset(): () => boolean {
			const started = {};
			attempt = started;
			clearDeliveredTimer();
			outcome = { kind: 'none' };
			return () => attempt === started;
		},

		/** The recorder stopped (or a VAD utterance ended); now transcribing. */
		markTranscribing(): void {
			clearDeliveredTimer();
			outcome = { kind: 'transcribing' };
		},

		/**
		 * The transcript landed and the always-on Polish pass is now running over it
		 * (ADR-0099). Held until `markDelivered`, with a `ship-raw` control on the
		 * pill to skip it. Only entered when a Polish pass actually runs (a usable
		 * provider, Polish on); speed mode goes straight from transcribing to
		 * delivered.
		 */
		markPolishing(): void {
			clearDeliveredTimer();
			outcome = { kind: 'polishing' };
		},

		/**
		 * The transcript landed. `reach` is how far it got toward the configured
		 * output: either a clean `output` or a `clipboard` fallback. Both reaches are
		 * successes because the text is saved, so neither is a dictation failure.
		 *
		 * A clean `output` flashes for a beat and retires: the landing text is the
		 * receipt, so the pill is just a glance. The reduced `clipboard` reach instead
		 * persists until the next dictation, like a failure does:
		 * the text did not land where the user asked, so the tag carries information
		 * the text alone does not, and a sub-second flash is too easy to miss. There
		 * is no notification for a reduced reach (ADR-0039): the persistent pill tag
		 * and the recordings row are the surfaces, and a revoked Accessibility grant
		 * already raises its own standing notice.
		 */
		markDelivered(reach: DeliveryReach): void {
			clearDeliveredTimer();
			outcome = { kind: 'delivered', reach };
			// Only the clean reach auto-retires; a reduced reach stays put.
			if (reach !== 'output') return;
			deliveredTimer = setTimeout(() => {
				deliveredTimer = undefined;
				// Only retire the flash if a newer outcome has not taken over.
				if (outcome.kind === 'delivered') outcome = { kind: 'none' };
			}, DELIVERED_FLASH_MS);
		},

		/** A dictation failed: hold the failed outcome until the next dictation
		 * resets it. Transient, not a held state: the pill glances it (manual), the
		 * notification path fires it, and the recordings row is the durable record. */
		markFailed(failure: DictationFailure): void {
			// Log here rather than at each call site, because this is the funnel every
			// failure already passes through, so a new failure path cannot be added
			// without one. Nothing else writes the cause down: the pill renders the
			// tier's label and drops the error, and the OS notification carries the
			// message but only if notifications are permitted and seen. Without this
			// line a failed dictation leaves no trace to read afterwards.
			//
			log.warn(
				DictationLifecycleError.DictationFailed({
					tier: failure.tier,
					cause: failure.error,
				}),
			);
			clearDeliveredTimer();
			outcome = { kind: 'failed', ...failure };
		},
	};
}

export const dictationLifecycle = createDictationLifecycle();
