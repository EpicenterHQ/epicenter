/** Paste at the cursor in the desktop app: Rust presses the keys (`paste.rs`). */
import { invoke } from '@tauri-apps/api/core';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok } from 'wellcrafted/result';
import type { Paste } from './paste';

export const nativePaste: Paste = {
	available: true,
	allowed: () => invoke<boolean>('paste_allowed').catch(() => false),
	ask: () => invoke<void>('paste_ask').catch(() => {}),
	async press() {
		try {
			await invoke('paste');
			return Ok(undefined);
		} catch (cause) {
			return Err({ message: extractErrorMessage(cause) });
		}
	},
};
