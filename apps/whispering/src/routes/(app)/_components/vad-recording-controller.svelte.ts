import { createMutation } from '@tanstack/svelte-query';
import { VAD_RECORDING_BUTTON } from '$lib/constants/audio';
import { toggleVadRecording } from '$lib/operations/recording.svelte.js';
import { vadRecorder } from '$lib/state/vad-recorder.svelte';
import { getRecordingShortcutLabel } from '$lib/utils/recording-shortcut';
import type { WhisperingApp } from '$lib/whispering/app';
import type { RecordingActionController } from './recording-action-controller';

/**
 * The voice-activated record button behavior, in the same shape as
 * `createManualRecordingController` so both feed `RecordingActionCard` through
 * one `controller` prop. VAD is a single toggle (its capture pipeline runs in a
 * separate speech-end callback, not in stop), so there is one mutation here, not
 * a start/stop pair.
 *
 * Call from a component's init: it creates a TanStack mutation.
 */
export function createVadRecordingController(
	app: WhisperingApp,
): RecordingActionController {
	const toggleMutation = createMutation(() => ({
		mutationFn: () => toggleVadRecording(app),
	}));

	const isListening = $derived(vadRecorder.state !== 'IDLE');
	const button = $derived(VAD_RECORDING_BUTTON[vadRecorder.state]);
	const shortcutLabel = $derived(getRecordingShortcutLabel(app, 'vad'));

	const description = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activation';
		if (vadRecorder.state === 'SPEECH_DETECTED') return 'Speech detected';
		if (isListening) return 'Listening for speech';
		return 'Listen for speech';
	});
	const tooltip = $derived.by(() => {
		if (toggleMutation.isPending) return 'Updating voice activated session';
		if (isListening) return 'Stop voice activated session';
		return 'Start voice activated session';
	});

	return {
		get active() {
			return isListening;
		},
		get pending() {
			return toggleMutation.isPending;
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
			toggleMutation.mutate();
		},
	};
}
