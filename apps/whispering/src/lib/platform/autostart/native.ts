/** Launch at login in the desktop app: the system's login items, from Rust (`autostart.rs`). */
import { invoke } from '@tauri-apps/api/core';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import type { Autostart } from './autostart';

export const nativeAutostart: Autostart = {
	available: true,
	enabled: () => invoke<boolean>('autostart_enabled').catch(() => false),
	async set(on) {
		try {
			await invoke('autostart_set', { on });
			return Ok(undefined);
		} catch (cause) {
			return Err({ message: extractErrorMessage(cause) });
		}
	},
};
