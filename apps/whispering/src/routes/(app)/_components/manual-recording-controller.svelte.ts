import { createMutation } from '@tanstack/svelte-query';
import { MANUAL_RECORDING_BUTTON } from '$lib/constants/audio';
import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
import type { WhisperingApp } from '$lib/whispering/app';
import type { RecordingActionController } from './recording-action-controller';

/**
 * The manual-record button behavior as a `RecordingActionController`: the
 * start/stop mutations plus every prop a `RecordingActionCard` needs, all
 * derived from the one `app.recording` workflow.
 *
 * Start and stop are separate mutations on purpose: `app.recording.stop()` awaits
 * the full transcription pipeline, so its pending window outlives the RECORDING
 * state (the recorder resets to IDLE the moment the mic stops, while
 * transcription is still running). Deriving direction from `app.recording.state`
 * alone would mislabel that post-stop window as "starting".
 *
 * Call from a component's init: it creates TanStack mutations, which need the
 * component query-client context.
 */
export function createManualRecordingController(
	app: WhisperingApp,
): RecordingActionController {
	const startMutation = createMutation(() => ({
		mutationFn: () => app.recording.start(),
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: () => app.recording.stop(),
	}));

	const isStarting = $derived(startMutation.isPending);
	const isStopping = $derived(stopMutation.isPending);
	const isRecording = $derived(app.recording.state === 'RECORDING');
	const button = $derived(MANUAL_RECORDING_BUTTON[app.recording.state]);
	const shortcutLabel = $derived(getRecordingShortcutLabel(app, 'manual'));

	const description = $derived.by(() => {
		if (isStarting) return 'Opening microphone input';
		if (isStopping) return 'Stopping recording';
		if (isRecording) return 'Click again to stop';
		return shortcutLabel ? 'Click or press shortcut' : 'Click to record';
	});
	const tooltip = $derived.by(() => {
		if (isStarting) return 'Preparing recording controls';
		if (isStopping) return 'Stopping recording';
		return button.label;
	});

	return {
		get active() {
			return isRecording;
		},
		get pending() {
			return isStarting || isStopping;
		},
		get icon() {
			return button.Icon;
		},
		get label() {
			return button.label;
		},
		get description() {
			return description;
		},
		get tooltip() {
			return tooltip;
		},
		get shortcutLabel() {
			return shortcutLabel;
		},
		toggle() {
			if (isRecording) stopMutation.mutate();
			else startMutation.mutate();
		},
	};
}
