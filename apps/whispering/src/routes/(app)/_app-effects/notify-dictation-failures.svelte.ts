import type { AnyTaggedError } from 'wellcrafted/error';
import { osNotify } from '#platform/os-notify';
import { DICTATION_FAILURE_LABEL } from '$lib/dictation-feedback';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';

/**
 * The exception projection over the dictation lifecycle. A manual failure
 * glances on the pill, and a VAD failure does not show there at all, so the
 * durable cross-app signal is the OS notification: every real failure fires it,
 * focused or not, because VAD runs unattended and shows nothing on the live pill
 * (ADR-0039). Detail and retry live on the recordings row, not here.
 *
 * A reduced delivery reach is not a failure: the transcript is saved, so it never
 * reaches this projection. It surfaces on the pill instead as a `clipboard` tag
 * that persists until the next dictation, which is enough because a revoked
 * Accessibility grant already raises its own standing notice.
 *
 * There is no toast and no `MoreDetailsDialog`. `report.warning` and standing
 * warnings for a revoked or stale Accessibility grant are a different,
 * present-tense path and are untouched.
 */
export function notifyDictationFailures(): void {
	// The failure's error object is stable for the life of one failure, so it is
	// the identity that gates "have I already notified for this one". Each new
	// failure mints a new error, so it notifies once.
	let lastNotifiedError: AnyTaggedError | undefined;

	$effect(() => {
		// The outcome track is the failure source: a VAD utterance fails while the
		// session keeps listening, so the failure never shows on the pill and the
		// notification is its only proactive surface.
		const outcome = dictationLifecycle.outcome;
		if (outcome.kind !== 'failed') return;
		if (outcome.error === lastNotifiedError) return;
		lastNotifiedError = outcome.error;

		// Notify on every real failure, focused or not. VAD is the deciding case:
		// it runs unattended and shows nothing on the pill, so a focused user
		// staring at the listening meter would otherwise get no signal that an
		// utterance was lost. A failure notification is the non-annoying kind (we
		// already dropped success and progress toasts), so firing it while focused
		// is a worthwhile floor, not noise. A reduced delivery reach is a success,
		// not a failure, and never reaches this projection.
		osNotify(DICTATION_FAILURE_LABEL[outcome.tier], outcome.error.message);
	});
}
