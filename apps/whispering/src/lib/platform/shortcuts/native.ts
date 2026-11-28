/** The global shortcuts in the desktop app: Rust holds the keys and sends each press (`shortcuts.rs`). */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ShortcutName, Shortcuts } from './shortcuts';

export const nativeShortcuts: Shortcuts = {
	available: true,
	set: (keys) => invoke('shortcuts_set', { shortcuts: keys }),
	onPress(handle) {
		const listening = listen<{ name: ShortcutName; down: boolean }>(
			'shortcut',
			({ payload }) => handle(payload.name, payload.down),
		);
		return () => void listening.then((stop) => stop());
	},
};
