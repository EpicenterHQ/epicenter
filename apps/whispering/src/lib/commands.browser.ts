import type { platformCommands as nativeCommands } from './commands.tauri.js';

/** Preserve stored command vocabulary; this build offers no native commands. */
export const platformCommands: readonly (typeof nativeCommands)[number][] = [];
