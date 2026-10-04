import { createMutation } from '@tanstack/svelte-query';
import { MANUAL_RECORDING_BUTTON } from '$lib/constants/audio';
import {
	startManualRecording,
	stopManualRecording,
} from '$lib/operations/recording';
import { manualRecorder } from '$lib/state/manual-recorder.svelte';
import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
import type { WhisperingApplication as WhisperingApp } from '$lib/whispering/application';
import type { RecordingActionController } from './recording-action-controller';

/**
 * The manual-record button behavior as a `RecordingActionController`: the
 * start/stop mutations plus every prop a `RecordingActionCard` needs, all
 * derived from the one `manualRecorder` state machine.
 *
 * Start and stop are separate mutations on purpose: `stopManualRecording` awaits
 * the full transcription pipeline, so its pending window outlives the RECORDING
 * state (the recorder resets to IDLE the moment the mic stops, while
 * transcription is still running). Deriving direction from `manualRecorder.state`
 * alone would mislabel that post-stop window as "starting".
 *
 * Call from a component's init: it creates TanStack mutations, which need the
 * component query-client context.
 */
export function createManualRecordingController(
	app: WhisperingApp,
): RecordingActionController {
	const startMutation = createMutation(() => ({
		// The record button is the `manual` source (the default); wrap so the
		// mutation takes no variables rather than inferring the optional `source`.
		mutationFn: () => startManualRecording(app),
	}));
	const stopMutation = createMutation(() => ({
		mutationFn: () => stopManualRecording(app),
	}));

	const isStarting = $derived(startMutation.isPending);
	const isStopping = $derived(stopMutation.isPending);
	const isRecording = $derived(manualRecorder.state === 'RECORDING');
	const button = $derived(MANUAL_RECORDING_BUTTON[manualRecorder.state]);
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
