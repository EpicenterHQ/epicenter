import { os } from '#platform/os';
import { createSystemShortcuts } from '#platform/system-shortcuts';
import type { Command } from '$lib/commands';
import { createFocusedShortcuts } from '$lib/shortcuts/focused';
import type { Shortcuts } from '$lib/shortcuts/types';
import { keyBindingToLabel } from '$lib/utils/key-binding';
import type { WhisperingApp } from '$lib/whispering/app';

/**
 * Preference order for the shortcut that starts each recording mode: the first
 * command with a binding live on this platform wins.
 *
 * Manual recording has two start commands. Push-to-talk is a held chord and
 * ships unbound, so it is opt-in. Toggle recording ships bound (Space in-app, a
 * chord globally), so its key shows by default. Push-to-talk still leads the
 * list, so once the user binds it that hold is what we show. VAD has a single
 * command, so its list has one entry.
 */
const RECORDING_SHORTCUT_PREFERENCE = {
	manual: ['pushToTalk', 'toggleManualRecording'],
	vad: ['toggleVadRecording'],
} as const satisfies Record<string, readonly Command['id'][]>;

export type RecordingShortcutMode = keyof typeof RECORDING_SHORTCUT_PREFERENCE;

/**
 * The label for the bound gesture this mode starts in one store, picked by walking
 * the preference list (the first bound command wins). Returns `''` when nothing
 * in the list is bound. `keyBindingToLabel` formats the physical binding.
 */
function shortcutLabelFor(
	store: Shortcuts,
	mode: RecordingShortcutMode,
): string {
	for (const commandId of RECORDING_SHORTCUT_PREFERENCE[mode]) {
		const binding = store.current(commandId);
		if (binding) return keyBindingToLabel(binding, os.isApple);
	}
	return '';
}

/**
 * The single label that starts this recording mode on this platform, from the
 * primary backend. Recording controllers use this to know whether a shortcut
 * exists without teaching shortcut configuration on the recording surface.
 */
export function getRecordingShortcutLabel(
	app: WhisperingApp,
	mode: RecordingShortcutMode,
): string {
	return shortcutLabelFor(
		createSystemShortcuts?.(app) ?? createFocusedShortcuts(app),
		mode,
	);
}
