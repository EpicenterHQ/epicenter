import { type Command, commands } from '$lib/commands';
import { DEFAULT_SHORTCUT_KEYS, type WhisperingSettingValues } from '$lib/data';
import {
	type CommandId,
	LocalShortcutManagerLive,
} from '$lib/services/local-shortcut-manager';
import {
	bindingsEqual,
	isEmptyBinding,
	type KeyBinding,
} from '$lib/utils/key-binding';
import type { WhisperingApp } from '$lib/whispering/app';
import { createShortcuts } from './shared';
import type { Shortcuts } from './types';

/**
 * The focused (in-app) shortcut backend: shortcuts that fire while the Whispering
 * window is focused, driven by the browser keydown matcher and stored in this
 * device's settings as two arrays per command, `shortcut<Command>Modifiers` and
 * `shortcut<Command>Keys`.
 *
 * Two columns rather than one structured value, because a workspace has no
 * expression for an inline object and no way to default an array
 * (`data.ts`). So a binding is composed on read and decomposed on
 * write, and "no shortcut configured" is `null` on both halves rather than a
 * stored empty binding.
 *
 * Universal, not a `#platform` seam: the webview matcher runs in the Tauri window
 * too, so this same backend is the focused half on every platform. The reach
 * router (`shortcuts.ts`) composes it with the Tauri-only `systemShortcuts`; on
 * desktop both run, on web this is the only one. See ADR-0052.
 */

/**
 * Where each command's binding is stored, as the two workspace kv keys that
 * hold it.
 *
 * Written out rather than composed as `` `shortcut${Capitalize<id>}Keys` ``: a
 * durable key is not something to compute from an identifier that a rename
 * could quietly change out from under the stored data.
 */
const SHORTCUT_KEYS = {
	pushToTalk: {
		modifiers: 'shortcutPushToTalkModifiers',
		keys: 'shortcutPushToTalkKeys',
	},
	toggleManualRecording: {
		modifiers: 'shortcutToggleManualRecordingModifiers',
		keys: 'shortcutToggleManualRecordingKeys',
	},
	cancelRecording: {
		modifiers: 'shortcutCancelRecordingModifiers',
		keys: 'shortcutCancelRecordingKeys',
	},
	toggleVadRecording: {
		modifiers: 'shortcutToggleVadRecordingModifiers',
		keys: 'shortcutToggleVadRecordingKeys',
	},
	openRecipePicker: {
		modifiers: 'shortcutOpenRecipePickerModifiers',
		keys: 'shortcutOpenRecipePickerKeys',
	},
	runRecipeOnClipboard: {
		modifiers: 'shortcutRunRecipeOnClipboardModifiers',
		keys: 'shortcutRunRecipeOnClipboardKeys',
	},
	openSettings: {
		modifiers: 'shortcutOpenSettingsModifiers',
		keys: 'shortcutOpenSettingsKeys',
	},
} as const satisfies Record<
	Command['id'],
	{
		modifiers: keyof WhisperingSettingValues;
		keys: keyof WhisperingSettingValues;
	}
>;

export function createFocusedShortcuts({
	settings,
}: Pick<WhisperingApp, 'settings'>): Shortcuts {
	// The workspace validates the stored arrays structurally as `string[]`, while
	// `KeyBinding` narrows them to `Modifier[]` and `Key[]`, so composing a
	// binding crosses that boundary with one documented cast, like the global
	// tier.
	const compose = (
		modifiers: readonly string[] | null,
		keys: readonly string[] | null,
	): KeyBinding | null => {
		const binding = {
			modifiers: [...(modifiers ?? [])],
			keys: [...(keys ?? [])],
		} as KeyBinding;
		return isEmptyBinding(binding) ? null : binding;
	};

	const readBinding = (id: Command['id']): KeyBinding | null =>
		compose(
			settings.get(SHORTCUT_KEYS[id].modifiers) as readonly string[] | null,
			settings.get(SHORTCUT_KEYS[id].keys) as readonly string[] | null,
		);

	/**
	 * The shipped binding, which is release-local product policy rather than a
	 * application policy: the definition stores null when no shortcut is configured,
	 * and "no shortcut configured" and "the shipped shortcut" would otherwise be
	 * the same stored value (`data.ts`).
	 */
	const readDefaultBinding = (id: Command['id']): KeyBinding | null =>
		compose(
			settings.getDefault(SHORTCUT_KEYS[id].modifiers) as
				| readonly string[]
				| null,
			id in DEFAULT_SHORTCUT_KEYS
				? DEFAULT_SHORTCUT_KEYS[id as keyof typeof DEFAULT_SHORTCUT_KEYS]
				: (settings.getDefault(SHORTCUT_KEYS[id].keys) as
						| readonly string[]
						| null),
		);

	return createShortcuts({
		read: readBinding,
		getDefault: readDefaultBinding,
		write: (id, binding) => {
			settings.set(SHORTCUT_KEYS[id].modifiers, binding?.modifiers ?? null);
			settings.set(SHORTCUT_KEYS[id].keys, binding?.keys ?? null);
		},
		// The keydown matcher fires every command whose set matches, so two commands
		// sharing a set would both trigger. Refuse an exact duplicate at write time.
		findConflict: (id, binding) => {
			for (const command of commands) {
				if (command.id === id) continue;
				const other = readBinding(command.id);
				if (other && bindingsEqual(other, binding)) {
					return { kind: 'duplicate', commandId: command.id };
				}
			}
			return null;
		},
		syncErrorTitle: 'Error registering local commands',
		// Registration is an in-memory Map write, so it cannot fail: push always
		// succeeds. The contract stays async because the desktop tier's push does IPC.
		async push(entries) {
			for (const { command, binding } of entries) {
				if (binding)
					LocalShortcutManagerLive.register(command.id as CommandId, binding);
				else LocalShortcutManagerLive.unregister(command.id as CommandId);
			}
			return null;
		},
	});
}
