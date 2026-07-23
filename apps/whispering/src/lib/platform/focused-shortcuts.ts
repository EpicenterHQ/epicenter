import { type Command, commands } from '$lib/commands';
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
import { createShortcuts } from './shortcuts.shared';
import type { Shortcuts } from './types';

/**
 * The focused (in-app) shortcut backend: shortcuts that fire while the Whispering
 * window is focused, driven by the browser keydown matcher and stored in synced data
 * KV under `shortcut.*` as the structured `KeyBinding` the matcher and the system
 * tier already speak (via `field.json`; the global tier stores the same shape in
 * device-config). Read and written directly, with no string codec in between. A
 * stale value (a binding saved before this format) fails the cell's schema check
 * on read and falls back to the default.
 *
 * Universal, not a `#platform` seam: the webview matcher runs in the Tauri window
 * too, so this same backend is the focused half on every platform. The reach
 * router (`shortcuts.ts`) composes it with the Tauri-only `systemShortcuts`; on
 * desktop both run, on web this is the only one. See ADR-0052.
 */

const localKey = (id: Command['id']) => `shortcut.${id}` as const;

// The cell schema validates stored `keys` structurally as `string[]`, while
// `KeyBinding` narrows them to `Key[]`, so the read crosses that boundary with one
// documented cast, like the global tier.
const EMPTY_BINDING: KeyBinding = { modifiers: [], keys: [] };

export function createFocusedShortcuts({
	settings,
}: Pick<WhisperingApp, 'settings'>): Shortcuts {
	const readBinding = (id: Command['id']): KeyBinding | null => {
		const binding = settings.get(localKey(id)) as KeyBinding;
		return isEmptyBinding(binding) ? null : binding;
	};

	const readDefaultBinding = (id: Command['id']): KeyBinding | null => {
		const binding = settings.getDefault(localKey(id)) as KeyBinding;
		return isEmptyBinding(binding) ? null : binding;
	};

	return createShortcuts({
		read: readBinding,
		getDefault: readDefaultBinding,
		write: (id, binding) =>
			settings.set(localKey(id), binding ?? EMPTY_BINDING),
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
