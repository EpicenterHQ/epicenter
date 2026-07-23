/**
 * Recording trigger constants and per-trigger metadata.
 *
 * A recording trigger is how the microphone starts capturing: `manual` (you
 * press a button or shortcut) or `vad` (voice activity detection starts and
 * stops the capture for you). File import is not a trigger; it has no live
 * capture, device, or shortcut, so it lives on its own surface, not here.
 */

import EarIcon from '@lucide/svelte/icons/ear';
import MicIcon from '@lucide/svelte/icons/mic';
import type { Component } from 'svelte';
import {
	RECORDING_TRIGGERS,
	type RecordingTrigger,
} from './recording-trigger-vocabulary.js';

export { RECORDING_TRIGGERS, type RecordingTrigger };

/**
 * Everything that varies per trigger, defined once. `satisfies Record<...>`
 * forces every field present for every trigger at compile time.
 *
 * - `label`: the compact label for settings and trigger toggles.
 * - `Icon`: the Lucide icon for every functional trigger surface.
 */
export const RECORDING_TRIGGER_META = {
	manual: {
		label: 'Manual',
		Icon: MicIcon,
	},
	vad: {
		label: 'Voice Activated',
		Icon: EarIcon,
	},
} as const satisfies Record<
	RecordingTrigger,
	{
		label: string;
		Icon: Component<{ class?: string }>;
	}
>;

/**
 * Render-ready trigger list in display order, derived from the metadata so each
 * trigger is described in exactly one place.
 */
export const RECORDING_TRIGGER_OPTIONS = RECORDING_TRIGGERS.map((value) => ({
	value,
	label: RECORDING_TRIGGER_META[value].label,
	Icon: RECORDING_TRIGGER_META[value].Icon,
}));
