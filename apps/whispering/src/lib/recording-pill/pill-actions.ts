import { cancelRecording, stopVadRecording } from '$lib/operations/recording.svelte.js';
import type { RecordingPillAction } from '$lib/recording-pill/model';
import { dictationLifecycle } from '$lib/state/dictation-lifecycle.svelte';
import { polishHud } from '$lib/state/polish-hud.svelte';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * The pill's control gestures, mapped to operations in one place. Both pill
 * mounts route through here so the gesture-to-operation rules live once: the web
 * host calls this directly, and the Tauri main window calls it from the overlay's
 * action IPC. The pill component itself stays presentational.
 *
 * Stop and cancel act only on a live capture. VAD has no cancel (its pill shows
 * no cancel button), so a stray cancel during a VAD session is a no-op. `ship-raw`
 * is the exception: the Polish pass runs after capture is idle, so it cancels the
 * in-flight completion through `polishHud` rather than a recorder (ADR-0099).
 * There is no retry gesture: a failed dictation is retried from its recordings row.
 */
export function dispatchPillAction(
	app: WhisperingApp,
	action: RecordingPillAction,
): void {
	// Ship-raw fires during the polishing phase (capture already idle), so it sits
	// ahead of the live-capture guard below.
	if (action === 'ship-raw') {
		polishHud.shipRaw();
		return;
	}
	const { capture } = dictationLifecycle.current(app.recording);
	if (capture.kind !== 'recording') return;
	if (capture.trigger === 'manual') {
		if (action === 'cancel') void cancelRecording(app);
		else void app.recording.stop();
		return;
	}
	if (action === 'stop') void stopVadRecording(app);
}
