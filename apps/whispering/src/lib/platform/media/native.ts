/** Media pause in the desktop app: the system's own media controls, from Rust (`media.rs`). */
import { invoke } from '@tauri-apps/api/core';
import type { Media } from './media';

export const nativeMedia: Media = {
	pause: () => invoke<string[]>('pause_playback').catch(() => []),
	resume: (paused) =>
		invoke<void>('resume_playback', { sessions: paused }).catch(() => {}),
};
